// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Change Detection Job
 *
 * This job tracks changes to Configuration Items (CIs) over time by:
 * - Monitoring CI updates in Neo4j
 * - Detecting what attributes changed
 * - Recording change events in PostgreSQL fact table
 * - Supporting change auditing and compliance
 *
 * Changes are recorded in the fact_ci_changes table for historical analysis.
 */

import { Job } from 'bullmq';
import { Neo4jClient, PostgresClient } from '@cmdb/database';
import { logger, CI } from '@cmdb/common';
import { subHours } from 'date-fns';
import { DimensionTransformer } from '../transformers/dimension-transformer';

export interface ChangeDetectionJobData {
  /** Start date for change detection (ISO 8601 format) */
  since?: string;
  /** CIs to check for changes (if not specified, checks all) */
  ciIds?: string[];
  /** Hours to look back (default: 24) */
  lookbackHours?: number;
  /** Whether to detect relationship changes */
  includeRelationships?: boolean;
}

export interface ChangeDetectionResult {
  /** Total CIs checked */
  cisChecked: number;
  /** Total changes detected */
  changesDetected: number;
  /** Changes recorded in database */
  changesRecorded: number;
  /** Change events */
  changes: ChangeEvent[];
  /** Duration in milliseconds */
  durationMs: number;
  /** Timestamp of completion */
  completedAt: string;
}

export interface ChangeEvent {
  /** CI identifier */
  ciId: string;
  /** CI name */
  ciName: string;
  /** Type of change */
  changeType: ChangeType;
  /** Field that changed */
  fieldName: string;
  /** Previous value */
  oldValue: unknown;
  /** New value */
  newValue: unknown;
  /** When the change occurred */
  changedAt: string;
  /** User or system that made the change */
  changedBy?: string;
}

export type ChangeType =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'status-changed'
  | 'relationship-added'
  | 'relationship-removed'
  | 'metadata-changed';

/**
 * Main change detection processor class
 */
export class ChangeDetectionJob {
  private neo4jClient: Neo4jClient;
  private postgresClient: PostgresClient;
  private dimensionTransformer: DimensionTransformer;

  constructor(neo4jClient: Neo4jClient, postgresClient: PostgresClient) {
    this.neo4jClient = neo4jClient;
    this.postgresClient = postgresClient;
    this.dimensionTransformer = new DimensionTransformer();
  }

  /**
   * Execute the change detection job
   */
  async execute(job: Job<ChangeDetectionJobData>): Promise<ChangeDetectionResult> {
    const startTime = Date.now();
    const data = job.data;

    // Determine time window for change detection
    const lookbackHours = data.lookbackHours || 24;
    const since = data.since || subHours(new Date(), lookbackHours).toISOString();

    logger.info('Starting change detection job', {
      _jobId: job.id,
      since,
      lookbackHours
    });

    const result: ChangeDetectionResult = {
      cisChecked: 0,
      changesDetected: 0,
      changesRecorded: 0,
      changes: [],
      durationMs: 0,
      completedAt: new Date().toISOString()
    };

    try {
      // Get CIs that have changed since the lookback time
      const changedCIs = await this.getChangedCIs(since, data.ciIds);

      logger.info(`Found ${changedCIs.length} CIs with potential changes`);

      // Process each changed CI
      for (let i = 0; i < changedCIs.length; i++) {
        const ci = changedCIs[i];
        await job.updateProgress((i / changedCIs.length) * 100);

        try {
          const changes = await this.detectChanges(ci!, since);

          if (changes.length > 0) {
            result.changesDetected += changes.length;
            result.changes.push(...changes);

            // Record changes in database
            await this.recordChanges(changes);
            result.changesRecorded += changes.length;
          }

          result.cisChecked++;

        } catch (error) {
          logger.error('Error detecting changes for CI', { ciId: ci!._id, error });
        }
      }

      // Detect relationship changes if requested
      if (data.includeRelationships) {
        const relChanges = await this.detectRelationshipChanges(since);
        result.changesDetected += relChanges.length;
        result.changes.push(...relChanges);

        if (relChanges.length > 0) {
          await this.recordChanges(relChanges);
          result.changesRecorded += relChanges.length;
        }
      }

      result.durationMs = Date.now() - startTime;
      result.completedAt = new Date().toISOString();

      logger.info('Change detection job completed', {
        _cisChecked: result.cisChecked,
        _changesDetected: result.changesDetected
      });

      return result;

    } catch (error) {
      logger.error('Change detection job failed', { error, jobId: job.id });
      throw error;
    }
  }

  /**
   * Get CIs that have changed since a specific time
   */
  private async getChangedCIs(since: string, ciIds?: string[]): Promise<CI[]> {
    const session = this.neo4jClient.getSession();

    try {
      let query = 'MATCH (ci:CI) WHERE ci.updated_at >= datetime($since)';
      const params: Record<string, unknown> = { since };

      if (ciIds && ciIds.length > 0) {
        query += ' AND ci.id IN $ciIds';
        params['ciIds'] = ciIds;
      }

      query += ' RETURN ci ORDER BY ci.updated_at DESC';

      const result = await session.run(query, params);

      return result.records.map((record: any) => {
        const node = record.get('ci');
        const props = node.properties;
        return {
          _id: props.id,
          external_id: props.external_id,
          name: props.name,
          _type: props.type,
          _status: props.status,
          environment: props.environment,
          _created_at: props.created_at,
          _updated_at: props.updated_at,
          _discovered_at: props.discovered_at,
          _metadata: props.metadata ? JSON.parse(props.metadata) : {}
        };
      });

    } finally {
      await session.close();
    }
  }

  /**
   * Detect what changed in a CI by comparing with historical data
   */
  private async detectChanges(ci: CI, since: string): Promise<ChangeEvent[]> {
    const changes: ChangeEvent[] = [];

    // Get historical version of CI from PostgreSQL
    const historicalCI = await this.getHistoricalCI(ci._id, since);

    if (!historicalCI) {
      // This is a new CI created within the lookback period
      changes.push({
        ciId: ci._id,
        ciName: ci.name,
        changeType: 'created',
        fieldName: '*',
        oldValue: null,
        newValue: ci,
        changedAt: ci._created_at,
        changedBy: 'system'
      });
      return changes;
    }

    // Compare current vs historical state
    const fieldsToCheck: Array<keyof CI> = [
      'name', '_status', 'environment', '_type'
    ];

    for (const field of fieldsToCheck) {
      if (ci[field] !== historicalCI[field]) {
        const changeType = field === '_status' ? 'status-changed' : 'updated';

        changes.push({
          ciId: ci._id,
          ciName: ci.name,
          changeType,
          fieldName: field,
          oldValue: historicalCI[field],
          newValue: ci[field],
          changedAt: ci._updated_at,
          changedBy: 'system'
        });
      }
    }

    // Check metadata changes (simplified - just detect if changed)
    const currentMeta = JSON.stringify(ci._metadata || {});
    const historicalMeta = JSON.stringify(historicalCI._metadata || {});

    if (currentMeta !== historicalMeta) {
      changes.push({
        ciId: ci._id,
        ciName: ci.name,
        changeType: 'metadata-changed',
        fieldName: 'metadata',
        oldValue: historicalCI._metadata,
        newValue: ci._metadata,
        changedAt: ci._updated_at,
        changedBy: 'system'
      });
    }

    return changes;
  }

  /**
   * Get historical state of CI from PostgreSQL
   */
  private async getHistoricalCI(ciId: string, beforeDate: string): Promise<CI | null> {
    const result = await this.postgresClient.query(
      `SELECT * FROM cmdb.dim_ci
       WHERE ci_id = $1
       AND effective_from < $2
       ORDER BY effective_from DESC
       LIMIT 1`,
      [ciId, beforeDate]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      _id: row.ci_id,
      external_id: row.external_id,
      name: row.ci_name,
      _type: row.ci_type,
      _status: row.ci_status,
      environment: row.environment,
      _created_at: row.created_at,
      _updated_at: row.updated_at,
      _discovered_at: row.discovered_at,
      _metadata: row.metadata || {}
    };
  }

  /**
   * Detect relationship changes
   */
  private async detectRelationshipChanges(since: string): Promise<ChangeEvent[]> {
    const changes: ChangeEvent[] = [];
    const session = this.neo4jClient.getSession();

    try {
      // Query for recently added/updated relationships
      const result = await session.run(
        `MATCH (from:CI)-[r]->(to:CI)
         WHERE r.created_at >= datetime($since) OR r.updated_at >= datetime($since)
         RETURN from.id as fromId, from.name as fromName,
                to.id as toId, to.name as toName,
                type(r) as relType, r.created_at as createdAt, r.updated_at as updatedAt`,
        { since }
      );

      for (const record of result.records) {
        const createdAt = record.get('createdAt');
        const updatedAt = record.get('updatedAt');
        const isNew = new Date(createdAt).toISOString() >= since;

        changes.push({
          ciId: record.get('fromId'),
          ciName: record.get('fromName'),
          changeType: isNew ? 'relationship-added' : 'updated',
          fieldName: 'relationship',
          oldValue: null,
          newValue: {
            type: record.get('relType'),
            to: {
              id: record.get('toId'),
              name: record.get('toName')
            }
          },
          changedAt: isNew ? createdAt : updatedAt,
          changedBy: 'system'
        });
      }

    } finally {
      await session.close();
    }

    return changes;
  }

  /**
   * Record changes in PostgreSQL fact table
   */
  private async recordChanges(changes: ChangeEvent[]): Promise<void> {
    if (changes.length === 0) {
      return;
    }

    await this.postgresClient.transaction(async (client: any) => {
      let savepointIndex = 0;

      for (const change of changes) {
        const savepointName = `sp_change_${savepointIndex++}`;

        try {
          await client.query(`SAVEPOINT ${savepointName}`);

          const ciKeyResult = await client.query(
            'SELECT ci_key FROM cmdb.dim_ci WHERE ci_id = $1 AND is_current = true',
            [change.ciId]
          );

          if (ciKeyResult.rows.length === 0) {
            throw new Error(`No current cmdb.dim_ci record found for CI id ${change.ciId}`);
          }

          const ciKey = ciKeyResult.rows[0].ci_key;
          const changedAt = new Date(change.changedAt);

          await client.query(
            `INSERT INTO cmdb.fact_ci_changes
             (ci_key, date_key, changed_at, change_type, field_name, old_value, new_value, changed_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              ciKey,
              this.dimensionTransformer.generateDateKey(changedAt),
              changedAt,
              change.changeType,
              change.fieldName,
              JSON.stringify(change.oldValue),
              JSON.stringify(change.newValue),
              change.changedBy || 'system'
            ]
          );

          await client.query(`RELEASE SAVEPOINT ${savepointName}`);
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
          logger.error('Error recording change', { change, error });
        }
      }
    });

    logger.info(`Recorded ${changes.length} changes in database`);
  }
}

/**
 * BullMQ job processor function
 */
export async function processChangeDetectionJob(
  job: Job<ChangeDetectionJobData>,
  neo4jClient: Neo4jClient,
  postgresClient: PostgresClient
): Promise<ChangeDetectionResult> {
  const processor = new ChangeDetectionJob(neo4jClient, postgresClient);
  return await processor.execute(job);
}
