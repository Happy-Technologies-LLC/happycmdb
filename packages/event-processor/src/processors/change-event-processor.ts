// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Change Event Processor
 * Tracks CI changes and maintains change history
 */

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import { EventConsumer, createEventConsumer } from '../kafka/event-consumer';
import { KAFKA_TOPICS, CONSUMER_GROUPS } from '../kafka/topics';
import {
  CMDBEvent,
  EventType,
  CIDiscoveredEvent,
  CIUpdatedEvent,
  CIDeletedEvent,
} from '../types/events';

export class ChangeEventProcessor {
  private consumer: EventConsumer;
  private postgresClient = getPostgresClient();
  private neo4jClient = getNeo4jClient();

  constructor() {
    this.consumer = createEventConsumer(CONSUMER_GROUPS.CHANGE_PROCESSOR);
  }

  // Reconciliation supplies organization_id from its authorized graph write.
  // A legacy or mismatched event cannot establish provenance for history.
  private async hasProvenOwner(event: CIDiscoveredEvent | CIUpdatedEvent): Promise<boolean> {
    return typeof event.organization_id === 'string' && event.organization_id.length > 0
      && Boolean(await this.neo4jClient.getCI(event.ci_id, event.organization_id));
  }

  async start(): Promise<void> {
    await this.consumer.connect();

    // Subscribe to CI change topics
    await this.consumer.subscribe([KAFKA_TOPICS.CI_EVENTS, KAFKA_TOPICS.CI_CHANGES]);

    // Register event handlers
    this.consumer.on(EventType.CI_DISCOVERED, this.handleCIDiscovered.bind(this));
    this.consumer.on(EventType.CI_UPDATED, this.handleCIUpdated.bind(this));
    this.consumer.on(EventType.CI_DELETED, this.handleCIDeleted.bind(this));

    // Start consuming
    await this.consumer.run();

    logger.info('ChangeEventProcessor started');
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
    logger.info('ChangeEventProcessor stopped');
  }

  /**
   * Handle CI discovered event
   */
  private async handleCIDiscovered(event: CMDBEvent): Promise<void> {
    const ciEvent = event as CIDiscoveredEvent;
    if (!await this.hasProvenOwner(ciEvent)) return;

    try {
      // Record discovery in change history
      await this.postgresClient.query(
        `INSERT INTO ci_change_history
         (ci_id, change_type, changed_by, change_source, changed_fields, new_values, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          ciEvent.ci_id,
          'discovered',
          'system',
          ciEvent.source_system,
          ['*'], // All fields are new
          JSON.stringify({
            ci_name: ciEvent.ci_name,
            ci_type: ciEvent.ci_type,
            identifiers: ciEvent.identifiers,
            confidence_score: ciEvent.confidence_score,
          }),
          JSON.stringify({
            event_id: ciEvent.event_id,
            organization_id: ciEvent.organization_id,
            timestamp: ciEvent.timestamp,
          }),
        ]
      );

      // Update CI statistics
      await this.updateCIStatistics(ciEvent.ci_id, 'discovered');

      logger.info('CI discovery tracked', {
        ci_id: ciEvent.ci_id,
        ci_name: ciEvent.ci_name,
        source: ciEvent.source_system,
      });
    } catch (error) {
      logger.error('Failed to track CI discovery', {
        event_id: ciEvent.event_id,
        ci_id: ciEvent.ci_id,
        error,
      });
      throw error;
    }
  }

  /**
   * Handle CI updated event
   */
  private async handleCIUpdated(event: CMDBEvent): Promise<void> {
    const updateEvent = event as CIUpdatedEvent;
    if (!await this.hasProvenOwner(updateEvent)) return;

    try {
      // Record update in change history
      await this.postgresClient.query(
        `INSERT INTO ci_change_history
         (ci_id, change_type, changed_by, change_source, changed_fields, previous_values, new_values, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          updateEvent.ci_id,
          'updated',
          'system',
          updateEvent.source_system,
          updateEvent.changed_fields,
          JSON.stringify(updateEvent.previous_values),
          JSON.stringify(updateEvent.new_values),
          JSON.stringify({
            event_id: updateEvent.event_id,
            timestamp: updateEvent.timestamp,
            organization_id: updateEvent.organization_id,
          }),
        ]
      );

      // Update CI statistics
      await this.updateCIStatistics(updateEvent.ci_id, 'updated');

      // Check for significant changes that might require alerts
      await this.checkForSignificantChanges(updateEvent);

      logger.info('CI update tracked', {
        ci_id: updateEvent.ci_id,
        ci_name: updateEvent.ci_name,
        changed_fields: updateEvent.changed_fields,
        source: updateEvent.source_system,
      });
    } catch (error) {
      logger.error('Failed to track CI update', {
        event_id: updateEvent.event_id,
        ci_id: updateEvent.ci_id,
        error,
      });
      throw error;
    }
  }

  /**
   * Handle CI deleted event
   */
  private async handleCIDeleted(event: CMDBEvent): Promise<void> {
    const deleteEvent = event as CIDeletedEvent;

    try {
      // Record deletion in change history
      await this.postgresClient.query(
        `INSERT INTO ci_change_history
         (ci_id, change_type, changed_by, change_source, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          deleteEvent.ci_id,
          'deleted',
          'system',
          deleteEvent.event_type,
          JSON.stringify({
            event_id: deleteEvent.event_id,
            timestamp: deleteEvent.timestamp,
            reason: deleteEvent.reason,
            ci_name: deleteEvent.ci_name,
            ci_type: deleteEvent.ci_type,
          }),
        ]
      );

      // Update CI statistics
      await this.updateCIStatistics(deleteEvent.ci_id, 'deleted');

      logger.info('CI deletion tracked', {
        ci_id: deleteEvent.ci_id,
        ci_name: deleteEvent.ci_name,
        reason: deleteEvent.reason,
      });
    } catch (error) {
      logger.error('Failed to track CI deletion', {
        event_id: deleteEvent.event_id,
        ci_id: deleteEvent.ci_id,
        error,
      });
      throw error;
    }
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
    limit: number = 100,
    offset: number = 0
  ): Promise<any[]> {
    const result = await this.postgresClient.query(
      `SELECT * FROM ci_change_history
       WHERE ci_id = $1
       ORDER BY changed_at DESC
       LIMIT $2 OFFSET $3`,
      [ciId, limit, offset]
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
