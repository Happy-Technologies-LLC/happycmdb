// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Descriptor-mapper tests.
 *
 * Acceptance criterion from connector-core 0.2.0 AGENTS.md (HappyCMDB
 * integration): every existing `packages/connectors/*\/connector.json` must map
 * to a descriptor that validates against the canonical 0.2.0 schema, or report a
 * precise unsupported-field reason for anything that cannot be represented.
 */

import * as fs from 'fs';
import * as path from 'path';

import { validateDescriptor } from '@happy-technologies/connector-core';

import {
  mapConnectorMetadataToDescriptor,
  type UnsupportedDescriptorField,
} from '../../src/descriptor-mapper';
import type { ConnectorMetadata } from '../../src/types/connector.types';

const CONNECTORS_DIR = path.resolve(__dirname, '../../../connectors');

function loadConnectorJson(dir: string): ConnectorMetadata {
  const file = path.join(CONNECTORS_DIR, dir, 'connector.json');
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as ConnectorMetadata;
}

function listConnectorDirs(): string[] {
  return fs
    .readdirSync(CONNECTORS_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(CONNECTORS_DIR, entry.name, 'connector.json'))
    )
    .map((entry) => entry.name)
    .sort();
}

const connectorDirs = listConnectorDirs();

describe('mapConnectorMetadataToDescriptor', () => {
  it('discovers the connector catalog on disk', () => {
    // Guards against a path regression silently producing an empty test matrix.
    expect(connectorDirs.length).toBeGreaterThan(0);
  });

  describe.each(connectorDirs)('connector.json: %s', (dir) => {
    const metadata = loadConnectorJson(dir);
    const { descriptor, unsupportedFields } =
      mapConnectorMetadataToDescriptor(metadata);

    it('maps to a descriptor that validates against the 0.2.0 schema', () => {
      const result = validateDescriptor(descriptor);
      expect(result.ok ? [] : result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    });

    it('reports a precise reason for every unsupported field', () => {
      for (const field of unsupportedFields) {
        expect(field.path).toMatch(/\S/);
        expect(field.reason).toMatch(/\S/);
      }
    });

    it('preserves the connector identity on the descriptor', () => {
      expect(descriptor.scheme).toBe(metadata.type);
      expect(descriptor.displayName).toBe(metadata.name);
      expect(descriptor.version).toBe(metadata.version);
    });
  });
});

describe('descriptor mapping details', () => {
  function baseMetadata(overrides: Partial<ConnectorMetadata> = {}): ConnectorMetadata {
    return {
      type: 'demo',
      name: 'Demo Connector',
      version: '1.0.0',
      description: 'A demo connector',
      author: 'Test',
      verified: true,
      category: 'connector',
      resources: [],
      capabilities: {
        extraction: true,
        relationships: false,
        incremental: false,
        bidirectional: false,
      },
      configuration_schema: {},
      ...overrides,
    };
  }

  it('normalizes object-form select options to their values (the fixed read path)', () => {
    // A {label, value} option list, as Nutanix's prism_type uses. The mapper must
    // pull each option's `value`, not the wrapping object, into ConfigField.options.
    const metadata = baseMetadata({
      authentication: {
        required: true,
        methods: ['basic'],
        fields: [
          { name: 'username', label: 'Username', type: 'string', required: true },
          { name: 'password', label: 'Password', type: 'password', required: true },
          {
            name: 'mode',
            label: 'Mode',
            type: 'select',
            required: true,
            default: 'central',
            options: [
              { label: 'Central', value: 'central' },
              { label: 'Element', value: 'element' },
            ],
          },
        ],
      },
    } as Partial<ConnectorMetadata>);

    const { descriptor, unsupportedFields } =
      mapConnectorMetadataToDescriptor(metadata);

    const modeField = descriptor.auth.fields?.find((field) => field.key === 'mode');
    expect(modeField).toBeDefined();
    expect(modeField?.type).toBe('select');
    expect(modeField?.options).toEqual(['central', 'element']);
    expect(unsupportedFields).toEqual([]);
    expect(validateDescriptor(descriptor).ok).toBe(true);
  });

  it('keeps plain-string select options unchanged', () => {
    const metadata = baseMetadata({
      authentication: {
        required: true,
        methods: ['basic'],
        fields: [
          { name: 'username', type: 'string', required: true },
          { name: 'password', type: 'password', required: true },
          {
            name: 'region',
            type: 'select',
            required: false,
            options: ['us', 'eu'],
          },
        ],
      },
    } as Partial<ConnectorMetadata>);

    const { descriptor } = mapConnectorMetadataToDescriptor(metadata);
    const region = descriptor.auth.fields?.find((field) => field.key === 'region');
    expect(region?.options).toEqual(['us', 'eu']);
  });

  it('drops an object-typed config property and reports a precise reason', () => {
    const metadata = baseMetadata({
      configuration_schema: {
        required: ['endpoint'],
        properties: {
          endpoint: { type: 'string' },
          // Object-typed resource toggles (as crowdstrike/wiz use) have no
          // ConfigField representation and must be reported, not silently kept.
          devices: { type: 'object' },
        },
      },
    } as Partial<ConnectorMetadata>);

    const { descriptor, unsupportedFields } =
      mapConnectorMetadataToDescriptor(metadata);

    expect(descriptor.configFields.map((field) => field.key)).toEqual(['endpoint']);
    const reported = unsupportedFields.find((field: UnsupportedDescriptorField) =>
      field.path.endsWith('devices')
    );
    expect(reported).toBeDefined();
    expect(reported?.reason).toContain('object');
    expect(validateDescriptor(descriptor).ok).toBe(true);
  });

  it('infers oauth2_app for client-credentials methods', () => {
    const metadata = baseMetadata({
      authentication: {
        required: true,
        methods: ['oauth2_client_credentials'],
        fields: [
          { name: 'client_id', type: 'string', required: true },
          { name: 'client_secret', type: 'string', required: true },
        ],
      },
    } as Partial<ConnectorMetadata>);

    const { descriptor } = mapConnectorMetadataToDescriptor(metadata);
    expect(descriptor.auth.kind).toBe('oauth2_app');
    expect(descriptor.auth.provider).toBe('oauth2_client_credentials');
  });

  it('infers a token kind for a single api-key credential', () => {
    const metadata = baseMetadata({
      authentication: {
        required: true,
        methods: ['api_key'],
        fields: [{ name: 'api_key', type: 'string', required: true }],
      },
    } as Partial<ConnectorMetadata>);

    const { descriptor } = mapConnectorMetadataToDescriptor(metadata);
    expect(descriptor.auth.kind).toBe('token');
  });

  it('falls back to implicit credential detection when no auth block is declared', () => {
    const metadata = baseMetadata({
      configuration_schema: {
        required: ['instance_url', 'username', 'password'],
        properties: {
          instance_url: { type: 'string' },
          username: { type: 'string' },
          password: { type: 'string', format: 'password' },
          sync_direction: { type: 'string', enum: ['import', 'export'] },
        },
      },
    } as Partial<ConnectorMetadata>);

    const { descriptor } = mapConnectorMetadataToDescriptor(metadata);
    // username + password are credential fields → multi-field basic auth.
    expect(descriptor.auth.kind).toBe('basic');
    const credentialKeys = (descriptor.auth.fields ?? []).map((field) => field.key);
    expect(credentialKeys).toEqual(expect.arrayContaining(['username', 'password']));
    // Credential fields are not duplicated into the non-secret config fields.
    expect(descriptor.configFields.map((field) => field.key)).not.toContain('password');
  });
});
