// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Public connector templates include field definitions, not stored defaults or configuration values. */
export function publicInstalledConnector(row: Record<string, any>): Record<string, any> {
  const schema = row.configuration_schema;
  const properties: Record<string, unknown> = {};
  if (schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object') {
    for (const [name, raw] of Object.entries(schema.properties)) {
      if (!raw || typeof raw !== 'object') continue;
      const field = raw as Record<string, unknown>;
      properties[name] = {
        type: field['type'], title: field['title'], description: field['description'],
        format: field['format'], required: field['required'] === true ||
          (Array.isArray(schema.required) && schema.required.includes(name)),
        enum: Array.isArray(field['enum']) ? field['enum'] : undefined,
      };
    }
  }
  const resources: Record<string, unknown>[] = [];
  if (Array.isArray(row.resources)) {
    for (const raw of row.resources) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const resource = raw as Record<string, unknown>;
      if (typeof resource['id'] !== 'string' || typeof resource['name'] !== 'string') continue;
      const fieldMappings: Record<string, string> = {};
      const mappings = resource['field_mappings'];
      if (mappings && typeof mappings === 'object' && !Array.isArray(mappings)) {
        for (const [key, value] of Object.entries(mappings)) {
          if (typeof value === 'string') fieldMappings[key] = value;
        }
      }
      resources.push({
        id: resource['id'], name: resource['name'],
        description: typeof resource['description'] === 'string' ? resource['description'] : '',
        ci_type: typeof resource['ci_type'] === 'string' ? resource['ci_type'] : null,
        enabled_by_default: resource['enabled_by_default'] !== false,
        field_mappings: fieldMappings,
      });
    }
  }
  return {
    ...row,
    resources,
    metadata: { resources },
    configuration_schema: { properties },
  };
}

/** GraphQL's camel-case installed connector representation uses the same safe template. */
export function publicInstalledConnectorGraphQL(row: Record<string, any>): Record<string, any> {
  const safe = publicInstalledConnector(row);
  return {
    id: row.id,
    connectorType: row.connector_type,
    category: row.category.toUpperCase(),
    name: row.name,
    description: row.description,
    installedVersion: row.installed_version,
    latestAvailableVersion: row.latest_available_version,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    enabled: row.enabled,
    verified: row.verified,
    installPath: row.install_path,
    metadata: safe.metadata,
    capabilities: row.capabilities || { extraction: false, relationships: false, incremental: false, bidirectional: false },
    resources: safe.resources,
    configurationSchema: safe.configuration_schema,
    totalRuns: row.total_runs,
    successfulRuns: row.successful_runs,
    failedRuns: row.failed_runs,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    tags: row.tags || [],
  };
}
