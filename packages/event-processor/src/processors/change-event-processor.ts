// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Change Event Processor
 * Tracks CI changes and maintains change history
 */

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { logger, ciIncarnationId } from '@cmdb/common';
import { EventConsumer, createEventConsumer } from '../kafka/event-consumer';
import { KAFKA_TOPICS, CONSUMER_GROUPS } from '../kafka/topics';
import {
  CMDBEvent,
  EventType,
  CIDiscoveredEvent,
  CIUpdatedEvent,
} from '../types/events';

export class ChangeEventProcessor {
  private consumer: EventConsumer;
  private postgresClient = getPostgresClient();
  private neo4jClient = getNeo4jClient();

  constructor() {
    this.consumer = createEventConsumer(CONSUMER_GROUPS.CHANGE_PROCESSOR);
  }

  // An event's organization_id is only a claim. Prove current ownership and
  // stamp the graph incarnation before persisting any derived history.
  private async provenIncarnation(event: CIDiscoveredEvent | CIUpdatedEvent): Promise<string | null> {
    const sourceIncarnation = ciIncarnationId(event.ci_incarnation_id);
    if (typeof event.organization_id !== 'string' || !event.organization_id || !sourceIncarnation) return null;
    const currentIncarnation = await this.neo4jClient.ensureCIIncarnation(event.ci_id, event.organization_id);
    return sourceIncarnation === currentIncarnation ? currentIncarnation : null;
  }

  async start(): Promise<void> {
    await this.consumer.connect();

    // Subscribe to CI change topics
    await this.consumer.subscribe([KAFKA_TOPICS.CI_EVENTS, KAFKA_TOPICS.CI_CHANGES]);

    // Register event handlers
    this.consumer.on(EventType.CI_DISCOVERED, this.handleCIDiscovered.bind(this));
    this.consumer.on(EventType.CI_UPDATED, this.handleCIUpdated.bind(this));

    // Start consuming
    await this.consumer.run();

    logger.info('ChangeEventProcessor started');
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
    logger.info('ChangeEventProcessor stopped');
  }

  /**
   * Handle CI discovered event. HP1 v16 §3.5: Kafka is notification-only;
   * change history is written by the journaled writer's T2, never here.
   */
  private async handleCIDiscovered(event: CMDBEvent): Promise<void> {
    const ciEvent = event as CIDiscoveredEvent;
    if (!(await this.provenIncarnation(ciEvent))) return;
    await this.updateCIStatistics(ciEvent.ci_id, 'discovered');
    logger.info('CI discovery tracked', { ci_id: ciEvent.ci_id, source: ciEvent.source_system });
  }

  /** Handle CI updated event (notification-only; see handleCIDiscovered). */
  private async handleCIUpdated(event: CMDBEvent): Promise<void> {
    const updateEvent = event as CIUpdatedEvent;
    if (!(await this.provenIncarnation(updateEvent))) return;
    await this.updateCIStatistics(updateEvent.ci_id, 'updated');
    await this.checkForSignificantChanges(updateEvent);
    logger.info('CI update tracked', {
      ci_id: updateEvent.ci_id,
      changed_fields: updateEvent.changed_fields,
      source: updateEvent.source_system,
    });
  }


  /**
   * Update CI change statistics
   */
  private async updateCIStatistics(ciId: string, changeType: string): Promise<void> {
    await this.postgresClient.query(
      `INSERT INTO ci_change_statistics
       (ci_id, last_change_type, last_change_at, total_changes)
       VALUES ($1, $2, NOW(), 1)
       ON CONFLICT (ci_id) DO UPDATE SET
         last_change_type = $2,
         last_change_at = NOW(),
         total_changes = ci_change_statistics.total_changes + 1`,
      [ciId, changeType]
    );
  }

  /**
   * Check for significant changes that might require alerts
   */
  private async checkForSignificantChanges(event: CIUpdatedEvent): Promise<void> {
    const significantFields = ['status', 'environment', 'ip_address', 'hostname'];

    const hasSignificantChange = event.changed_fields.some(field =>
      significantFields.includes(field)
    );

    if (hasSignificantChange) {
      // Record alert (could trigger notification in the future)
      await this.postgresClient.query(
        `INSERT INTO ci_change_alerts
         (ci_id, ci_name, alert_type, changed_fields, previous_values, new_values, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          event.ci_id,
          event.ci_name,
          'significant_change',
          event.changed_fields.filter(f => significantFields.includes(f)),
          JSON.stringify(event.previous_values),
          JSON.stringify(event.new_values),
          event.source_system,
        ]
      );

      logger.warn('Significant CI change detected', {
        ci_id: event.ci_id,
        ci_name: event.ci_name,
        changed_fields: event.changed_fields,
      });
    }
  }

  /**
   * Get change history for a CI
   */
  async getChangeHistory(
    ciId: string,
    organizationId: string,
    limit: number = 100,
    offset: number = 0
  ): Promise<any[]> {
    const ci = await this.neo4jClient.getCI(ciId, organizationId);
    const incarnationId = ciIncarnationId(ci);
    if (!incarnationId) return [];
    const result = await this.postgresClient.query(
      `SELECT * FROM ci_change_history
       WHERE ci_id = $1 AND organization_id = $4
         AND ci_incarnation_id = $5
       ORDER BY changed_at DESC
       LIMIT $2 OFFSET $3`,
      [ciId, limit, offset, organizationId, incarnationId]
    );

    return result.rows;
  }

  /**
   * Get change statistics for a CI
   */
  async getChangeStatistics(ciId: string): Promise<any> {
    const result = await this.postgresClient.query(
      `SELECT * FROM ci_change_statistics WHERE ci_id = $1`,
      [ciId]
    );

    return result.rows[0] || null;
  }

  /**
   * Get recent alerts for a CI
   */
  async getChangeAlerts(ciId: string, limit: number = 50): Promise<any[]> {
    const result = await this.postgresClient.query(
      `SELECT * FROM ci_change_alerts
       WHERE ci_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [ciId, limit]
    );

    return result.rows;
  }
}
