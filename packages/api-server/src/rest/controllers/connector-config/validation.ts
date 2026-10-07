// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation logic for connector configuration operations
 */
import { PUBLIC_CONFIG } from '../../../auth/connector-scope';
import { connectorJsonMerge } from '../../../services/connector-json-merge';

export function validateConfiguration(config: any): string | null {
  if (!config.name) {
    return 'Configuration name is required';
  }

  if (!config.connector_type) {
    return 'Connector type is required';
  }

  if (!config.connection) {
    return 'Connection configuration is required';
  }

  return null;
}

export function buildUpdateQuery(id: string, updates: Record<string, unknown>, scope: [string | null, boolean]): { query: string | null; values: unknown[] } {
  const fields: string[] = [];
  const values: unknown[] = [];

  const allowedFields = [
    'name', 'description', 'enabled', 'schedule', 'schedule_enabled',
    'connection', 'options', 'enabled_resources', 'resource_configs',
    'max_retries', 'retry_delay_seconds', 'continue_on_error',
    'notification_channels', 'notification_on_success', 'notification_on_failure'
  ];

  for (const field of allowedFields) {
    if (updates[field] === undefined) continue;
    if (['connection', 'options'].includes(field) && updates[field] !== null &&
      typeof updates[field] === 'object' && Object.keys(updates[field] as object).length === 0) continue;
    if (['connection', 'options', 'resource_configs'].includes(field)) {
      fields.push(`${field} = ${connectorJsonMerge(field, updates[field], values)}`);
    } else {
      values.push(updates[field]);
      fields.push(`${field} = $${values.length}`);
    }
  }

  if (fields.length === 0) {
    return { query: null, values: [] };
  }

  fields.push(`updated_at = NOW()`);
  const idParam = values.length + 1;
  values.push(id, ...scope);

  const query = `UPDATE connector_configurations SET ${fields.join(', ')}
    WHERE id = $${idParam} AND (organization_id = $${idParam + 1}
      OR (organization_id IS NULL AND $${idParam + 2}::boolean))
    RETURNING ${PUBLIC_CONFIG}`;

  return { query, values };
}
