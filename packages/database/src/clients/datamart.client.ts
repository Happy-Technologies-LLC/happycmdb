// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Data Mart Client
 *
 * This module provides a high-level client for interacting with the PostgreSQL
 * data mart, including helper methods for dimension and fact table operations.
 *
 * Features:
 * - SCD Type 2 (Slowly Changing Dimensions) support for CI dimensions
 * - Batch operations for efficient data loading
 * - Transaction support for data consistency
 * - Analytics query helpers
 * - Comprehensive logging and error handling
 *
 * Usage:
 *   const datamartClient = getDataMartClient();
 *   const ciKey = await datamartClient.upsertCI({...});
 *   await datamartClient.recordDiscovery({...});
 */

import { isDeepStrictEqual } from 'node:util';
import { getPostgresClient, PostgresClient } from '../postgres/client';
import { logger } from '@cmdb/common';
import type {
  CIDimensionInput,
  LocationDimensionInput,
  OwnerDimensionInput,
  DiscoveryFactInput,
  ChangesFactInput,
  RelationshipFactInput,
} from '@cmdb/common';

/**
 * Data Mart Client
 *
 * Provides high-level operations for the CMDB data mart with support for
 * dimensional modeling and analytical queries.
 */
export class DataMartClient {
  private pgClient: PostgresClient;

  constructor(pgClient: PostgresClient) {
    this.pgClient = pgClient;
  }

  // ============================================
  // CI DIMENSION OPERATIONS (SCD Type 2)
  // ============================================

  /**
   * Insert or update a CI dimension record with SCD Type 2 support
   *
   * If CI already exists:
   * - Checks if attributes have changed
   * - If changed, expires old record and creates new current record
   * - If unchanged, returns existing CI key
   *
   * If CI is new:
   * - Creates new current record
   *
   * @param ci - CI dimension data
   * @returns CI surrogate key (ci_key)
   */
  async upsertCI(ci: CIDimensionInput): Promise<number> {
    try {
      // Check if current record exists
      const existing = await this.pgClient.query(
        `
        SELECT ci_key, ci_name, ci_type, ci_status, environment, external_id, metadata
        FROM cmdb.dim_ci
        WHERE ci_id = $1 AND is_current = TRUE
        `,
        [ci.ci_id]
      );

      if (existing.rows.length > 0) {
        const currentRecord = existing.rows[0];

        // Check if data has changed
        if (this.hasCIChanged(currentRecord, ci)) {
          logger.debug('CI attributes changed, creating new version', { ci_id: ci.ci_id });
          return await this.pgClient.updateCIDimension(ci);
        } else {
          logger.debug('CI unchanged, returning existing key', { ci_id: ci.ci_id });
          return currentRecord.ci_key;
        }
      } else {
        // Insert new CI
        logger.debug('Creating new CI dimension record', { ci_id: ci.ci_id });
        return await this.pgClient.insertCIDimension(ci);
      }
    } catch (error) {
      logger.error('Failed to upsert CI dimension', { ci_id: ci.ci_id, error });
      throw error;
    }
  }

  /**
   * Batch upsert multiple CIs
   *
   * @param cis - Array of CI dimension records
   * @returns Map of ci_id to ci_key
   */
  async batchUpsertCIs(cis: CIDimensionInput[]): Promise<Map<string, number>> {
    const ciKeyMap = new Map<string, number>();

    logger.info('Starting batch CI upsert', { count: cis.length });

    for (const ci of cis) {
      try {
        const ciKey = await this.upsertCI(ci);
        ciKeyMap.set(ci.ci_id, ciKey);
      } catch (error) {
        logger.error('Failed to upsert CI in batch', { ci_id: ci.ci_id, error });
        // Continue processing other CIs
      }
    }

    logger.info('Batch CI upsert completed', {
      total: cis.length,
      successful: ciKeyMap.size,
      failed: cis.length - ciKeyMap.size,
    });

    return ciKeyMap;
  }

  /**
   * Get current CI key by ci_id
   *
   * @param ciId - CI identifier
   * @returns CI key or null if not found
   */
  async getCIKey(ciId: string): Promise<number | null> {
    return await this.pgClient.getCurrentCIKey(ciId);
  }

  /**
   * Get all current CIs of a specific type
   *
   * @param ciType - Type of CI to retrieve
   * @returns Array of current CI records
   */
  async getCurrentCIsByType(ciType: string): Promise<any[]> {
    const result = await this.pgClient.query(
      `
      SELECT ci_key, ci_id, ci_name, ci_type, ci_status, environment, external_id, metadata
      FROM cmdb.dim_ci
      WHERE ci_type = $1 AND is_current = TRUE
      ORDER BY ci_name
      `,
      [ciType]
    );

    return result.rows;
  }

  /**
   * Get CI history (all versions) by ci_id
   *
   * @param ciId - CI identifier
   * @returns Array of CI versions ordered by effective date
   */
  async getCIHistory(ciId: string): Promise<any[]> {
    const result = await this.pgClient.query(
      `
      SELECT ci_key, ci_id, ci_name, ci_type, ci_status, environment,
             external_id, metadata, effective_from, effective_to, is_current
      FROM cmdb.dim_ci
      WHERE ci_id = $1
      ORDER BY effective_from DESC
      `,
      [ciId]
    );

    return result.rows;
  }

  // ============================================
  // LOCATION DIMENSION OPERATIONS
  // ============================================

  /**
   * Upsert location dimension record
   *
   * @param location - Location dimension data
   * @returns Location surrogate key (location_key)
   */
  async upsertLocation(location: LocationDimensionInput): Promise<number> {
    try {
      return await this.pgClient.insertLocationDimension(location);
    } catch (error) {
      logger.error('Failed to upsert location dimension', {
        location_id: location.location_id,
        error,
      });
      throw error;
    }
  }

  /**
   * Get location key by location_id
   *
   * @param locationId - Location identifier
   * @returns Location key or null if not found
   */
  async getLocationKey(locationId: string): Promise<number | null> {
    return await this.pgClient.getLocationKey(locationId);
  }

  // ============================================
  // OWNER DIMENSION OPERATIONS
  // ============================================

  /**
   * Upsert owner dimension record
   *
   * @param owner - Owner dimension data
   * @returns Owner surrogate key (owner_key)
   */
  async upsertOwner(owner: OwnerDimensionInput): Promise<number> {
    try {
      return await this.pgClient.insertOwnerDimension(owner);
    } catch (error) {
      logger.error('Failed to upsert owner dimension', { owner_id: owner.owner_id, error });
      throw error;
    }
  }

  // ============================================
  // DISCOVERY FACT OPERATIONS
  // ============================================

  /**
   * Record a discovery event
   *
   * @param discovery - Discovery fact data
   */
  async recordDiscovery(discovery: DiscoveryFactInput): Promise<void> {
    try {
      await this.pgClient.insertDiscoveryFact(discovery);
      logger.debug('Discovery fact recorded', {
        ci_key: discovery.ci_key,
        provider: discovery.discovery_provider,
      });
    } catch (error) {
      logger.error('Failed to record discovery fact', { discovery, error });
      throw error;
    }
  }

  /**
   * Batch record multiple discovery events
   *
   * @param discoveries - Array of discovery facts
   */
  async batchRecordDiscoveries(discoveries: DiscoveryFactInput[]): Promise<void> {
    logger.info('Starting batch discovery recording', { count: discoveries.length });

    let successCount = 0;
    let failCount = 0;

    for (const discovery of discoveries) {
      try {
        await this.recordDiscovery(discovery);
        successCount++;
      } catch (error) {
        failCount++;
        logger.error('Failed to record discovery in batch', { discovery, error });
        // Continue processing other discoveries
      }
    }

    logger.info('Batch discovery recording completed', {
      total: discoveries.length,
      successful: successCount,
      failed: failCount,
    });
  }

  // ============================================
  // CHANGE FACT OPERATIONS
  // ============================================

  /**
   * Record a CI change event
   *
   * @param change - Change fact data
   */
  async recordChange(change: ChangesFactInput): Promise<void> {
    try {
      await this.pgClient.insertChangesFact(change);
      logger.debug('Change fact recorded', {
        ci_key: change.ci_key,
        change_type: change.change_type,
      });
    } catch (error) {
      logger.error('Failed to record change fact', { change, error });
      throw error;
    }
  }

  /**
   * Batch record multiple change events
   *
   * @param changes - Array of change facts
   */
  async batchRecordChanges(changes: ChangesFactInput[]): Promise<void> {
    logger.info('Starting batch change recording', { count: changes.length });

    let successCount = 0;
    let failCount = 0;

    for (const change of changes) {
      try {
        await this.recordChange(change);
        successCount++;
      } catch (error) {
        failCount++;
        logger.error('Failed to record change in batch', { change, error });
        // Continue processing other changes
      }
    }

    logger.info('Batch change recording completed', {
      total: changes.length,
      successful: successCount,
      failed: failCount,
    });
  }

  // ============================================
  // RELATIONSHIP FACT OPERATIONS
  // ============================================

  /**
   * Record a CI relationship
   *
   * @param relationship - Relationship fact data
   */
  async recordRelationship(relationship: RelationshipFactInput): Promise<void> {
    try {
      await this.pgClient.insertRelationshipFact(relationship);
      logger.debug('Relationship fact recorded', {
        from_ci_key: relationship.from_ci_key,
        to_ci_key: relationship.to_ci_key,
        type: relationship.relationship_type,
      });
    } catch (error) {
      logger.error('Failed to record relationship fact', { relationship, error });
      throw error;
    }
  }

  /**
   * Batch record multiple relationships
   *
   * @param relationships - Array of relationship facts
   */
  async batchRecordRelationships(relationships: RelationshipFactInput[]): Promise<void> {
    logger.info('Starting batch relationship recording', { count: relationships.length });

    let successCount = 0;
    let failCount = 0;

    for (const relationship of relationships) {
      try {
        await this.recordRelationship(relationship);
        successCount++;
      } catch (error) {
        failCount++;
        logger.error('Failed to record relationship in batch', { relationship, error });
        // Continue processing other relationships
      }
    }

    logger.info('Batch relationship recording completed', {
      total: relationships.length,
      successful: successCount,
      failed: failCount,
    });
  }

  /**
   * Deactivate a relationship
   *
   * @param fromCiKey - Source CI key
   * @param toCiKey - Target CI key
   * @param relationshipType - Type of relationship
   */
  async deactivateRelationship(
    fromCiKey: number,
    toCiKey: number,
    relationshipType: string
  ): Promise<void> {
    try {
      await this.pgClient.deactivateRelationship(fromCiKey, toCiKey, relationshipType);
      logger.debug('Relationship deactivated', { fromCiKey, toCiKey, relationshipType });
    } catch (error) {
      logger.error('Failed to deactivate relationship', {
        fromCiKey,
        toCiKey,
        relationshipType,
        error,
      });
      throw error;
    }
  }

  // ============================================
  // ANALYTICS QUERY OPERATIONS
  // ============================================

  /**
   * Get current CI inventory
   *
   * @returns Array of current CI inventory records
   */
  async getCurrentInventory(): Promise<any[]> {
    try {
      return await this.pgClient.getCurrentInventory();
    } catch (error) {
      logger.error('Failed to get current inventory', error);
      throw error;
    }
  }

  /**
   * Get CI discovery summary
   *
   * @param ciId - Optional CI ID to filter results
   * @returns Array of discovery summary records
   */
  async getDiscoverySummary(ciId?: string): Promise<any[]> {
    try {
      return await this.pgClient.getDiscoverySummary(ciId);
    } catch (error) {
      logger.error('Failed to get discovery summary', { ciId, error });
      throw error;
    }
  }

  /**
   * Get CI change history
   *
   * @param ciId - Optional CI ID to filter results
   * @param limit - Maximum number of records to return
   * @returns Array of change history records
   */
  async getChangeHistory(ciId?: string, limit: number = 100): Promise<any[]> {
    try {
      return await this.pgClient.getChangeHistory(ciId, limit);
    } catch (error) {
      logger.error('Failed to get change history', { ciId, limit, error });
      throw error;
    }
  }

  /**
   * Get CI relationships
   *
   * @param ciId - CI identifier
   * @returns Array of relationship records
   */
  async getCIRelationships(ciId: string): Promise<any[]> {
    try {
      return await this.pgClient.getCIRelationships(ciId);
    } catch (error) {
      logger.error('Failed to get CI relationships', { ciId, error });
      throw error;
    }
  }

  /**
   * Get CI count by type
   *
   * @returns Map of CI type to count
   */
  async getCICountByType(): Promise<Map<string, number>> {
    try {
      const result = await this.pgClient.query(`
        SELECT ci_type, COUNT(*) as count
        FROM cmdb.dim_ci
        WHERE is_current = TRUE
        GROUP BY ci_type
        ORDER BY count DESC
      `);

      const countMap = new Map<string, number>();
      for (const row of result.rows) {
        countMap.set(row.ci_type, parseInt(row.count));
      }

      return countMap;
    } catch (error) {
      logger.error('Failed to get CI count by type', error);
      throw error;
    }
  }

  /**
   * Get CI count by environment
   *
   * @returns Map of environment to count
   */
  async getCICountByEnvironment(): Promise<Map<string, number>> {
    try {
      const result = await this.pgClient.query(`
        SELECT environment, COUNT(*) as count
        FROM cmdb.dim_ci
        WHERE is_current = TRUE AND environment IS NOT NULL
        GROUP BY environment
        ORDER BY count DESC
      `);

      const countMap = new Map<string, number>();
      for (const row of result.rows) {
        countMap.set(row.environment, parseInt(row.count));
      }

      return countMap;
    } catch (error) {
      logger.error('Failed to get CI count by environment', error);
      throw error;
    }
  }

  /**
   * Get discovery statistics for a date range
   *
   * @param startDate - Start date
   * @param endDate - End date
   * @returns Discovery statistics
   */
  async getDiscoveryStats(
    startDate: Date,
    endDate: Date
  ): Promise<{
    total_discoveries: number;
    unique_cis: number;
    avg_confidence: number;
    by_provider: Array<{ provider: string; count: number }>;
  }> {
    try {
      const statsResult = await this.pgClient.query(
        `
        SELECT
          COUNT(*) as total_discoveries,
          COUNT(DISTINCT ci_key) as unique_cis,
          AVG(confidence_score) as avg_confidence
        FROM cmdb.fact_discovery
        WHERE discovered_at >= $1 AND discovered_at <= $2
        `,
        [startDate, endDate]
      );

      const providerResult = await this.pgClient.query(
        `
        SELECT
          discovery_provider as provider,
          COUNT(*) as count
        FROM cmdb.fact_discovery
        WHERE discovered_at >= $1 AND discovered_at <= $2
        GROUP BY discovery_provider
        ORDER BY count DESC
        `,
        [startDate, endDate]
      );

      return {
        total_discoveries: parseInt(statsResult.rows[0]?.total_discoveries || '0'),
        unique_cis: parseInt(statsResult.rows[0]?.unique_cis || '0'),
        avg_confidence: parseFloat(statsResult.rows[0]?.avg_confidence || '0'),
        by_provider: providerResult.rows.map((row) => ({
          provider: row.provider,
          count: parseInt(row.count),
        })),
      };
    } catch (error) {
      logger.error('Failed to get discovery stats', { startDate, endDate, error });
      throw error;
    }
  }

  /**
   * Get change statistics for a date range
   *
   * @param startDate - Start date
   * @param endDate - End date
   * @returns Change statistics
   */
  async getChangeStats(
    startDate: Date,
    endDate: Date
  ): Promise<{
    total_changes: number;
    unique_cis: number;
    by_type: Array<{ change_type: string; count: number }>;
    by_source: Array<{ change_source: string; count: number }>;
  }> {
    try {
      const statsResult = await this.pgClient.query(
        `
        SELECT
          COUNT(*) as total_changes,
          COUNT(DISTINCT ci_key) as unique_cis
        FROM cmdb.fact_ci_changes
        WHERE changed_at >= $1 AND changed_at <= $2
        `,
        [startDate, endDate]
      );

      const typeResult = await this.pgClient.query(
        `
        SELECT
          change_type,
          COUNT(*) as count
        FROM cmdb.fact_ci_changes
        WHERE changed_at >= $1 AND changed_at <= $2
        GROUP BY change_type
        ORDER BY count DESC
        `,
        [startDate, endDate]
      );

      const sourceResult = await this.pgClient.query(
        `
        SELECT
          change_source,
          COUNT(*) as count
        FROM cmdb.fact_ci_changes
        WHERE changed_at >= $1 AND changed_at <= $2
        GROUP BY change_source
        ORDER BY count DESC
        `,
        [startDate, endDate]
      );

      return {
        total_changes: parseInt(statsResult.rows[0]?.total_changes || '0'),
        unique_cis: parseInt(statsResult.rows[0]?.unique_cis || '0'),
        by_type: typeResult.rows.map((row) => ({
          change_type: row.change_type,
          count: parseInt(row.count),
        })),
        by_source: sourceResult.rows.map((row) => ({
          change_source: row.change_source,
          count: parseInt(row.count),
        })),
      };
    } catch (error) {
      logger.error('Failed to get change stats', { startDate, endDate, error });
      throw error;
    }
  }

  // ============================================
  // UTILITY METHODS
  // ============================================

  /**
   * Get date key for a timestamp
   *
   * @param timestamp - Date to convert
   * @returns Date key (YYYYMMDD as integer)
   */
  async getDateKey(timestamp: Date): Promise<number> {
    return await this.pgClient.getDateKey(timestamp);
  }

  /**
   * Check if CI attributes have changed
   *
   * @param existing - Existing CI record from database
   * @param incoming - New CI data
   * @returns True if attributes changed
   */
  private hasCIChanged(existing: any, incoming: CIDimensionInput): boolean {
    // Treat SQL NULL (read back as JS null) and an omitted/undefined optional
    // field as equivalent, so upsertCI does not spuriously re-version a CI
    // just because a caller left an optional field unspecified.
    const normalize = (v: unknown) => (v === null || v === undefined ? undefined : v);

    // Compare key attributes
    if (normalize(existing.ci_name) !== normalize(incoming.ciname)) return true;
    if (normalize(existing.ci_type) !== normalize(incoming.ci_type)) return true;
    if (normalize(existing.ci_status) !== normalize(incoming.ci_status)) return true;
    if (normalize(existing.environment) !== normalize(incoming.environment)) return true;
    if (normalize(existing.external_id) !== normalize(incoming.external_id)) return true;

    // Compare metadata (object/JSONB field) under the same normalization: a
    // stored NULL and an omitted `metadata` are equal, but a transition
    // between "has a value" and "has no value" in either direction is a
    // real change, and two present values are compared by deep equality.
    const existingMetadata = normalize(existing.metadata);
    const incomingMetadata = normalize(incoming.metadata);
    if (existingMetadata === undefined && incomingMetadata === undefined) {
      // both absent -> unchanged
    } else if (existingMetadata === undefined || incomingMetadata === undefined) {
      return true;
    } else if (!isDeepStrictEqual(existingMetadata, incomingMetadata)) {
      return true;
    }

    return false;
  }

  /**
   * Execute a custom query
   *
   * @param sql - SQL query
   * @param params - Query parameters
   * @returns Query result
   */
  async query(sql: string, params?: any[]): Promise<any> {
    return await this.pgClient.query(sql, params);
  }

  /**
   * Execute a transaction
   *
   * @param callback - Transaction callback
   * @returns Transaction result
   */
  async transaction<T>(callback: (client: any) => Promise<T>): Promise<T> {
    return await this.pgClient.transaction(callback);
  }
}

// ============================================
// SINGLETON INSTANCE
// ============================================

let dataMartClient: DataMartClient | null = null;

/**
 * Get singleton instance of DataMartClient
 *
 * @returns DataMartClient instance
 */
export function getDataMartClient(): DataMartClient {
  if (!dataMartClient) {
    const pgClient = getPostgresClient();
    dataMartClient = new DataMartClient(pgClient);
    logger.info('DataMartClient initialized');
  }
  return dataMartClient;
}

/**
 * Reset singleton (useful for testing)
 */
export function resetDataMartClient(): void {
  dataMartClient = null;
}
