// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Metrics Aggregator
 * Aggregates real-time metrics from events for dashboards
 */

import { getPostgresClient, getRedisClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import { EventConsumer, createEventConsumer } from '../kafka/event-consumer';
import { getEventProducer } from '../kafka/event-producer';
import { KAFKA_TOPICS, CONSUMER_GROUPS } from '../kafka/topics';
import {
  CMDBEvent,
  EventType,
  ConnectorRunCompletedEvent,
  ConnectorRunFailedEvent,
  ReconciliationConflictEvent,
  CIDiscoveredEvent,
} from '../types/events';

export class MetricsAggregator {
  private consumer: EventConsumer;
  private producer = getEventProducer();
  private postgresClient = getPostgresClient();
  private redisClient = getRedisClient();
  private timers: ReturnType<typeof setInterval>[] = [];

  // Time windows for aggregation
  private readonly WINDOWS = {
    MINUTE: 60,
    HOUR: 3600,
    DAY: 86400,
  };

  constructor() {
    this.consumer = createEventConsumer(CONSUMER_GROUPS.METRICS_AGGREGATOR);
  }

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.producer.connect();

    // Subscribe to all metric-relevant topics
    await this.consumer.subscribe([
      KAFKA_TOPICS.CI_EVENTS,
      KAFKA_TOPICS.CONNECTOR_METRICS,
      KAFKA_TOPICS.RECONCILIATION_CONFLICTS,
    ]);

    // Register handlers
    this.consumer.on(EventType.CI_DISCOVERED, this.handleCIDiscovered.bind(this));
    this.consumer.on(EventType.CONNECTOR_RUN_COMPLETED, this.handleConnectorCompleted.bind(this));
    this.consumer.on(EventType.CONNECTOR_RUN_FAILED, this.handleConnectorFailed.bind(this));
    this.consumer.on(EventType.RECONCILIATION_CONFLICT, this.handleReconciliationConflict.bind(this));

    // Start consuming
    await this.consumer.run();

    // Start periodic aggregation tasks
    this.startPeriodicAggregation();

    logger.info('MetricsAggregator started');
  }

  async stop(): Promise<void> {
    this.clearPeriodicAggregation();
    await this.consumer.disconnect();
    await this.producer.disconnect();
    logger.info('MetricsAggregator stopped');
  }

  /**
   * Handle CI discovered event
   */
  private async handleCIDiscovered(event: CMDBEvent): Promise<void> {
    const ciEvent = event as CIDiscoveredEvent;

    try {
      // Increment discovery counter
      await this.incrementCounter('ci_discovered_total');
      await this.incrementCounter(`ci_discovered_by_source:${ciEvent.source_system}`);
      await this.incrementCounter(`ci_discovered_by_type:${ciEvent.ci_type}`);

      // Update time-series metrics
      await this.recordTimeSeries('ci_discoveries', 1, {
        source: ciEvent.source_system,
        ci_type: ciEvent.ci_type,
      });

      logger.debug('CI discovery metrics updated', {
        source: ciEvent.source_system,
        ci_type: ciEvent.ci_type,
      });
    } catch (error) {
      logger.error('Failed to update CI discovery metrics', { error });
    }
  }

  /**
   * Handle connector run completed event
   */
  private async handleConnectorCompleted(event: CMDBEvent): Promise<void> {
    const runEvent = event as ConnectorRunCompletedEvent;

    if (
      !this.isValidConnectorName(runEvent.connector_name) ||
      !Number.isFinite(runEvent.duration_ms) ||
      !Number.isFinite(runEvent.records_extracted)
    ) {
      logger.warn('Ignoring malformed connector completed event');
      return;
    }

    try {
      // Update connector metrics
      await this.incrementCounter('connector_runs_total');
      await this.incrementCounter(`connector_runs_success:${runEvent.connector_name}`);

      // Record duration
      await this.recordGauge(
        `connector_duration:${runEvent.connector_name}`,
        runEvent.duration_ms
      );

      // Record throughput
      await this.recordGauge(
        `connector_records_extracted:${runEvent.connector_name}`,
        runEvent.records_extracted
      );

      // Update success rate in Redis (sliding window)
      await this.updateSuccessRate(runEvent.connector_name, true);

      // Store in time-series
      await this.recordTimeSeries('connector_runs', 1, {
        connector: runEvent.connector_name,
        status: 'success',
        records_extracted: runEvent.records_extracted,
        duration_ms: runEvent.duration_ms,
      });

      logger.debug('Connector success metrics updated', {
        connector: runEvent.connector_name,
        duration_ms: runEvent.duration_ms,
      });
    } catch (error) {
      logger.error('Failed to update connector success metrics', { error });
    }
  }

  private isValidConnectorName(name: unknown): name is string {
    return typeof name === 'string' && name !== '';
  }

  /**
   * Handle connector run failed event
   */
  private async handleConnectorFailed(event: CMDBEvent): Promise<void> {
    const failEvent = event as ConnectorRunFailedEvent;

    if (!this.isValidConnectorName(failEvent.connector_name)) {
      logger.warn('Ignoring connector failed event without a valid connector_name');
      return;
    }

    try {
      // Update failure metrics
      await this.incrementCounter('connector_runs_total');
      await this.incrementCounter(`connector_runs_failed:${failEvent.connector_name}`);
      await this.incrementCounter('connector_failures_total');

      // Update success rate
      await this.updateSuccessRate(failEvent.connector_name, false);

      // Store in time-series
      await this.recordTimeSeries('connector_runs', 1, {
        connector: failEvent.connector_name,
        status: 'failed',
        error: failEvent.error_message,
      });

      logger.debug('Connector failure metrics updated', {
        connector: failEvent.connector_name,
      });
    } catch (error) {
      logger.error('Failed to update connector failure metrics', { error });
    }
  }

  /**
   * Handle reconciliation conflict event
   */
  private async handleReconciliationConflict(event: CMDBEvent): Promise<void> {
    const conflictEvent = event as ReconciliationConflictEvent;

    try {
      // Update conflict metrics
      await this.incrementCounter('reconciliation_conflicts_total');
      await this.incrementCounter(`reconciliation_conflicts_by_type:${conflictEvent.conflict_type}`);

      // Store in time-series
      await this.recordTimeSeries('reconciliation_conflicts', 1, {
        conflict_type: conflictEvent.conflict_type,
      });

      logger.debug('Reconciliation conflict metrics updated', {
        conflict_type: conflictEvent.conflict_type,
      });
    } catch (error) {
      logger.error('Failed to update reconciliation conflict metrics', { error });
    }
  }

  /**
   * Increment a counter in Redis
   */
  private async incrementCounter(key: string, increment: number = 1): Promise<void> {
    const client = this.redisClient.getConnection();
    await client.incrby(`metrics:counter:${key}`, increment);
  }

  /**
   * Record a gauge value in Redis
   */
  private async recordGauge(key: string, value: number): Promise<void> {
    await this.redisClient.set(`metrics:gauge:${key}`, value.toString());
  }

  /**
   * Record time-series data in PostgreSQL (TimescaleDB)
   */
  private async recordTimeSeries(
    metric_name: string,
    value: number,
    tags: Record<string, any>
  ): Promise<void> {
    await this.postgresClient.query(
      `INSERT INTO metrics_timeseries (metric_name, value, tags)
       VALUES ($1, $2, $3)`,
      [metric_name, value, JSON.stringify(tags)]
    );
  }

  /**
   * Update connector success rate (sliding window)
   */
  private async updateSuccessRate(connectorName: string, success: boolean): Promise<void> {
    const client = this.redisClient.getConnection();
    const key = `metrics:success_rate:${connectorName}`;
    const now = Date.now();

    // Add result to sorted set with timestamp as score
    await client.zadd(key, now, `${now}:${success ? '1' : '0'}`);

    // Remove entries older than 1 hour
    const oneHourAgo = now - this.WINDOWS.HOUR * 1000;
    await client.zremrangebyscore(key, '-inf', oneHourAgo.toString());

    // Set expiry on the key
    await client.expire(key, this.WINDOWS.DAY);
  }

  /**
   * Get connector success rate
   */
  async getSuccessRate(connectorName: string): Promise<number> {
    const client = this.redisClient.getConnection();
    const key = `metrics:success_rate:${connectorName}`;
    const results = await client.zrange(key, 0, -1);

    if (results.length === 0) return 0;

    const successCount = results.filter((r: string) => r.endsWith(':1')).length;
    return (successCount / results.length) * 100;
  }

  /**
   * Start periodic aggregation tasks
   */
  private startPeriodicAggregation(): void {
    // Idempotent: a second start() must not double the timers.
    this.clearPeriodicAggregation();

    // Aggregate every minute
    this.timers.push(setInterval(() => this.aggregateMetrics('minute'), 60 * 1000));

    // Aggregate every hour
    this.timers.push(setInterval(() => this.aggregateMetrics('hour'), 60 * 60 * 1000));

    // Aggregate daily
    this.timers.push(setInterval(() => this.aggregateMetrics('day'), 24 * 60 * 60 * 1000));
  }

  private clearPeriodicAggregation(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
  }

  /**
   * Aggregate metrics for a time window
   */
  private async aggregateMetrics(window: 'minute' | 'hour' | 'day'): Promise<void> {
    try {
      const now = new Date();
      const windowStart = this.getWindowStart(now, window);

      // Aggregate CI metrics
      const ciMetrics = await this.postgresClient.query(
        `SELECT
          metric_name,
          COUNT(*) as count,
          SUM(value) as total,
          AVG(value) as average,
          MIN(value) as min,
          MAX(value) as max,
          tags
         FROM metrics_timeseries
         WHERE timestamp >= $1 AND timestamp < $2
         GROUP BY metric_name, tags`,
        [windowStart, now]
      );

      // Store aggregated metrics
      for (const row of ciMetrics.rows) {
        await this.postgresClient.query(
          `INSERT INTO metrics_aggregated
           (window, window_start, metric_name, count, total, average, min, max, tags)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            window,
            windowStart,
            row.metric_name,
            row.count,
            row.total,
            row.average,
            row.min,
            row.max,
            row.tags,
          ]
        );
      }

      // The "aggregation done" notice is only logged. It must NOT be emitted as
      // CONNECTOR_RUN_COMPLETED: EventProducer routes connector.* to
      // CONNECTOR_METRICS, which this class consumes, so it would count itself
      // as a connector run.

      logger.info('Metrics aggregated', {
        window,
        window_start: windowStart,
        metrics_count: ciMetrics.rows.length,
      });
    } catch (error) {
      logger.error('Failed to aggregate metrics', { window, error });
    }
  }

  /**
   * Get start of time window
   */
  private getWindowStart(date: Date, window: 'minute' | 'hour' | 'day'): Date {
    const d = new Date(date);

    switch (window) {
      case 'minute':
        d.setSeconds(0, 0);
        break;
      case 'hour':
        d.setMinutes(0, 0, 0);
        break;
      case 'day':
        d.setHours(0, 0, 0, 0);
        break;
    }

    return d;
  }

  /**
   * Get dashboard metrics
   */
  async getDashboardMetrics(): Promise<any> {
    // Get counters from Redis
    const totalCIs = await this.redisClient.get('metrics:counter:ci_discovered_total');
    const totalRuns = await this.redisClient.get('metrics:counter:connector_runs_total');
    const totalConflicts = await this.redisClient.get('metrics:counter:reconciliation_conflicts_total');

    // Get recent aggregated metrics
    const recentMetrics = await this.postgresClient.query(
      `SELECT * FROM metrics_aggregated
       WHERE window = 'hour'
       ORDER BY window_start DESC
       LIMIT 24`
    );

    return {
      counters: {
        total_cis: parseInt(totalCIs || '0'),
        total_connector_runs: parseInt(totalRuns || '0'),
        total_conflicts: parseInt(totalConflicts || '0'),
      },
      recent_metrics: recentMetrics.rows,
    };
  }
}
