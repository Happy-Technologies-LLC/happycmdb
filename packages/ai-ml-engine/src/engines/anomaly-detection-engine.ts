// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Anomaly Detection Engine
 * ML-based pattern recognition for CI behavior anomalies
 */

import { getPostgresClient, getNeo4jClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import { getEventProducer, EventType } from '@cmdb/event-processor';
import * as stats from 'simple-statistics';
import {
  Anomaly,
  AnomalyType,
  AnomalySeverity,
  AnomalyStatus,
  AnomalyDetectionConfig,
} from '../types/anomaly.types';
import { v4 as uuidv4 } from 'uuid';

export class AnomalyDetectionEngine {
  private static instance: AnomalyDetectionEngine;
  private postgresClient = getPostgresClient();
  private neo4jClient = getNeo4jClient();
  private eventProducer = getEventProducer();
  private config: AnomalyDetectionConfig;

  private constructor() {
    this.config = this.getDefaultConfig();
  }

  static getInstance(): AnomalyDetectionEngine {
    if (!AnomalyDetectionEngine.instance) {
      AnomalyDetectionEngine.instance = new AnomalyDetectionEngine();
    }
    return AnomalyDetectionEngine.instance;
  }

  /**
   * Load configuration from database
   */
  async loadConfiguration(): Promise<void> {
    const result = await this.postgresClient.query(
      'SELECT config_value FROM system_config WHERE config_key = $1',
      ['anomaly_detection']
    );

    if (result.rows.length > 0) {
      this.config = result.rows[0].config_value;
    }

    logger.info('Anomaly detection configuration loaded', this.config);
  }

  /**
   * Run anomaly detection for all CIs
   */
  async detectAnomalies(): Promise<Anomaly[]> {
    if (!this.config.enabled) {
      logger.debug('Anomaly detection is disabled');
      return [];
    }

    const anomalies: Anomaly[] = [];

    logger.info('Starting anomaly detection scan');

    // Detect different types of anomalies
    const changeFrequencyAnomalies = await this.detectChangeFrequencyAnomalies();
    const relationshipAnomalies = await this.detectRelationshipAnomalies();
    const configurationAnomalies = await this.detectConfigurationAnomalies();

    anomalies.push(...changeFrequencyAnomalies);
    anomalies.push(...relationshipAnomalies);
    anomalies.push(...configurationAnomalies);

    // Store detected anomalies
    for (const anomaly of anomalies) {
      await this.storeAnomaly(anomaly);
    }

    logger.info('Anomaly detection completed', {
      total_anomalies: anomalies.length,
      by_severity: this.groupBySeverity(anomalies),
    });

    return anomalies;
  }

  /**
   * Detect change frequency anomalies using statistical analysis
   */
  private async detectChangeFrequencyAnomalies(): Promise<Anomaly[]> {
    const anomalies: Anomaly[] = [];
    const lookbackDays = this.config.lookback_days;

    // Get CIs with their change counts
    const result = await this.postgresClient.query(
      `SELECT
        cs.ci_id,
        COUNT(*) as change_count,
        COALESCE(MAX(dc.ci_name), cs.ci_id) as ci_name
       FROM ci_change_statistics cs
       JOIN ci_change_history ch ON cs.ci_id = ch.ci_id
       LEFT JOIN cmdb.dim_ci dc ON dc.ci_id = cs.ci_id AND dc.is_current = true
       WHERE ch.changed_at >= NOW() - ($1 * INTERVAL '1 day')
       GROUP BY cs.ci_id
       HAVING COUNT(*) > 0`,
      [lookbackDays]
    );

    if (result.rows.length < 3) {
      return anomalies; // Need minimum sample size
    }

    // Calculate statistical measures
    const changeCounts = result.rows.map((r: any) => parseInt(r.change_count));
    const mean = stats.mean(changeCounts);
    const stdDev = stats.standardDeviation(changeCounts);
    const threshold = mean + (this.getSensitivityMultiplier() * stdDev);

    // Identify anomalies (Z-score approach)
    for (const row of result.rows) {
      const changeCount = parseInt(row.change_count);
      const zScore = (changeCount - mean) / stdDev;

      if (changeCount > threshold && Math.abs(zScore) > 2) {
        const confidence = Math.min(Math.abs(zScore) * 30, 100);

        if (confidence >= this.config.min_confidence_score) {
          anomalies.push({
            id: uuidv4(),
            ci_id: row.ci_id,
            ci_name: row.ci_name,
            anomaly_type: AnomalyType.EXCESSIVE_CHANGES,
            severity: this.calculateSeverity(zScore),
            confidence_score: Math.round(confidence),
            detected_at: new Date(),
            description: `CI has ${changeCount} changes (${Math.round(zScore * 100)}% above normal)`,
            metrics: {
              actual_value: changeCount,
              expected_value: mean,
              deviation_percentage: ((changeCount - mean) / mean) * 100,
              historical_average: mean,
              standard_deviation: stdDev,
            },
            context: {
              lookback_days: lookbackDays,
              z_score: zScore,
            },
            status: AnomalyStatus.DETECTED,
          });
        }
      }
    }

    return anomalies;
  }

  /**
   * Detect relationship anomalies (orphaned CIs, unusual dependency counts)
   */
  private async detectRelationshipAnomalies(): Promise<Anomaly[]> {
    const anomalies: Anomaly[] = [];
    const session = this.neo4jClient.getSession();

    try {
      // Detect orphaned CIs (no incoming or outgoing relationships)
      const orphanedResult = await session.run(
        `MATCH (ci:CI)
         WHERE NOT (ci)-[]-()
         AND ci.created_at < datetime() - duration({days: 7})
         RETURN ci.id as ci_id, ci.name as ci_name, ci.ci_type as ci_type
         LIMIT 100`
      );

      for (const record of orphanedResult.records) {
        anomalies.push({
          id: uuidv4(),
          ci_id: record.get('ci_id'),
          ci_name: record.get('ci_name'),
          anomaly_type: AnomalyType.ORPHANED_CI,
          severity: AnomalySeverity.MEDIUM,
          confidence_score: 95,
          detected_at: new Date(),
          description: `CI has no relationships (potentially stale or misconfigured)`,
          metrics: {},
          context: {
            ci_type: record.get('ci_type'),
          },
          status: AnomalyStatus.DETECTED,
        });
      }

      // Detect unusual dependency counts
      const dependencyResult = await session.run(
        `MATCH (ci:CI)
         OPTIONAL MATCH (ci)-[r]->()
         WITH ci, COUNT(r) as dep_count
         WHERE dep_count > 50
         RETURN ci.id as ci_id, ci.name as ci_name, dep_count
         LIMIT 50`
      );

      for (const record of dependencyResult.records) {
        const depCount = record.get('dep_count').toNumber();

        anomalies.push({
          id: uuidv4(),
          ci_id: record.get('ci_id'),
          ci_name: record.get('ci_name'),
          anomaly_type: AnomalyType.UNUSUAL_DEPENDENCY_COUNT,
          severity: AnomalySeverity.LOW,
          confidence_score: 70,
          detected_at: new Date(),
          description: `CI has unusually high dependency count (${depCount})`,
          metrics: {
            actual_value: depCount,
            threshold_exceeded: 50,
          },
          context: {
            dependency_count: depCount,
          },
          status: AnomalyStatus.DETECTED,
        });
      }

      // Detect circular dependencies
      const circularResult = await session.run(
        `MATCH path = (ci:CI)-[*2..5]->(ci)
         WHERE ALL(r IN relationships(path) WHERE type(r) = 'DEPENDS_ON')
         RETURN ci.id as ci_id, ci.name as ci_name, length(path) as cycle_length
         LIMIT 20`
      );

      for (const record of circularResult.records) {
        anomalies.push({
          id: uuidv4(),
          ci_id: record.get('ci_id'),
          ci_name: record.get('ci_name'),
          anomaly_type: AnomalyType.CIRCULAR_DEPENDENCY,
          severity: AnomalySeverity.HIGH,
          confidence_score: 100,
          detected_at: new Date(),
          description: `Circular dependency detected (cycle length: ${record.get('cycle_length').toNumber()})`,
          metrics: {
            actual_value: record.get('cycle_length').toNumber(),
          },
          context: {},
          status: AnomalyStatus.DETECTED,
        });
      }
    } finally {
      await session.close();
    }

    return anomalies;
  }

  /**
   * Detect configuration anomalies
   */
  private async detectConfigurationAnomalies(): Promise<Anomaly[]> {
    const anomalies: Anomaly[] = [];

    // Detect missing required attributes
    const session = this.neo4jClient.getSession();

    try {
      const result = await session.run(
        `MATCH (ci:CI)
         WHERE ci.ci_type IN ['server', 'virtual-machine']
         AND (ci.ip_address IS NULL OR ci.hostname IS NULL)
         RETURN ci.id as ci_id, ci.name as ci_name, ci.ci_type as ci_type
         LIMIT 100`
      );

      for (const record of result.records) {
        anomalies.push({
          id: uuidv4(),
          ci_id: record.get('ci_id'),
          ci_name: record.get('ci_name'),
          anomaly_type: AnomalyType.MISSING_REQUIRED_ATTRIBUTE,
          severity: AnomalySeverity.MEDIUM,
          confidence_score: 100,
          detected_at: new Date(),
          description: `Missing required attributes (ip_address or hostname)`,
          metrics: {},
          context: {
            ci_type: record.get('ci_type'),
          },
          status: AnomalyStatus.DETECTED,
        });
      }
    } finally {
      await session.close();
    }

    return anomalies;
  }

  /**
   * Store anomaly in database
   */
  private async storeAnomaly(anomaly: Anomaly): Promise<void> {
    await this.postgresClient.query(
      `INSERT INTO anomalies
       (id, ci_id, ci_name, anomaly_type, severity, confidence_score,
        detected_at, description, metrics, context, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING`,
      [
        anomaly.id,
        anomaly.ci_id,
        anomaly.ci_name,
        anomaly.anomaly_type,
        anomaly.severity,
        anomaly.confidence_score,
        anomaly.detected_at,
        anomaly.description,
        JSON.stringify(anomaly.metrics),
        JSON.stringify(anomaly.context),
        anomaly.status,
      ]
    );

    // Emit event for high-severity anomalies
    if (
      anomaly.severity === AnomalySeverity.CRITICAL ||
      anomaly.severity === AnomalySeverity.HIGH
    ) {
      await this.eventProducer.emit(
        EventType.RECONCILIATION_CONFLICT as any, // Reusing existing event type
        'anomaly-detection-engine',
        {
          conflict_id: anomaly.id,
          conflict_type: 'anomaly_detected',
          source_data: [
            {
              anomaly_type: anomaly.anomaly_type,
              severity: anomaly.severity,
              confidence: anomaly.confidence_score,
            },
          ],
        } as any
      );
    }
  }

  /**
   * Get sensitivity multiplier based on configuration
   */
  private getSensitivityMultiplier(): number {
    switch (this.config.sensitivity) {
      case 'high':
        return 1.5; // Detect more anomalies
      case 'medium':
        return 2.0;
      case 'low':
        return 2.5; // Detect fewer anomalies
      default:
        return 2.0;
    }
  }

  /**
   * Calculate severity based on Z-score
   */
  private calculateSeverity(zScore: number): AnomalySeverity {
    const absZScore = Math.abs(zScore);

    if (absZScore > 4) return AnomalySeverity.CRITICAL;
    if (absZScore > 3) return AnomalySeverity.HIGH;
    if (absZScore > 2) return AnomalySeverity.MEDIUM;
    return AnomalySeverity.LOW;
  }

  /**
   * Group anomalies by severity
   */
  private groupBySeverity(anomalies: Anomaly[]): Record<string, number> {
    const grouped: Record<string, number> = {};

    for (const anomaly of anomalies) {
      grouped[anomaly.severity] = (grouped[anomaly.severity] || 0) + 1;
    }

    return grouped;
  }

  /**
   * Get default configuration
   */
  private getDefaultConfig(): AnomalyDetectionConfig {
    return {
      enabled: true,
      sensitivity: 'medium',
      min_confidence_score: 70,
      check_interval_minutes: 60,
      lookback_days: 30,
      notification_enabled: true,
    };
  }

  /**
   * Get anomalies for a specific CI
   */
  async getAnomaliesForCI(ciId: string, limit: number = 50): Promise<Anomaly[]> {
    const result = await this.postgresClient.query(
      `SELECT * FROM anomalies
       WHERE ci_id = $1
       ORDER BY detected_at DESC
       LIMIT $2`,
      [ciId, limit]
    );

    return result.rows.map(this.mapRowToAnomaly);
  }

  /**
   * Get recent anomalies
   */
  async getRecentAnomalies(hours: number = 24, limit: number = 100): Promise<Anomaly[]> {
    const result = await this.postgresClient.query(
      `SELECT * FROM anomalies
       WHERE detected_at >= NOW() - INTERVAL '${hours} hours'
       AND status IN ('detected', 'investigating')
       ORDER BY detected_at DESC
       LIMIT $1`,
      [limit]
    );

    return result.rows.map(this.mapRowToAnomaly);
  }

  /**
   * Map database row to Anomaly object
   */
  private mapRowToAnomaly(row: any): Anomaly {
    return {
      id: row.id,
      ci_id: row.ci_id,
      ci_name: row.ci_name,
      anomaly_type: row.anomaly_type,
      severity: row.severity,
      confidence_score: row.confidence_score,
      detected_at: row.detected_at,
      description: row.description,
      metrics: row.metrics,
      context: row.context,
      status: row.status,
      resolved_at: row.resolved_at,
      resolved_by: row.resolved_by,
    };
  }
}

export function getAnomalyDetectionEngine(): AnomalyDetectionEngine {
  return AnomalyDetectionEngine.getInstance();
}
