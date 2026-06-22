// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import {
  assertDescriptor,
  type AuthKind,
  type AuthSubstrate,
  type ConfigField,
  type ConfigFieldType,
  type ConnectorCategory,
  type ConnectorDescriptor,
  type ConnectorResource as CoreConnectorResource,
  type ResourceOperation as CoreResourceOperation,
} from '@happy-technologies/connector-core';

import type {
  ConnectorMetadata,
  ConnectorResource as CmdbConnectorResource,
} from './types/connector.types';

type JsonSchemaProperty = {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  format?: string;
  placeholder?: string;
};

type JsonSchemaObject = {
  required?: string[];
  properties?: Record<string, JsonSchemaProperty>;
};

type RawAuthField = {
  name?: string;
  key?: string;
  label?: string;
  type?: string;
  required?: boolean;
  description?: string;
  default?: unknown;
  placeholder?: string;
  options?: unknown[];
};

type RawAuthentication = {
  type?: string;
  methods?: string[];
  fields?: RawAuthField[];
  provider?: string;
  scopes?: string[];
  required?: boolean;
  envOnly?: boolean;
};

type ExtendedConnectorMetadata = ConnectorMetadata & {
  id?: string;
  connector_category?: string;
  icon?: string;
  logo_url?: string;
  tags?: string[];
  data_types?: string[];
  authentication?: RawAuthentication;
  provider?: string;
  protocol?: string;
  credential_affinity?: string;
};

type ExtendedConnectorResource = CmdbConnectorResource & {
  type?: string;
  display_name?: string;
  data_type?: string;
};

export interface UnsupportedDescriptorField {
  path: string;
  reason: string;
}

export interface ConnectorDescriptorMappingResult {
  descriptor: ConnectorDescriptor;
  unsupportedFields: UnsupportedDescriptorField[];
}

const CORE_OPERATIONS = new Set<CoreResourceOperation>([
  'extract',
  'transform',
  'load',
  'sync_to_source',
]);

const SECRET_KEY_PATTERN = /(password|secret|token|api[_-]?key|app[_-]?key|access[_-]?key)/i;
const CREDENTIAL_CONTEXT_KEY_PATTERN =
  /(username|email|client[_-]?id|tenant[_-]?id|access[_-]?key|api[_-]?key|token|secret|password)/i;

export function mapConnectorMetadataToDescriptor(
  metadata: ConnectorMetadata
): ConnectorDescriptorMappingResult {
  const source = metadata as ExtendedConnectorMetadata;
  const unsupportedFields: UnsupportedDescriptorField[] = [];
  const authMapping = mapAuthSubstrate(source, unsupportedFields);

  const descriptor: ConnectorDescriptor = {
    scheme: metadata.type,
    displayName: metadata.name,
    category: mapConnectorCategory(source.connector_category),
    icon: source.icon ?? source.logo_url ?? metadata.type,
    description: metadata.description,
    version: metadata.version,
    verified: Boolean(metadata.verified),
    status: metadata.verified ? 'available' : 'preview',
    auth: authMapping.auth,
    configFields: mapSchemaFields(
      metadata.configuration_schema as JsonSchemaObject | undefined,
      'configuration_schema',
      unsupportedFields,
      authMapping.credentialKeys
    ),
    resources: (metadata.resources ?? []).map((resource) =>
      mapConnectorResource(resource as ExtendedConnectorResource, unsupportedFields)
    ),
    governance: {
      defaultPolicy: 'cmdb-record-reconciliation',
      annotations: {
        cmdbCategory: source.connector_category ?? metadata.category,
        capabilities: metadata.capabilities,
        dataTypes: source.data_types ?? [],
        credentialAffinity: source.credential_affinity,
      },
    },
  };

  assertDescriptor(descriptor);
  return { descriptor, unsupportedFields };
}

function mapConnectorResource(
  resource: ExtendedConnectorResource,
  unsupportedFields: UnsupportedDescriptorField[]
): CoreConnectorResource {
  const resourcePath = `resources.${resource.id ?? resource.name ?? 'unknown'}`;
  const operations = (resource.operations ?? []).flatMap((operation) => {
    if (CORE_OPERATIONS.has(operation as CoreResourceOperation)) {
      return [operation as CoreResourceOperation];
    }
    unsupportedFields.push({
      path: `${resourcePath}.operations.${operation}`,
      reason: `operation '${operation}' is not part of connector-core 0.2.0`,
    });
    return [];
  });

  const mapped: CoreConnectorResource = {
    id: resource.id ?? resource.name,
    label: resource.display_name ?? resource.name,
    description: resource.description,
    enabledByDefault: resource.enabled_by_default ?? true,
    incremental: resource.extraction?.incremental ?? false,
  };

  if (operations.length > 0) {
    mapped.operations = operations;
  }

  const targetType = resource.ci_type ?? resource.data_type ?? resource.type;
  if (targetType !== null && targetType !== undefined && targetType !== '') {
    mapped.targetType = targetType;
  }

  if (resource.extraction?.depends_on !== undefined) {
    mapped.dependsOn = resource.extraction.depends_on;
  }

  const fieldMappings = mapFieldMappings(
    resource.field_mappings,
    resourcePath,
    unsupportedFields
  );
  if (fieldMappings !== undefined) {
    mapped.fieldMappings = fieldMappings;
  }

  if (resource.extraction?.batch_size !== undefined) {
    mapped.batchSize = resource.extraction.batch_size;
  }

  if (resource.extraction?.rate_limit !== undefined) {
    mapped.rateLimit = resource.extraction.rate_limit;
  }

  const configFields = mapSchemaFields(
    resource.configuration_schema as JsonSchemaObject | undefined,
    `${resourcePath}.configuration_schema`,
    unsupportedFields
  );
  if (configFields.length > 0) {
    mapped.configFields = configFields;
  }

  return mapped;
}

/**
 * connector-core `fieldMappings` is a flat Record<string, string>. CMDB
 * connectors are inconsistent: most use string values, but some (dell-emc) use a
 * richer object spec and others (veeam) embed numeric constants. Keep only the
 * string-to-string entries; report anything else with a precise reason rather
 * than emitting an invalid descriptor.
 */
function mapFieldMappings(
  value: unknown,
  resourcePath: string,
  unsupportedFields: UnsupportedDescriptorField[]
): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  const mapped: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') {
      mapped[key] = raw;
    } else {
      unsupportedFields.push({
        path: `${resourcePath}.fieldMappings.${key}`,
        reason: `field mapping value must be a string; got ${raw === null ? 'null' : typeof raw}`,
      });
    }
  }

  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function mapConnectorCategory(category: string | undefined): ConnectorCategory {
  switch (category) {
    case 'itsm':
    case 'ticketing':
      return 'itsm';
    default:
      return 'other';
  }
}

function mapAuthSubstrate(
  metadata: ExtendedConnectorMetadata,
  unsupportedFields: UnsupportedDescriptorField[]
): { auth: AuthSubstrate; credentialKeys: Set<string> } {
  const raw = metadata.authentication;
  const credentialKeys = new Set<string>();
  const explicitFields = mapAuthFields(raw?.fields ?? [], unsupportedFields);
  for (const field of explicitFields) {
    credentialKeys.add(field.key);
  }

  const implicitFields =
    explicitFields.length > 0
      ? []
      : extractImplicitCredentialFields(
          metadata.configuration_schema as JsonSchemaObject | undefined,
          unsupportedFields
        );
  for (const field of implicitFields) {
    credentialKeys.add(field.key);
  }

  const fields = explicitFields.length > 0 ? explicitFields : implicitFields;
  const methods = raw?.methods ?? (raw?.type !== undefined ? [raw.type] : []);
  const kind = inferAuthKind(methods, fields, raw?.required);
  const auth: AuthSubstrate = { kind };

  if (raw?.provider !== undefined) {
    auth.provider = raw.provider;
  } else if (kind === 'oauth2' || kind === 'oauth2_app') {
    auth.provider = methods[0] ?? metadata.provider ?? metadata.type;
  }

  if (raw?.scopes !== undefined) {
    auth.scopes = raw.scopes;
  }

  if (raw?.envOnly !== undefined) {
    auth.envOnly = raw.envOnly;
  }

  if (fields.length > 0) {
    auth.fields = fields;
  }

  return { auth, credentialKeys };
}

function inferAuthKind(methods: string[], fields: ConfigField[], required?: boolean): AuthKind {
  const normalized = methods.map((method) => method.toLowerCase());
  if (required === false && normalized.includes('none') && fields.length === 0) {
    return 'none';
  }
  if (normalized.some((method) => method.includes('oauth2_client') || method === 'oauth2_app')) {
    return 'oauth2_app';
  }
  if (normalized.some((method) => method === 'oauth2')) {
    return 'oauth2';
  }
  if (normalized.some((method) => method.includes('basic') || method === 'winrm')) {
    return 'basic';
  }
  if (normalized.some((method) => method.includes('api_key') || method.includes('api_token'))) {
    return fields.length <= 1 ? 'token' : 'basic';
  }
  if (fields.length === 0) {
    return 'none';
  }
  return fields.length === 1 ? 'token' : 'basic';
}

function mapAuthFields(
  fields: RawAuthField[],
  unsupportedFields: UnsupportedDescriptorField[]
): ConfigField[] {
  return fields.flatMap((field) => {
    const key = field.key ?? field.name;
    if (key === undefined || key === '') {
      unsupportedFields.push({
        path: 'authentication.fields',
        reason: 'credential field is missing a name/key',
      });
      return [];
    }
    return mapConfigField(
      key,
      {
        type: field.type,
        description: field.description,
        default: field.default,
        placeholder: field.placeholder,
        enum: normalizeOptions(field.options),
      },
      field.required === true,
      `authentication.fields.${key}`,
      unsupportedFields,
      field.label
    );
  });
}

function extractImplicitCredentialFields(
  schema: JsonSchemaObject | undefined,
  unsupportedFields: UnsupportedDescriptorField[]
): ConfigField[] {
  if (schema?.properties === undefined) {
    return [];
  }

  const required = new Set(schema.required ?? []);
  const credentialEntries = Object.entries(schema.properties).filter(([key]) =>
    isCredentialFieldKey(key)
  );

  return credentialEntries.flatMap(([key, property]) =>
    mapConfigField(
      key,
      property,
      required.has(key),
      `configuration_schema.properties.${key}`,
      unsupportedFields
    )
  );
}

function mapSchemaFields(
  schema: JsonSchemaObject | undefined,
  pathPrefix: string,
  unsupportedFields: UnsupportedDescriptorField[],
  omittedKeys: Set<string> = new Set()
): ConfigField[] {
  if (schema?.properties === undefined) {
    return [];
  }

  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).flatMap(([key, property]) => {
    if (omittedKeys.has(key)) {
      return [];
    }
    return mapConfigField(
      key,
      property,
      required.has(key),
      `${pathPrefix}.properties.${key}`,
      unsupportedFields
    );
  });
}

function mapConfigField(
  key: string,
  property: JsonSchemaProperty,
  required: boolean,
  path: string,
  unsupportedFields: UnsupportedDescriptorField[],
  label?: string
): ConfigField[] {
  const type = mapConfigFieldType(property);
  if (type === null) {
    unsupportedFields.push({
      path,
      reason: `field type '${property.type ?? 'unknown'}' cannot be represented as connector-core ConfigField`,
    });
    return [];
  }

  const field: ConfigField = {
    key,
    label: label ?? humanize(key),
    type,
  };

  if (required) {
    field.required = true;
  }
  if (property.description !== undefined) {
    field.hint = property.description;
  }
  if (property.placeholder !== undefined) {
    field.placeholder = property.placeholder;
  }
  if (type === 'select') {
    field.options = (property.enum ?? []).map((option) => String(option));
  }
  if (isSupportedDefault(property.default)) {
    field.default = property.default;
  } else if (property.default !== undefined) {
    unsupportedFields.push({
      path: `${path}.default`,
      reason: 'default value is not a string, number, or boolean',
    });
  }

  return [field];
}

function mapConfigFieldType(property: JsonSchemaProperty): ConfigFieldType | null {
  if (property.enum !== undefined) {
    return 'select';
  }

  switch (property.type) {
    case 'string':
    case 'text':
    case 'password':
      return 'text';
    case 'array':
      return 'list';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return null;
  }
}

function normalizeOptions(options: unknown[] | undefined): unknown[] | undefined {
  if (options === undefined) {
    return undefined;
  }
  return options.map((option) => {
    if (typeof option === 'object' && option !== null && 'value' in option) {
      // `in` narrowing already proved the property; option.value is unknown here.
      return option.value;
    }
    return option;
  });
}

function isCredentialFieldKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) || CREDENTIAL_CONTEXT_KEY_PATTERN.test(key);
}

function isSupportedDefault(value: unknown): value is string | number | boolean {
  return value === undefined || ['string', 'number', 'boolean'].includes(typeof value);
}

function humanize(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}
