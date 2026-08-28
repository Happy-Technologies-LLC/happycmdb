// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * SQL Security Validators
 *
 * Provides validation functions to prevent SQL injection attacks
 * by whitelisting table names, column names, and other SQL identifiers
 * that cannot be safely parameterized.
 *
 * IMPORTANT: These validators should ONLY be used for identifiers (table names, column names)
 * that cannot be parameterized. All user data MUST use parameterized queries.
 */

/**
 * Valid PostgreSQL table names in the CMDB schema
 * Used to prevent SQL injection in dynamic table name operations
 */
export const VALID_TABLE_NAMES = [
  // Data mart tables (legacy unqualified names, retained for existing callers)
  'fact_ci_relationships',
  'fact_ci_changes',
  'fact_ci',
  'dim_ci',
  'dim_ci_type',
  'dim_environment',
  'dim_status',

  // Data mart tables (real schema-qualified names - see
  // packages/database/src/postgres/migrations/001_complete_schema.sql. Note there is no
  // `dim_date` or `fact_ci_discovery` table: the real names are cmdb.dim_time (unused by any
  // validated caller today) and cmdb.fact_discovery.)
  'cmdb.dim_ci',
  'cmdb.fact_discovery',
  'cmdb.fact_ci_relationships',
  'cmdb.fact_ci_changes',

  // Operational tables
  'credentials',
  'discovery_definitions',
  'discovery_jobs',
  'connector_configurations',
  'connector_run_history',
  'connector_registry_cache',
  'installed_connectors',
  'audit_log',
  'api_keys',

  // Test tables (only in test environments)
  'test_data',
] as const;

/**
 * Valid column names for sorting in CI queries
 */
export const VALID_CI_SORT_FIELDS = [
  'id',
  'name',
  'type',
  'status',
  'environment',
  'created_at',
  'updated_at',
  'discovered_at',
] as const;

/**
 * Valid column names for sorting in connector queries
 */
export const VALID_CONNECTOR_SORT_FIELDS = [
  'name',
  'connector_type',
  'created_at',
  'updated_at',
  'installed_at',
  'category',
] as const;

/**
 * Valid column names for sorting in connector configurations
 */
export const VALID_CONNECTOR_CONFIG_SORT_FIELDS = [
  'name',
  'created_at',
  'updated_at',
] as const;

/**
 * Valid column names for sorting in connector run history
 */
export const VALID_CONNECTOR_RUN_SORT_FIELDS = [
  'started_at',
  'completed_at',
  'duration_ms',
] as const;

/**
 * Valid sort directions
 */
export const VALID_SORT_DIRECTIONS = ['ASC', 'DESC'] as const;

/**
 * Validate table name against whitelist
 * @param tableName - Table name to validate
 * @returns Validated table name
 * @throws Error if table name is not in whitelist
 */
export function validateTableName(tableName: string): string {
  if (!VALID_TABLE_NAMES.includes(tableName as any)) {
    throw new Error(`Invalid table name: ${tableName}. Must be one of: ${VALID_TABLE_NAMES.join(', ')}`);
  }
  return tableName;
}

/**
 * Validate column name for CI sorting
 * @param columnName - Column name to validate
 * @returns Validated column name
 * @throws Error if column name is not in whitelist
 */
export function validateCISortField(columnName: string): string {
  if (!VALID_CI_SORT_FIELDS.includes(columnName as any)) {
    throw new Error(`Invalid sort field: ${columnName}. Must be one of: ${VALID_CI_SORT_FIELDS.join(', ')}`);
  }
  return columnName;
}

/**
 * Validate column name for connector sorting
 * @param columnName - Column name to validate
 * @returns Validated column name
 * @throws Error if column name is not in whitelist
 */
export function validateConnectorSortField(columnName: string): string {
  if (!VALID_CONNECTOR_SORT_FIELDS.includes(columnName as any)) {
    throw new Error(`Invalid sort field: ${columnName}. Must be one of: ${VALID_CONNECTOR_SORT_FIELDS.join(', ')}`);
  }
  return columnName;
}

/**
 * Validate column name for connector config sorting
 * @param columnName - Column name to validate
 * @returns Validated column name
 * @throws Error if column name is not in whitelist
 */
export function validateConnectorConfigSortField(columnName: string): string {
  if (!VALID_CONNECTOR_CONFIG_SORT_FIELDS.includes(columnName as any)) {
    throw new Error(`Invalid sort field: ${columnName}. Must be one of: ${VALID_CONNECTOR_CONFIG_SORT_FIELDS.join(', ')}`);
  }
  return columnName;
}

/**
 * Validate column name for connector run history sorting
 * @param columnName - Column name to validate
 * @returns Validated column name
 * @throws Error if column name is not in whitelist
 */
export function validateConnectorRunSortField(columnName: string): string {
  if (!VALID_CONNECTOR_RUN_SORT_FIELDS.includes(columnName as any)) {
    throw new Error(`Invalid sort field: ${columnName}. Must be one of: ${VALID_CONNECTOR_RUN_SORT_FIELDS.join(', ')}`);
  }
  return columnName;
}

/**
 * Validate sort direction
 * @param direction - Sort direction to validate
 * @returns Validated sort direction ('ASC' or 'DESC')
 * @throws Error if direction is invalid
 */
export function validateSortDirection(direction: string): 'ASC' | 'DESC' {
  const upperDirection = direction.toUpperCase();
  if (!VALID_SORT_DIRECTIONS.includes(upperDirection as any)) {
    throw new Error(`Invalid sort direction: ${direction}. Must be 'ASC' or 'DESC'`);
  }
  return upperDirection as 'ASC' | 'DESC';
}

/**
 * Validate multiple table names
 * @param tableNames - Array of table names to validate
 * @returns Array of validated table names
 * @throws Error if any table name is invalid
 */
export function validateTableNames(tableNames: string[]): string[] {
  return tableNames.map(validateTableName);
}

/**
 * Escape PostgreSQL identifier (table/column name)
 * This should ONLY be used as a last resort when whitelist validation is not possible
 * @param identifier - Identifier to escape
 * @returns Escaped identifier wrapped in double quotes
 */
export function escapePostgresIdentifier(identifier: string): string {
  // Replace double quotes with escaped double quotes
  const escaped = identifier.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * Check if string contains potential SQL injection patterns
 * This is a defense-in-depth measure, not a replacement for parameterized queries
 * @param input - String to check
 * @returns True if suspicious patterns detected
 */
export function containsSQLInjectionPatterns(input: string): boolean {
  const patterns = [
    /;/,                    // Statement terminator
    /--/,                   // SQL comment
    /\/\*/,                 // Multi-line comment start
    /\*\//,                 // Multi-line comment end
    /\bDROP\b/i,           // DROP statement
    /\bDELETE\b/i,         // DELETE statement
    /\bTRUNCATE\b/i,       // TRUNCATE statement
    /\bEXEC\b/i,           // EXEC statement
    /\bEXECUTE\b/i,        // EXECUTE statement
    /\bUNION\b/i,          // UNION operator
    /\bINSERT\b/i,         // INSERT statement
    /\bUPDATE\b/i,         // UPDATE statement
    /xp_cmdshell/i,        // SQL Server command execution
    /pg_sleep/i,           // PostgreSQL sleep (time-based injection)
  ];

  return patterns.some(pattern => pattern.test(input));
}
