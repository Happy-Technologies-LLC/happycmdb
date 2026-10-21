// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration Drift Detector
 * Detects configuration drift by comparing current state against approved baselines
 */

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { logger, ciIncarnationId } from '@cmdb/common';
import { getEventProducer, EventType } from '@cmdb/event-processor';
import {
  BaselineSnapshot,
  DriftDetectionResult,
  DriftedField,
  AnomalySeverity,
} from '../types/anomaly.types';
import { v4 as uuidv4 } from 'uuid';
import type { ReferencedWrite } from './impact-prediction-engine';

export class ConfigurationDriftDetector {
  private static instance: ConfigurationDriftDetector;
  private neo4jClient = getNeo4jClient();
  private postgresClient = getPostgresClient();
  private eventProducer = getEventProducer();
  /** Plain engine calls (the Kafka consumer) keep auto-commit SQL; REST routes pass AP-P′. */
  private direct: ReferencedWrite = (_ciIds, write) => write(this.postgresClient);

  private constructor() {}

  static getInstance(): ConfigurationDriftDetector {
    if (!ConfigurationDriftDetector.instance) {
      ConfigurationDriftDetector.instance = new ConfigurationDriftDetector();
    }
    return ConfigurationDriftDetector.instance;
  }

  /**
   * Create baseline snapshot for a CI
   */
  async createBaseline(
    ciId: string,
    snapshotType: 'configuration' | 'performance' | 'relationships',
    createdBy: string,
    organizationId: string,
    admit?: ReferencedWrite
  ): Promise<BaselineSnapshot> {
    logger.info('Creating baseline snapshot', { ci_id: ciId, snapshot_type: snapshotType });

    const session = this.neo4jClient.getSession();

    try {
      // Get current CI state
      const result = await session.run(
        `MATCH (ci:CI {id: $ciId})
         WHERE ci.organization_id = $organizationId
         RETURN ci`,
        { ciId, organizationId }
      );

      if (result.records.length === 0) {
        throw new Error(`CI not found: ${ciId}`);
      }

      const ciNode = result.records[0]?.get('ci');
      if (!ciNode) {
        throw new Error(`Failed to get CI node for: ${ciId}`);
      }
      const ciData = ciNode.properties;

      let snapshotData: Record<string, any>;

      switch (snapshotType) {
        case 'configuration':
          snapshotData = await this.captureConfigurationSnapshot(ciId, ciData);
          break;
        case 'performance':
          snapshotData = await this.capturePerformanceSnapshot(ciId, organizationId);
          break;
        case 'relationships':
          snapshotData = await this.captureRelationshipsSnapshot(ciId, organizationId);
          break;
        default:
          throw new Error(`Unknown snapshot type: ${snapshotType}`);
      }

      const baseline: BaselineSnapshot = {
        id: uuidv4(),
        ci_id: ciId,
        snapshot_type: snapshotType,
        snapshot_data: snapshotData,
        created_at: new Date(),
        created_by: createdBy,
        is_approved: false,
      };

      // Store baseline; a relationships snapshot also reads each related CI (v16 §6.5 neighbours).
      const related: { ci_id: string }[] = snapshotType === 'relationships'
        ? [...snapshotData['outgoing'], ...snapshotData['incoming']] : [];
      await this.storeBaseline(baseline, organizationId, [ciId, ...related.map(rel => rel.ci_id)], admit);

      logger.info('Baseline snapshot created', {
        baseline_id: baseline.id,
        ci_id: ciId,
        snapshot_type: snapshotType,
      });

      return baseline;
    } finally {
      await session.close();
    }
  }

  /**
   * Capture configuration snapshot (all CI properties)
   */
  private async captureConfigurationSnapshot(
    _ciId: string,
    ciData: Record<string, any>
  ): Promise<Record<string, any>> {
    // Filter out system fields
    const systemFields = ['id', 'created_at', 'updated_at', 'last_seen_at', 'incarnation_id'];
    const config: Record<string, any> = {};

    for (const [key, value] of Object.entries(ciData)) {
      if (!systemFields.includes(key)) {
        config[key] = value;
      }
    }

    return config;
  }

  /**
   * Capture performance snapshot
   */
  private async capturePerformanceSnapshot(ciId: string, organizationId: string): Promise<Record<string, any>> {
    // Get recent performance metrics from time-series data
    const result = await this.postgresClient.query(
      `SELECT metric_name, AVG(value) as avg_value, MAX(value) as max_value
       FROM metrics_timeseries
       WHERE tags->>'ci_id' = $1
       AND tags->>'organization_id' = $2
       AND timestamp >= NOW() - INTERVAL '24 hours'
       GROUP BY metric_name`,
      [ciId, organizationId]
    );

    const metrics: Record<string, any> = {};

    for (const row of result.rows) {
      metrics[row.metric_name] = {
        average: parseFloat(row.avg_value),
        max: parseFloat(row.max_value),
      };
    }

    return metrics;
  }

  /**
   * Capture relationships snapshot
   */
  private async captureRelationshipsSnapshot(ciId: string, organizationId: string): Promise<Record<string, any>> {
    const session = this.neo4jClient.getSession();

    try {
      const result = await session.run(
        `MATCH (ci:CI {id: $ciId})-[r]-(related:CI)
         WHERE ci.organization_id = $organizationId AND related.organization_id = $organizationId
         RETURN type(r) as rel_type,
                related.id as related_id,
                related.name as related_name,
                startNode(r).id = $ciId as is_outgoing
         ORDER BY rel_type, related_name`,
        { ciId, organizationId }
      );

      const relationships: Record<string, any[]> = {
        outgoing: [],
        incoming: [],
      };

      for (const record of result.records) {
        const relData = {
          type: record.get('rel_type'),
          ci_id: record.get('related_id'),
          ci_name: record.get('related_name'),
        };

        if (record.get('is_outgoing')) {
          const outgoing = relationships['outgoing'];
          if (outgoing) outgoing.push(relData);
        } else {
          const incoming = relationships['incoming'];
          if (incoming) incoming.push(relData);
        }
      }

      return relationships;
    } finally {
      await session.close();
    }
  }

  /**
   * Detect configuration drift for a CI
   */
  async detectDrift(ciId: string, organizationId: string, admit?: ReferencedWrite): Promise<DriftDetectionResult> {
    logger.info('Detecting configuration drift', { ci_id: ciId });

    // Get approved baseline
    const baseline = await this.getApprovedBaseline(ciId, 'configuration', organizationId);

    if (!baseline) {
      throw new Error(`No approved baseline found for CI: ${ciId}`);
    }

    // Get current configuration
    const session = this.neo4jClient.getSession();

    try {
      const result = await session.run(
        `MATCH (ci:CI {id: $ciId})
         WHERE ci.organization_id = $organizationId
         RETURN ci`,
        { ciId, organizationId }
      );

      if (result.records.length === 0) {
        throw new Error(`CI not found: ${ciId}`);
      }

      const currentData = result.records[0]?.get('ci')?.properties;
      if (!currentData) {
        throw new Error(`Failed to get CI data for: ${ciId}`);
      }
      const currentConfig = await this.captureConfigurationSnapshot(ciId, currentData);

      // Compare configurations
      const driftedFields = this.compareConfigurations(
        baseline.snapshot_data,
        currentConfig
      );

      const driftScore = this.calculateDriftScore(driftedFields);
      const hasDrift = driftedFields.length > 0;

      const driftResult: DriftDetectionResult = {
        ci_id: ciId,
        ci_name: currentData.name || ciId,
        has_drift: hasDrift,
        drift_score: driftScore,
        drifted_fields: driftedFields,
        baseline_snapshot_id: baseline.id,
        detected_at: new Date(),
      };

      // Store drift detection result; the event below follows only a committed row
      await this.storeDriftResult(driftResult, organizationId, admit);

      // Emit event for significant drift
      if (hasDrift && driftScore > 30) {
        await this.eventProducer.emit(
          EventType.RECONCILIATION_CONFLICT as any,
          'configuration-drift-detector',
          {
            conflict_id: uuidv4(),
            conflict_type: 'configuration_drift',
            source_data: [
              {
                ci_id: ciId,
                drift_score: driftScore,
                drifted_fields: driftedFields.length,
              },
            ],
          } as any
        );
      }

      logger.info('Drift detection completed', {
        ci_id: ciId,
        has_drift: hasDrift,
        drift_score: driftScore,
        drifted_fields_count: driftedFields.length,
      });

      return driftResult;
    } finally {
      await session.close();
    }
  }

  /**
   * Compare two configurations and find drifted fields
   */
  private compareConfigurations(
    baseline: Record<string, any>,
    current: Record<string, any>
  ): DriftedField[] {
    const driftedFields: DriftedField[] = [];
    const allKeys = new Set([...Object.keys(baseline), ...Object.keys(current)]);

    for (const key of allKeys) {
      const baselineValue = baseline[key];
      const currentValue = current[key];

      if (baselineValue === undefined && currentValue !== undefined) {
        // Field added
        driftedFields.push({
          field_name: key,
          baseline_value: null,
          current_value: currentValue,
          change_type: 'added',
          severity: this.determineDriftSeverity(key, 'added'),
        });
      } else if (baselineValue !== undefined && currentValue === undefined) {
        // Field removed
        driftedFields.push({
          field_name: key,
          baseline_value: baselineValue,
          current_value: null,
          change_type: 'removed',
          severity: this.determineDriftSeverity(key, 'removed'),
        });
      } else if (!this.valuesEqual(baselineValue, currentValue)) {
        // Field modified
        driftedFields.push({
          field_name: key,
          baseline_value: baselineValue,
          current_value: currentValue,
          change_type: 'modified',
          severity: this.determineDriftSeverity(key, 'modified'),
        });
      }
    }

    return driftedFields;
  }

  /**
   * Check if two values are equal (handles arrays and objects)
   */
  private valuesEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (typeof a !== typeof b) return false;

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((val, index) => this.valuesEqual(val, b[index]));
    }

    if (typeof a === 'object' && typeof b === 'object') {
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) return false;
      return keysA.every(key => this.valuesEqual(a[key], b[key]));
    }

    return false;
  }

  /**
   * Determine drift severity based on field name and change type
   */
  private determineDriftSeverity(
    fieldName: string,
    changeType: 'added' | 'removed' | 'modified'
  ): AnomalySeverity {
    // Critical fields
    const criticalFields = ['ip_address', 'hostname', 'status', 'environment'];
    if (criticalFields.includes(fieldName)) {
      return changeType === 'removed' ? AnomalySeverity.CRITICAL : AnomalySeverity.HIGH;
    }

    // High priority fields
    const highPriorityFields = ['version', 'port', 'credentials', 'access_key'];
    if (highPriorityFields.some(f => fieldName.includes(f))) {
      return AnomalySeverity.HIGH;
    }

    // Medium priority fields
    const mediumPriorityFields = ['config', 'setting', 'parameter'];
    if (mediumPriorityFields.some(f => fieldName.includes(f))) {
      return AnomalySeverity.MEDIUM;
    }

    return AnomalySeverity.LOW;
  }

  /**
   * Calculate overall drift score (0-100)
   */
  private calculateDriftScore(driftedFields: DriftedField[]): number {
    if (driftedFields.length === 0) return 0;

    const severityWeights = {
      [AnomalySeverity.CRITICAL]: 40,
      [AnomalySeverity.HIGH]: 25,
      [AnomalySeverity.MEDIUM]: 15,
      [AnomalySeverity.LOW]: 10,
      [AnomalySeverity.INFO]: 5,
    };

    let totalWeight = 0;
    for (const field of driftedFields) {
      totalWeight += severityWeights[field.severity];
    }

    return Math.min(totalWeight, 100);
  }

  /**
   * Get approved baseline for a CI
   */
  async getApprovedBaseline(
    ciId: string,
    snapshotType: 'configuration' | 'performance' | 'relationships',
    organizationId: string
  ): Promise<BaselineSnapshot | null> {
    const incarnationId = ciIncarnationId(await this.neo4jClient.getCI(ciId, organizationId));
    if (!incarnationId) return null;
    const result = await this.postgresClient.query(
      `SELECT b.* FROM baseline_snapshots b
       WHERE b.ci_id = $1 AND b.snapshot_type = $2 AND b.is_approved = true
         AND b.ci_incarnation_id = $3 AND b.organization_id = $4
       ORDER BY b.created_at DESC LIMIT 1`,
      [ciId, snapshotType, incarnationId, organizationId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToBaseline(result.rows[0]);
  }

  /**
   * Approve a baseline
   */
  async approveBaseline(
    baselineId: string,
    approvedBy: string,
    organizationId: string
  ): Promise<BaselineSnapshot> {
    const existing = await this.getBaselineById(baselineId, organizationId);
    if (!existing) throw new Error('Baseline snapshot not found');
    const incarnationId = ciIncarnationId(await this.neo4jClient.getCI(existing.ci_id, organizationId));
    if (!incarnationId) throw new Error('Baseline snapshot not found');
    const result = await this.postgresClient.query(
      `UPDATE baseline_snapshots b
       SET is_approved = true, approved_by = $2, approved_at = NOW()
       WHERE b.id = $1 AND b.ci_id = $3 AND b.ci_incarnation_id = $4 AND b.organization_id = $5 RETURNING b.*`,
      [baselineId, approvedBy, existing.ci_id, incarnationId, organizationId]
    );

    if (result.rows.length === 0) throw new Error('Baseline snapshot not found');
    return this.mapRowToBaseline(result.rows[0]);
  }

  /**
   * Get a baseline snapshot by ID
   */
  async getBaselineById(baselineId: string, organizationId: string): Promise<BaselineSnapshot | null> {
    // The baseline ID is not an ownership credential: resolve it only when it
    // was written by this tenant and its linked CI is visible to this tenant.
    const result = await this.postgresClient.query(
      'SELECT b.* FROM baseline_snapshots b WHERE b.id = $1 AND b.organization_id = $2',
      [baselineId, organizationId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const incarnationId = ciIncarnationId(await this.neo4jClient.getCI(result.rows[0].ci_id, organizationId));
    if (!incarnationId || result.rows[0].ci_incarnation_id !== incarnationId) return null;
    return this.mapRowToBaseline(result.rows[0]);
  }

  /**
   * Store baseline snapshot
   */
  private async storeBaseline(
    baseline: BaselineSnapshot, organizationId: string, ciIds: string[], admit?: ReferencedWrite
  ): Promise<void> {
    // Atomically mint a marker for a legacy owned graph node before SQL writes (never inside the transaction).
    const incarnationId = await this.neo4jClient.ensureCIIncarnation(baseline.ci_id, organizationId);
    if (!incarnationId) throw new Error('CI not found');
    const inserted = await (admit ?? this.direct)(ciIds, client => client.query(
      `INSERT INTO baseline_snapshots
       (id, ci_id, snapshot_type, snapshot_data, created_at, created_by, is_approved, ci_incarnation_id, organization_id)
       VALUES ($1::uuid, $2::varchar, $3::varchar, $4::jsonb, $5::timestamptz, $6::varchar, $7::boolean, $8::uuid, $9::uuid)
       RETURNING id`,
      [
        baseline.id,
        baseline.ci_id,
        baseline.snapshot_type,
        JSON.stringify(baseline.snapshot_data),
        baseline.created_at,
        baseline.created_by,
        baseline.is_approved,
        incarnationId,
        organizationId,
      ]
    ));
    if (inserted.rows.length === 0) throw new Error('CI not found');
  }

  /**
   * Store drift detection result
   */
  private async storeDriftResult(result: DriftDetectionResult, organizationId: string, admit?: ReferencedWrite): Promise<void> {
    const incarnationId = await this.neo4jClient.ensureCIIncarnation(result.ci_id, organizationId);
    if (!incarnationId) throw new Error('CI not found');
    const inserted = await (admit ?? this.direct)([result.ci_id], client => client.query(
      `INSERT INTO drift_detection_results
       (ci_id, ci_name, has_drift, drift_score, drifted_fields,
        baseline_snapshot_id, detected_at, ci_incarnation_id, organization_id)
       VALUES ($1::varchar, $2::varchar, $3::boolean, $4::integer, $5::jsonb, $6::uuid, $7::timestamptz, $8::uuid, $9::uuid)
       RETURNING id`,
      [
        result.ci_id,
        result.ci_name,
        result.has_drift,
        result.drift_score,
        JSON.stringify(result.drifted_fields),
        result.baseline_snapshot_id,
        result.detected_at,
        incarnationId,
        organizationId,
      ]
    ));
    if (inserted.rows.length === 0) throw new Error('CI not found');
  }

  /**
   * Map database row to baseline snapshot
   */
  private mapRowToBaseline(row: any): BaselineSnapshot {
    return {
      id: row.id,
      ci_id: row.ci_id,
      snapshot_type: row.snapshot_type,
      snapshot_data: row.snapshot_data,
      created_at: row.created_at,
      created_by: row.created_by,
      is_approved: row.is_approved,
      approved_by: row.approved_by,
      approved_at: row.approved_at,
    };
  }

  /**
   * Get drift history for a CI
   */
  async getDriftHistory(ciId: string, limit: number, organizationId: string): Promise<DriftDetectionResult[]> {
    const incarnationId = ciIncarnationId(await this.neo4jClient.getCI(ciId, organizationId));
    if (!incarnationId) return [];
    const result = await this.postgresClient.query(
      `SELECT d.* FROM drift_detection_results d
       WHERE d.ci_id = $1 AND d.ci_incarnation_id = $3 AND d.organization_id = $4
       ORDER BY d.detected_at DESC LIMIT $2`,
      [ciId, limit, incarnationId, organizationId]
    );

    return result.rows.map((row: any) => ({
      ci_id: row.ci_id,
      ci_name: row.ci_name,
      has_drift: row.has_drift,
      drift_score: row.drift_score,
      drifted_fields: row.drifted_fields,
      baseline_snapshot_id: row.baseline_snapshot_id,
      detected_at: row.detected_at,
    }));
  }
}

export function getConfigurationDriftDetector(): ConfigurationDriftDetector {
  return ConfigurationDriftDetector.getInstance();
}
