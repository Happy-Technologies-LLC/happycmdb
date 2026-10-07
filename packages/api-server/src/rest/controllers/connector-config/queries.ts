// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Query builders for connector configuration operations
 */

import { validateConnectorConfigSortField, validateConnectorRunSortField, validateSortDirection } from '@cmdb/common';
import { connectorPredicate, PUBLIC_CONFIG, PUBLIC_RUN } from '../../../auth/connector-scope';

interface ListQueryParams {
  connector_type?: string;
  enabled?: string;
  schedule_enabled?: string;
  search?: string;
  sort_by: string;
  sort_order: string;
  limit: number;
  offset: number;
  organizationId: string | null;
  legacy: boolean;
}

interface RunsQueryParams {
  config_id?: string;
  connector_type?: string;
  resource_id?: string;
  status?: string;
  limit: number;
  offset: number;
  sort_by: string;
  sort_order: string;
  organizationId: string | null;
  legacy: boolean;
}

export function buildListQuery(params: ListQueryParams) {
  let query = `SELECT ${PUBLIC_CONFIG} FROM connector_configurations WHERE ${connectorPredicate('connector_configurations', 1)}`;
  const queryParams: unknown[] = [params.organizationId, params.legacy];
  let paramIndex = 3;

  if (params.connector_type) {
    query += ` AND connector_type = $${paramIndex++}`;
    queryParams.push(params.connector_type);
  }

  if (params.enabled !== undefined) {
    query += ` AND enabled = $${paramIndex++}`;
    queryParams.push(String(params.enabled) === 'true');
  }

  if (params.schedule_enabled !== undefined) {
    query += ` AND schedule_enabled = $${paramIndex++}`;
    queryParams.push(String(params.schedule_enabled) === 'true');
  }

  if (params.search) {
    query += ` AND (name ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`;
    queryParams.push(`%${params.search}%`);
    paramIndex++;
  }

  const countQuery = query.replace(`SELECT ${PUBLIC_CONFIG}`, 'SELECT COUNT(*)');
  const countParams = [...queryParams];

  // Validate sort parameters to prevent SQL injection
  const sortField = validateConnectorConfigSortField(params.sort_by || 'name');
  const sortDirection = validateSortDirection(params.sort_order || 'asc');

  // Safe to use template literals here because sortField and sortDirection are validated
  query += ` ORDER BY ${sortField} ${sortDirection} LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
  queryParams.push(params.limit, params.offset);

  return {
    query,
    params: queryParams,
    countQuery,
    countParams,
  };
}

export function buildRunsQuery(params: RunsQueryParams) {
  let query = `SELECT ${PUBLIC_RUN} FROM connector_run_history WHERE ${connectorPredicate('connector_run_history', 1)}`;
  const queryParams: unknown[] = [params.organizationId, params.legacy];
  let paramIndex = 3;

  if (params.config_id) {
    query += ` AND config_id = $${paramIndex++}`;
    queryParams.push(params.config_id);
  }

  if (params.connector_type) {
    query += ` AND connector_type = $${paramIndex++}`;
    queryParams.push(params.connector_type);
  }

  if (params.resource_id) {
    query += ` AND resource_id = $${paramIndex++}`;
    queryParams.push(params.resource_id);
  }

  if (params.status) {
    query += ` AND status = $${paramIndex++}`;
    queryParams.push(params.status);
  }

  const countQuery = query.replace(`SELECT ${PUBLIC_RUN}`, 'SELECT COUNT(*)');
  const countParams = [...queryParams];

  // Validate sort parameters to prevent SQL injection
  const sortField = validateConnectorRunSortField(params.sort_by || 'started_at');
  const sortDirection = validateSortDirection(params.sort_order || 'desc');

  // Safe to use template literals here because sortField and sortDirection are validated
  query += ` ORDER BY ${sortField} ${sortDirection} LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
  queryParams.push(params.limit, params.offset);

  return {
    query,
    params: queryParams,
    countQuery,
    countParams,
  };
}
