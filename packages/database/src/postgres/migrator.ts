// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * PostgreSQL Migration Runner
 *
 * This module provides functionality to manage and execute database migrations
 * for the PostgreSQL data mart.
 *
 * Features:
 * - Automatic migration file discovery
 * - Migration tracking via schema_migrations table
 * - Transaction-based execution with automatic rollback
 * - Checksum validation to detect modified migrations
 * - Idempotent execution (safe to run multiple times)
 * - Migration status reporting
 */

import { PostgresClient } from './client';
import { logger } from '@cmdb/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Migration status information
 */
export interface MigrationStatus {
  _name: string;
  _applied: boolean;
  _appliedAt: Date | null;
}


/**
 * Run all pending migrations
 *
 * Discovers migration files, checks which have been applied, and executes
 * pending migrations in order within transactions.
 *
 * @param client - PostgreSQL client instance
 * @param migrationsDir - Optional custom migrations directory
 * @throws Error if migration fails or checksum mismatch detected
 */
export async function runMigrations(
  client: PostgresClient,
  migrationsDir?: string
): Promise<void> {
  try {
    // Ensure schema_migrations table exists
    await ensureMigrationsTable(client);

    // Discover migration files
    const migrationFiles = discoverMigrations(migrationsDir);

    if (migrationFiles.length === 0) {
      logger.info('No migration files found');
      return;
    }

    logger.info(`Found ${migrationFiles.length} migration files`);

    // Get already applied migrations
    const appliedMigrations = await getAppliedMigrations(client);
    const appliedMap = new Map(
      appliedMigrations.map((m) => [m.migration_name, m.checksum])
    );

    // Execute pending migrations
    let executedCount = 0;

    for (const migrationFile of migrationFiles) {
      const migrationName = path.basename(migrationFile);
      const migrationSQL = fs.readFileSync(migrationFile, 'utf-8');
      const checksum = calculateChecksum(migrationSQL);

      // Check if migration was already applied
      if (appliedMap.has(migrationName)) {
        const existingChecksum = appliedMap.get(migrationName);

        // Verify checksum matches
        if (existingChecksum !== checksum) {
          throw new Error(
            `Migration checksum mismatch for ${migrationName}. ` +
              `Migration file has been modified after being applied. ` +
              `This is not allowed. Expected: ${existingChecksum}, Got: ${checksum}`
          );
        }

        logger.debug(`Skipping already applied migration: ${migrationName}`);
        continue;
      }

      // Execute migration in transaction
      logger.info(`Executing migration: ${migrationName}`);
      await executeMigration(client, migrationName, migrationSQL, checksum);
      executedCount++;
      logger.info(`Migration completed: ${migrationName}`);
    }


    if (executedCount === 0) {
      logger.info('All migrations already applied - database is up to date');
    } else {
      logger.info(`Successfully executed ${executedCount} migrations`);
    }
  } catch (error) {
    logger.error('Migration failed', error);
    throw error;
  }
}

/**
 * Get migration status for all discovered migrations
 *
 * @param client - PostgreSQL client instance
 * @param migrationsDir - Optional custom migrations directory
 * @returns Array of migration statuses
 */
export async function getMigrationStatus(
  client: PostgresClient,
  migrationsDir?: string
): Promise<MigrationStatus[]> {
  await ensureMigrationsTable(client);

  const migrationFiles = discoverMigrations(migrationsDir);
  const appliedMigrations = await getAppliedMigrations(client);
  const appliedMap = new Map(
    appliedMigrations.map((m) => [m.migration_name, m.applied_at])
  );

  return migrationFiles.map((file) => {
    const name = path.basename(file);
    const applied = appliedMap.has(name);
    const appliedAt = appliedMap.get(name) || null;

    return {
      _name: name,
      _applied: applied,
      _appliedAt: appliedAt,
    };
  });
}

/**
 * Ensure schema_migrations table exists
 *
 * Creates the table if it doesn't exist to track applied migrations.
 *
 * @param client - PostgreSQL client instance
 */
async function ensureMigrationsTable(client: PostgresClient): Promise<void> {
  const createTableSQL = `
    CREATE SCHEMA IF NOT EXISTS cmdb;

    CREATE TABLE IF NOT EXISTS cmdb.schema_migrations (
      migration_name VARCHAR(255) PRIMARY KEY,
      checksum VARCHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at
    ON cmdb.schema_migrations(applied_at);
  `;

  await client.query(createTableSQL);
}

/**
 * Discover migration files in directory
 *
 * Finds all .sql files in the migrations directory and sorts them
 * alphabetically (ensuring correct execution order).
 *
 * @param migrationsDir - Optional custom migrations directory
 * @returns Sorted array of migration file paths
 */
function discoverMigrations(migrationsDir?: string): string[] {
  const defaultDir = path.resolve(__dirname, 'migrations');
  const dir = migrationsDir || defaultDir;

  if (!fs.existsSync(dir)) {
    throw new Error(`Migrations directory not found at: ${dir}`);
  }

  const files = fs.readdirSync(dir);

  const migrationFiles = files
    .filter((file) => file.endsWith('.sql'))
    .sort() // Alphabetical sort ensures correct order (001_, 002_, etc.)
    .map((file) => path.join(dir, file));

  return migrationFiles;
}

/**
 * Get list of already applied migrations
 *
 * @param client - PostgreSQL client instance
 * @returns Array of applied migration records
 */
async function getAppliedMigrations(
  client: PostgresClient
): Promise<Array<{ migration_name: string; checksum: string; applied_at: Date }>> {
  const result = await client.query(`
    SELECT migration_name, checksum, applied_at
    FROM cmdb.schema_migrations
    ORDER BY applied_at ASC
  `);

  return result.rows;
}

/**
 * Execute a migration within a transaction
 *
 * Runs the migration SQL and records it in schema_migrations table.
 * If any error occurs, the entire transaction is rolled back.
 *
 * @param client - PostgreSQL client instance
 * @param migrationName - Name of the migration file
 * @param migrationSQL - SQL content to execute
 * @param checksum - SHA-256 checksum of the migration
 */
async function executeMigration(
  client: PostgresClient,
  migrationName: string,
  migrationSQL: string,
  checksum: string
): Promise<void> {
  await client.transaction(async (txClient) => {
    // Execute migration SQL
    await txClient.query(migrationSQL);

    // Record migration in tracking table
    await txClient.query(
      `
      INSERT INTO cmdb.schema_migrations (migration_name, checksum)
      VALUES ($1, $2)
      `,
      [migrationName, checksum]
    );
  });
}

/**
 * Calculate SHA-256 checksum of migration content
 *
 * Used to detect if a migration file has been modified after being applied.
 *
 * @param content - Migration SQL content
 * @returns Hex-encoded SHA-256 hash
 */
function calculateChecksum(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
