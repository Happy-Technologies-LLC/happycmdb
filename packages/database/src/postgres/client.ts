// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/database/src/postgres/client.ts

import { Pool, PoolClient } from 'pg';
import { logger } from '@cmdb/common';
import type {
  CIDimensionInput,
  LocationDimensionInput,
  OwnerDimensionInput,
  DiscoveryFactInput,
  ChangesFactInput,
  RelationshipFactInput,
  CurrentCIInventoryRow,
  CIDiscoverySummaryRow,
  CIChangeHistoryRow,
  CIRelationshipRow,
} from '@cmdb/common';

export class PostgresClient {
  public pool: Pool; // Made public to allow access for services that need the Pool directly

  constructor(config: {
    _host: string;
    _port: number;
    _database: string;
    _user: string;
    _password: string;
    ssl?: boolean | 'require' | 'prefer' | 'verify-full';
  }) {
    // Determine SSL configuration
    const sslMode = config.ssl ||
                   process.env['POSTGRES_SSL_MODE'] ||
                   (process.env['POSTGRES_SSL_ENABLED'] === 'on' ? 'require' : false);

    let sslConfig: any = false;

    // Check if SSL is enabled (handle all falsy values)
    if (sslMode && sslMode !== 'off' && sslMode !== 'false') {
      if (sslMode === 'require') {
        sslConfig = { rejectUnauthorized: false };
        logger.info('PostgreSQL SSL enabled (require mode - accepts self-signed certificates)');
      } else if (sslMode === 'verify-full') {
        sslConfig = { rejectUnauthorized: true };
        logger.info('PostgreSQL SSL enabled (verify-full mode - requires valid CA)');
      } else if (sslMode === 'prefer') {
        sslConfig = { rejectUnauthorized: false };
        logger.info('PostgreSQL SSL enabled (prefer mode - attempts SSL, falls back to unencrypted)');
      } else if (sslMode === true) {
        sslConfig = { rejectUnauthorized: false };
        logger.info('PostgreSQL SSL enabled (default mode)');
      }
    } else {
      logger.warn('PostgreSQL client initialized WITHOUT SSL encryption (development mode)');
    }

    this.pool = new Pool({
      host: config._host,
      port: config._port,
      database: config._database,
      user: config._user,
      password: config._password,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
      ssl: sslConfig,
    });

    this.pool.on('error', (err) => {
      logger.error('Unexpected error on idle PostgreSQL client', err);
    });
  }

  async query(text: string, params?: any[]) {
    const start = Date.now();
    try {
      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;
      logger.debug('Executed query', { text, duration, rows: result.rowCount });
      return result;
    } catch (error) {
      logger.error('Query error', { text, error });
      throw error;
    }
  }

  async getClient(): Promise<PoolClient> {
    return await this.pool.connect();
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ============================================
  // DATA MART - DIMENSION TABLE METHODS
  // ============================================

  /**
   * Insert a new CI dimension record
   * Implements SCD Type 2: Creates a new version of the CI
   */
  async insertCIDimension(ci: CIDimensionInput): Promise<number> {
    const result = await this.query(
      `
      INSERT INTO cmdb.dim_ci (
        ci_id, ci_name, ci_type, ci_status, environment,
        external_id, metadata, effective_from, is_current, organization_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9)
      RETURNING ci_key
      `,
      [
        ci.ci_id,
        ci.ciname,
        ci.ci_type,
        ci.ci_status,
        ci.environment || null,
        ci.external_id || null,
        ci.metadata ? JSON.stringify(ci.metadata) : null,
        ci.effective_from || new Date(),
        ci.organization_id,
      ]
    );
    return result.rows[0].ci_key;
  }

  /**
   * Update a CI dimension using SCD Type 2
   * Expires the old record and creates a new current record
   */
  async updateCIDimension(ci: CIDimensionInput): Promise<number> {
    return await this.transaction(async (client) => {
      const now = new Date();
      // A row lock on the backfilled current version is insufficient: once
      // another transaction expires it, a waiting SELECT can see no row.
      // Serialize this SCD update for the natural id through commit before
      // rechecking its latest organization, even if the current row vanishes.
      // The ETL dimension writers take this same key (lockCIDimensions in
      // @cmdb/etl-processor's transformers/ci-organization.ts).
      await client.query(
        'SELECT pg_advisory_xact_lock(8271, hashtext($1))',
        [ci.ci_id]
      );

      // No stored row ever changes organization (migration 011): a pre-011
      // ci_id can carry several lineages. The new record may name another
      // organization only when the current row is a 011 backfill label
      // (org_backfilled); the earlier versions keep theirs. Otherwise a
      // different organization is refused and nothing is written (the
      // transaction rolls back).
      const current = await client.query(
        'SELECT organization_id, org_backfilled FROM cmdb.dim_ci WHERE ci_id = $1 AND is_current = TRUE',
        [ci.ci_id]
      );
      const stored = current.rows[0];
      if (stored && stored.organization_id !== ci.organization_id.toLowerCase() && stored.org_backfilled !== true) {
        throw new Error(`CI ${ci.ci_id} belongs to another organization`);
      }
      if (stored && stored.org_backfilled === true) {
        await client.query(
          'UPDATE cmdb.dim_ci SET org_backfilled = FALSE WHERE ci_id = $1 AND org_backfilled',
          [ci.ci_id]
        );
      }

      // Step 1: Expire the current record for this ci_id
      await client.query(
        `
        UPDATE cmdb.dim_ci
        SET effective_to = $1, is_current = FALSE
        WHERE ci_id = $2 AND is_current = TRUE
        `,
        [now, ci.ci_id]
      );

      // Step 2: Insert new current record
      const result = await client.query(
        `
        INSERT INTO cmdb.dim_ci (
          ci_id, ci_name, ci_type, ci_status, environment,
          external_id, metadata, effective_from, is_current, organization_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9)
        RETURNING ci_key
        `,
        [
          ci.ci_id,
          ci.ciname,
          ci.ci_type,
          ci.ci_status,
          ci.environment || null,
          ci.external_id || null,
          ci.metadata ? JSON.stringify(ci.metadata) : null,
          now,
          ci.organization_id,
        ]
      );

      return result.rows[0].ci_key;
    });
  }

  /**
   * Get or create a CI dimension record
   * Returns existing current record or creates a new one
   */
  async upsertCIDimension(ci: CIDimensionInput): Promise<number> {
    // Check if current record exists
    const existing = await this.query(
      `
      SELECT ci_key FROM cmdb.dim_ci
      WHERE ci_id = $1 AND is_current = TRUE
      `,
      [ci.ci_id]
    );

    if (existing.rows.length > 0) {
      // Update existing (creates new version via SCD Type 2)
      return await this.updateCIDimension(ci);
    } else {
      // Insert new
      return await this.insertCIDimension(ci);
    }
  }

  /**
   * Get the current CI key for a given ci_id
   */
  async getCurrentCIKey(ciId: string): Promise<number | null> {
    const result = await this.query(
      `
      SELECT ci_key FROM cmdb.dim_ci
      WHERE ci_id = $1 AND is_current = TRUE
      `,
      [ciId]
    );

    return result.rows.length > 0 ? result.rows[0].ci_key : null;
  }

  /**
   * Insert a location dimension record
   */
  async insertLocationDimension(location: LocationDimensionInput): Promise<number> {
    const result = await this.query(
      `
      INSERT INTO cmdb.dim_location (
        location_id, location_name, location_type, cloud_provider,
        region, country, city, latitude, longitude, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (location_id) DO UPDATE
      SET location_name = EXCLUDED.location_name,
          updated_at = CURRENT_TIMESTAMP
      RETURNING location_key
      `,
      [
        location.location_id,
        location.locationname,
        location.location_type,
        location.cloud_provider || null,
        location.region || null,
        location.country || null,
        location.city || null,
        location.latitude || null,
        location.longitude || null,
        location.metadata ? JSON.stringify(location.metadata) : null,
      ]
    );
    return result.rows[0].location_key;
  }

  /**
   * Get location key by location_id
   */
  async getLocationKey(locationId: string): Promise<number | null> {
    const result = await this.query(
      `
      SELECT location_key FROM cmdb.dim_location
      WHERE location_id = $1
      `,
      [locationId]
    );

    return result.rows.length > 0 ? result.rows[0].location_key : null;
  }

  /**
   * Insert an owner dimension record
   */
  async insertOwnerDimension(owner: OwnerDimensionInput): Promise<number> {
    const result = await this.query(
      `
      INSERT INTO cmdb.dim_owner (
        owner_id, owner_name, owner_type, email,
        department, cost_center, manager_id, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (owner_id) DO UPDATE
      SET owner_name = EXCLUDED.owner_name,
          email = EXCLUDED.email,
          updated_at = CURRENT_TIMESTAMP
      RETURNING owner_key
      `,
      [
        owner.owner_id,
        owner.ownername,
        owner.owner_type,
        owner.email || null,
        owner.department || null,
        owner.cost_center || null,
        owner.manager_id || null,
        owner.metadata ? JSON.stringify(owner.metadata) : null,
      ]
    );
    return result.rows[0].owner_key;
  }

  /**
   * Helper: Get date key from timestamp
   */
  async getDateKey(timestamp: Date): Promise<number> {
    const result = await this.query(
      `SELECT cmdb.get_date_key($1::TIMESTAMPTZ) AS date_key`,
      [timestamp]
    );
    return result.rows[0].date_key;
  }

  // ============================================
  // DATA MART - FACT TABLE METHODS
  // ============================================

  /**
   * Insert a discovery fact record
   * Records a discovery event for a CI
   */
  async insertDiscoveryFact(fact: DiscoveryFactInput): Promise<void> {
    await this.query(
      `
      INSERT INTO cmdb.fact_discovery (
        ci_key, location_key, date_key, discovered_at,
        discovery_job_id, discovery_provider, discovery_method,
        confidence_score, discovery_duration_ms
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        fact.ci_key,
        fact.location_key || null,
        fact.date_key,
        fact.discovered_at,
        fact.discovery_job_id,
        fact.discovery_provider,
        fact.discoverymethod,
        fact.confidence_score || null,
        fact.discovery_duration_ms || null,
      ]
    );
  }

  /**
   * Insert a CI change fact record
   * Records a change event for a CI
   */
  async insertChangesFact(change: ChangesFactInput): Promise<void> {
    await this.query(
      `
      INSERT INTO cmdb.fact_ci_changes (
        ci_key, date_key, changed_at, change_type,
        field_name, old_value, new_value, changed_by,
        change_source, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        change.ci_key,
        change.date_key,
        change.changed_at,
        change.change_type,
        change.field_name || null,
        change.old_value || null,
        change.new_value || null,
        change.changed_by || null,
        change.change_source || 'discovery',
        change.metadata ? JSON.stringify(change.metadata) : null,
      ]
    );
  }

  /**
   * Insert a CI relationship fact record
   * Records a relationship between two CIs
   */
  async insertRelationshipFact(relationship: RelationshipFactInput): Promise<void> {
    await this.query(
      `
      INSERT INTO cmdb.fact_ci_relationships (
        from_ci_key, to_ci_key, date_key, relationship_type,
        relationship_strength, discovered_at, last_verified_at,
        is_active, properties
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        relationship.from_ci_key,
        relationship.to_ci_key,
        relationship.date_key,
        relationship.relationship_type,
        relationship.relationship_strength || null,
        relationship.discovered_at,
        relationship.last_verified_at || null,
        relationship.is_active !== undefined ? relationship.is_active : true,
        relationship.properties ? JSON.stringify(relationship.properties) : null,
      ]
    );
  }

  /**
   * Update a relationship to mark it as inactive
   */
  async deactivateRelationship(fromCiKey: number, toCiKey: number, relationshipType: string): Promise<void> {
    await this.query(
      `
      UPDATE cmdb.fact_ci_relationships
      SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
      WHERE from_ci_key = $1 AND to_ci_key = $2 AND relationship_type = $3 AND is_active = TRUE
      `,
      [fromCiKey, toCiKey, relationshipType]
    );
  }

  // ============================================
  // DATA MART - QUERY METHODS
  // ============================================

  /**
   * Get current CI inventory from the view
   */
  async getCurrentInventory(): Promise<CurrentCIInventoryRow[]> {
    const result = await this.query('SELECT * FROM cmdb.v_current_ci_inventory');
    return result.rows;
  }

  /**
   * Get CI discovery summary
   */
  async getDiscoverySummary(ciId?: string): Promise<CIDiscoverySummaryRow[]> {
    if (ciId) {
      const result = await this.query(
        'SELECT * FROM cmdb.v_ci_discovery_summary WHERE ci_id = $1',
        [ciId]
      );
      return result.rows;
    } else {
      const result = await this.query('SELECT * FROM cmdb.v_ci_discovery_summary');
      return result.rows;
    }
  }

  /**
   * Get CI change history
   */
  async getChangeHistory(ciId?: string, limit: number = 100): Promise<CIChangeHistoryRow[]> {
    if (ciId) {
      const result = await this.query(
        `
        SELECT * FROM cmdb.v_ci_change_history
        WHERE ci_id = $1
        ORDER BY changed_at DESC
        LIMIT $2
        `,
        [ciId, limit]
      );
      return result.rows;
    } else {
      const result = await this.query(
        `
        SELECT * FROM cmdb.v_ci_change_history
        ORDER BY changed_at DESC
        LIMIT $1
        `,
        [limit]
      );
      return result.rows;
    }
  }

  /**
   * Get CI relationships
   */
  async getCIRelationships(ciId: string): Promise<CIRelationshipRow[]> {
    const result = await this.query(
      `
      SELECT * FROM cmdb.v_ci_relationships
      WHERE from_ci_id = $1 OR to_ci_id = $1
      `,
      [ciId]
    );
    return result.rows;
  }
}

// Singleton
let postgresClient: PostgresClient | null = null;

export function getPostgresClient(): PostgresClient {
  if (!postgresClient) {
    postgresClient = new PostgresClient({
      _host: process.env['POSTGRES_HOST'] || 'localhost',
      _port: parseInt(process.env['POSTGRES_PORT'] || '5432'),
      _database: process.env['POSTGRES_DB'] || 'cmdb_datamart',
      _user: process.env['POSTGRES_USER'] || 'postgres',
      _password: process.env['POSTGRES_PASSWORD'] || 'password',
    });
  }
  return postgresClient;
}
