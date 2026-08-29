// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration Drift Detector
 * Detects configuration drift by comparing current state against approved baselines
 */

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import { getEventProducer, EventType } from '@cmdb/event-processor';
import {
  BaselineSnapshot,
  DriftDetectionResult,
  DriftedField,
  AnomalySeverity,
} from '../types/anomaly.types';
import { v4 as uuidv4 } from 'uuid';

export class ConfigurationDriftDetector {
  private static instance: ConfigurationDriftDetector;
  private neo4jClient = getNeo4jClient();
  private postgresClient = getPostgresClient();
  private eventProducer = getEventProducer();

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
    createdBy: string = 'system'
  ): Promise<BaselineSnapshot> {
    logger.info('Creating baseline snapshot', { ci_id: ciId, snapshot_type: snapshotType });

    const session = this.neo4jClient.getSession();

    try {
      // Get current CI state
      const result = await session.run(
        `MATCH (ci:CI {id: $ciId})
         RETURN ci`,
        { ciId }
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
          snapshotData = await this.capturePerformanceSnapshot(ciId);
          break;
        case 'relationships':
          snapshotData = await this.captureRelationshipsSnapshot(ciId);
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

      // Store baseline
      await this.storeBaseline(baseline);

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
    const systemFields = ['id', 'created_at', 'updated_at', 'last_seen_at'];
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
  private async capturePerformanceSnapshot(ciId: string): Promise<Record<string, any>> {
    // Get recent performance metrics from time-series data
    const result = await this.postgresClient.query(
      `SELECT metric_name, AVG(value) as avg_value, MAX(value) as max_value
       FROM metrics_timeseries
       WHERE tags->>'ci_id' = $1
       AND timestamp >= NOW() - INTERVAL '24 hours'
       GROUP BY metric_name`,
      [ciId]
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
  private async captureRelationshipsSnapshot(ciId: string): Promise<Record<string, any>> {
    const session = this.neo4jClient.getSession();

    try {
      const result = await session.run(
        `MATCH (ci:CI {id: $ciId})-[r]-(related:CI)
         RETURN type(r) as rel_type,
                related.id as related_id,
                related.name as related_name,
                startNode(r).id = $ciId as is_outgoing
         ORDER BY rel_type, related_name`,
        { ciId }
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
  async detectDrift(ciId: string): Promise<DriftDetectionResult> {
    logger.info('Detecting configuration drift', { ci_id: ciId });

    // Get approved baseline
    const baseline = await this.getApprovedBaseline(ciId, 'configuration');

    if (!baseline) {
      throw new Error(`No approved baseline found for CI: ${ciId}`);
    }

    // Get current configuration
    const session = this.neo4jClient.getSession();

    try {
      const result = await session.run(
        `MATCH (ci:CI {id: $ciId})
         RETURN ci`,
        { ciId }
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

      // Store drift detection result
      await this.storeDriftResult(driftResult);

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
    snapshotType: 'configuration' | 'performance' | 'relationships'
  ): Promise<BaselineSnapshot | null> {
    const result = await this.postgresClient.query(
      `SELECT * FROM baseline_snapshots
       WHERE ci_id = $1
       AND snapshot_type = $2
       AND is_approved = true
       ORDER BY created_at DESC
       LIMIT 1`,
      [ciId, snapshotType]
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
    approvedBy: string
  ): Promise<BaselineSnapshot> {
    await this.postgresClient.query(
      `UPDATE baseline_snapshots
       SET is_approved = true,
           approved_by = $2,
           approved_at = NOW()
       WHERE id = $1`,
      [baselineId, approvedBy]
    );

    const result = await this.postgresClient.query(
      'SELECT * FROM baseline_snapshots WHERE id = $1',
      [baselineId]
    );

    return this.mapRowToBaseline(result.rows[0]);
  }

  /**
   * Get a baseline snapshot by ID
   */
  async getBaselineById(baselineId: string): Promise<BaselineSnapshot | null> {
    const result = await this.postgresClient.query(
      'SELECT * FROM baseline_snapshots WHERE id = $1',
      [baselineId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToBaseline(result.rows[0]);
  }

  /**
   * Store baseline snapshot
   */
  private async storeBaseline(baseline: BaselineSnapshot): Promise<void> {
    await this.postgresClient.query(
      `INSERT INTO baseline_snapshots
       (id, ci_id, snapshot_type, snapshot_data, created_at, created_by, is_approved)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        baseline.id,
        baseline.ci_id,
        baseline.snapshot_type,
        JSON.stringify(baseline.snapshot_data),
        baseline.created_at,
        baseline.created_by,
        baseline.is_approved,
      ]
    );
  }

  /**
   * Store drift detection result
   */
  private async storeDriftResult(result: DriftDetectionResult): Promise<void> {
    await this.postgresClient.query(
      `INSERT INTO drift_detection_results
       (ci_id, ci_name, has_drift, drift_score, drifted_fields,
        baseline_snapshot_id, detected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        result.ci_id,
        result.ci_name,
        result.has_drift,
        result.drift_score,
        JSON.stringify(result.drifted_fields),
        result.baseline_snapshot_id,
        result.detected_at,
      ]
    );
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
  async getDriftHistory(ciId: string, limit: number = 50): Promise<DriftDetectionResult[]> {
    const result = await this.postgresClient.query(
      `SELECT * FROM drift_detection_results
       WHERE ci_id = $1
       ORDER BY detected_at DESC
       LIMIT $2`,
      [ciId, limit]
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
