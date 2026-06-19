// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ConnectorRegistry Tests
 *
 * Tests for ConnectorRegistry including:
 * - Connector discovery and loading
 * - Connector registration
 * - Metadata parsing and validation
 * - Resource schema validation
 * - Database integration for installed connectors
 */

import { ConnectorRegistry } from '../../src/registry/connector-registry';
import { BaseIntegrationConnector } from '../../src/core/base-connector';
import { getPostgresClient } from '@cmdb/database';
import * as fs from 'fs';
import * as path from 'path';
import {
  ConnectorMetadata,
  ConnectorConfiguration,
  ConnectorResource,
  InstalledConnector,
} from '../../src/types/connector.types';

// Mock dependencies
jest.mock('@cmdb/database');
jest.mock('@cmdb/common', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.mock('fs');
jest.mock('path');

describe('ConnectorRegistry', () => {
  let registry: ConnectorRegistry;
  let mockPostgresClient: any;
  let mockFsExistsSync: jest.Mock;
  let mockFsReaddirSync: jest.Mock;
  let mockFsReadFileSync: jest.Mock;

  // Sample connector metadata
  const sampleMetadata: ConnectorMetadata = {
    type: 'test-connector',
    name: 'Test Connector',
    version: '1.0.0',
    description: 'Test connector for unit tests',
    author: 'Test Author',
    verified: true,
    category: 'connector',
    resources: [
      {
        id: 'servers',
        name: 'Servers',
        description: 'Server resources',
        ci_type: 'server',
        operations: ['extract', 'transform'],
        enabled_by_default: true,
        configuration_schema: {
          required: ['region'],
          properties: {
            region: { type: 'string' },
          },
        },
        field_mappings: {
          name: '$.name',
          status: '$.state',
        },
      },
      {
        id: 'databases',
        name: 'Databases',
        description: 'Database resources',
        ci_type: 'database',
        operations: ['extract', 'transform'],
        enabled_by_default: false,
        extraction: {
          incremental: true,
          batch_size: 100,
          depends_on: ['servers'],
        },
      },
    ],
    capabilities: {
      extraction: true,
      relationships: true,
      incremental: true,
      bidirectional: false,
    },
    configuration_schema: {
      required: ['api_key'],
      properties: {
        api_key: { type: 'string' },
        base_url: { type: 'string' },
      },
    },
  };

  // Mock connector class
  class MockConnector extends BaseIntegrationConnector {
    async initialize(): Promise<void> {}
    async testConnection() {
      return { success: true };
    }
    async extractResource() {
      return [];
    }
    async extractRelationships() {
      return [];
    }
    async transformResource() {
      return {
        name: 'test',
        ci_type: 'server',
        attributes: {},
        identifiers: {},
        source: 'test',
        source_id: 'test-1',
        confidence_score: 1.0,
      };
    }
    extractIdentifiers() {
      return {};
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock PostgreSQL client
    mockPostgresClient = {
      query: jest.fn(),
    };
    (getPostgresClient as jest.Mock).mockReturnValue(mockPostgresClient);

    // Mock fs functions
    mockFsExistsSync = fs.existsSync as jest.Mock;
    mockFsReaddirSync = fs.readdirSync as jest.Mock;
    mockFsReadFileSync = fs.readFileSync as jest.Mock;

    // Get fresh instance for each test
    registry = ConnectorRegistry.getInstance();
  });

  afterEach(() => {
    // Reset singleton instance for clean tests
    (ConnectorRegistry as any).instance = null;
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = ConnectorRegistry.getInstance();
      const instance2 = ConnectorRegistry.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe('discoverConnectors', () => {
    it('should discover and load connectors from directory', async () => {
      const connectorsPath = '/opt/cmdb/connectors';

      mockFsExistsSync.mockReturnValue(true);
      mockFsReaddirSync.mockReturnValue([
        { name: 'test-connector', isDirectory: () => true },
        { name: 'file.txt', isDirectory: () => false },
      ]);

      // Mock connector files
      mockFsReadFileSync.mockReturnValue(JSON.stringify(sampleMetadata));

      // Mock dynamic import
      jest.doMock(
        path.join(connectorsPath, 'test-connector', 'dist', 'index.js'),
        () => ({ default: MockConnector }),
        { virtual: true }
      );

      await registry.discoverConnectors(connectorsPath);

      expect(mockFsReaddirSync).toHaveBeenCalledWith(connectorsPath, {
        withFileTypes: true,
      });
      expect(registry.hasConnectorType('test-connector')).toBe(true);
    });

    it('should handle missing connectors directory', async () => {
      mockFsExistsSync.mockReturnValue(false);

      await registry.discoverConnectors('/nonexistent');

      expect(mockFsReaddirSync).not.toHaveBeenCalled();
    });

    it('should skip connectors without connector.json', async () => {
      mockFsExistsSync
        .mockReturnValueOnce(true) // Directory exists
        .mockReturnValueOnce(false); // connector.json doesn't exist

      mockFsReaddirSync.mockReturnValue([
        { name: 'incomplete-connector', isDirectory: () => true },
      ]);

      await registry.discoverConnectors('/opt/cmdb/connectors');

      expect(registry.hasConnectorType('incomplete-connector')).toBe(false);
    });

    it('should skip connectors without compiled code', async () => {
      mockFsExistsSync
        .mockReturnValueOnce(true) // Directory exists
        .mockReturnValueOnce(true) // connector.json exists
        .mockReturnValueOnce(false); // dist/index.js doesn't exist

      mockFsReaddirSync.mockReturnValue([
        { name: 'unbuilt-connector', isDirectory: () => true },
      ]);
      mockFsReadFileSync.mockReturnValue(JSON.stringify(sampleMetadata));

      await registry.discoverConnectors('/opt/cmdb/connectors');

      expect(registry.hasConnectorType('unbuilt-connector')).toBe(false);
    });

    it('should handle connector loading errors gracefully', async () => {
      mockFsExistsSync.mockReturnValue(true);
      mockFsReaddirSync.mockReturnValue([
        { name: 'error-connector', isDirectory: () => true },
      ]);
      mockFsReadFileSync.mockImplementation(() => {
        throw new Error('Failed to read file');
      });

      await registry.discoverConnectors('/opt/cmdb/connectors');

      // Should not throw and continue with other connectors
      expect(registry.hasConnectorType('error-connector')).toBe(false);
    });
  });

  describe('registerConnector', () => {
    it('should register connector programmatically', () => {
      registry.registerConnector(sampleMetadata, MockConnector as any);

      expect(registry.hasConnectorType('test-connector')).toBe(true);
      expect(registry.getConnectorMetadata('test-connector')).toEqual(
        sampleMetadata
      );
    });

    it('should allow re-registration of connector', () => {
      registry.registerConnector(sampleMetadata, MockConnector as any);

      const updatedMetadata = { ...sampleMetadata, version: '2.0.0' };
      registry.registerConnector(updatedMetadata, MockConnector as any);

      expect(registry.getConnectorMetadata('test-connector')?.version).toBe(
        '2.0.0'
      );
    });
  });

  describe('createConnector', () => {
    it('should create connector instance with valid configuration', () => {
      registry.registerConnector(sampleMetadata, MockConnector as any);

      const config: ConnectorConfiguration = {
        name: 'test-instance',
        type: 'test-connector',
        enabled: true,
        connection: { api_key: 'test-key' },
      };

      const connector = registry.createConnector(config);

      expect(connector).toBeInstanceOf(MockConnector);
      expect(connector.getConfig()).toEqual(config);
    });

    it('should throw error for unknown connector type', () => {
      const config: ConnectorConfiguration = {
        name: 'test-instance',
        type: 'unknown-connector',
        enabled: true,
        connection: {},
      };

      expect(() => registry.createConnector(config)).toThrow(
        'Unknown connector type: unknown-connector'
      );
    });

    it('should throw error if metadata not found', () => {
      // Register connector class but not metadata (edge case)
      (registry as any).connectorClasses.set('partial-connector', MockConnector);

      const config: ConnectorConfiguration = {
        name: 'test-instance',
        type: 'partial-connector',
        enabled: true,
        connection: {},
      };

      expect(() => registry.createConnector(config)).toThrow(
        'Connector metadata not found: partial-connector'
      );
    });
  });

  describe('getConnectorMetadata', () => {
    it('should return metadata for registered connector', () => {
      registry.registerConnector(sampleMetadata, MockConnector as any);

      const metadata = registry.getConnectorMetadata('test-connector');

      expect(metadata).toEqual(sampleMetadata);
    });

    it('should return undefined for unknown connector', () => {
      const metadata = registry.getConnectorMetadata('unknown');

      expect(metadata).toBeUndefined();
    });
  });

  describe('getAllConnectorTypes', () => {
    it('should return all registered connector types', () => {
      const metadata1: ConnectorMetadata = {
        ...sampleMetadata,
        type: 'connector-1',
      };
      const metadata2: ConnectorMetadata = {
        ...sampleMetadata,
        type: 'connector-2',
      };

      registry.registerConnector(metadata1, MockConnector as any);
      registry.registerConnector(metadata2, MockConnector as any);

      const types = registry.getAllConnectorTypes();

      expect(types).toHaveLength(2);
      expect(types.map((m) => m.type)).toContain('connector-1');
      expect(types.map((m) => m.type)).toContain('connector-2');
    });

    it('should return empty array when no connectors registered', () => {
      const types = registry.getAllConnectorTypes();

      expect(types).toEqual([]);
    });
  });

  describe('hasConnectorType', () => {
    it('should return true for registered connector', () => {
      registry.registerConnector(sampleMetadata, MockConnector as any);

      expect(registry.hasConnectorType('test-connector')).toBe(true);
    });

    it('should return false for unknown connector', () => {
      expect(registry.hasConnectorType('unknown')).toBe(false);
    });
  });

  describe('getAvailableResources', () => {
    it('should return resources for registered connector', () => {
      registry.registerConnector(sampleMetadata, MockConnector as any);

      const resources = registry.getAvailableResources('test-connector');

      expect(resources).toHaveLength(2);
      expect(resources.map((r) => r.id)).toContain('servers');
      expect(resources.map((r) => r.id)).toContain('databases');
    });

    it('should return empty array for unknown connector', () => {
      const resources = registry.getAvailableResources('unknown');

      expect(resources).toEqual([]);
    });
  });

  describe('getResourceSchema', () => {
    it('should return resource schema', () => {
      registry.registerConnector(sampleMetadata, MockConnector as any);

      const schema = registry.getResourceSchema('test-connector', 'servers');

      expect(schema).toEqual({
        required: ['region'],
        properties: {
          region: { type: 'string' },
        },
      });
    });

    it('should return undefined for unknown connector', () => {
      const schema = registry.getResourceSchema('unknown', 'servers');

      expect(schema).toBeUndefined();
    });

    it('should return undefined for unknown resource', () => {
      registry.registerConnector(sampleMetadata, MockConnector as any);

      const schema = registry.getResourceSchema('test-connector', 'unknown');

      expect(schema).toBeUndefined();
    });

    it('should return undefined for resource without schema', () => {
      registry.registerConnector(sampleMetadata, MockConnector as any);

      const schema = registry.getResourceSchema('test-connector', 'databases');

      expect(schema).toBeUndefined();
    });
  });

  describe('validateResourceConfig', () => {
    beforeEach(() => {
      registry.registerConnector(sampleMetadata, MockConnector as any);
    });

    it('should validate config against resource schema', () => {
      const config = { region: 'us-east-1' };

      const result = registry.validateResourceConfig(
        'test-connector',
        'servers',
        config
      );

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should detect missing required fields', () => {
      const config = {}; // Missing required 'region'

      const result = registry.validateResourceConfig(
        'test-connector',
        'servers',
        config
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: region');
    });

    it('should return valid when no schema defined', () => {
      const config = { any: 'value' };

      const result = registry.validateResourceConfig(
        'test-connector',
        'databases',
        config
      );

      expect(result.valid).toBe(true);
    });

    it('should return valid for unknown resource', () => {
      const result = registry.validateResourceConfig(
        'test-connector',
        'unknown',
        {}
      );

      expect(result.valid).toBe(true);
    });
  });

  describe('Database Integration', () => {
    const installedConnector: InstalledConnector = {
      connector_type: 'test-connector',
      version: '1.0.0',
      installed_at: new Date('2025-01-15'),
      metadata: sampleMetadata,
      install_path: '/opt/cmdb/connectors/test-connector',
    };

    describe('loadInstalledConnectors', () => {
      it('should load installed connectors from database', async () => {
        mockPostgresClient.query.mockResolvedValue({
          rows: [
            {
              connector_type: 'test-connector',
              version: '1.0.0',
              installed_at: new Date('2025-01-15'),
              metadata: sampleMetadata,
              install_path: '/opt/cmdb/connectors/test-connector',
              checksum: 'abc123',
            },
          ],
        });

        mockFsExistsSync.mockReturnValue(true);

        // Mock dynamic import
        jest.doMock(
          '/opt/cmdb/connectors/test-connector/dist/index.js',
          () => ({ default: MockConnector }),
          { virtual: true }
        );

        await registry.loadInstalledConnectors();

        expect(mockPostgresClient.query).toHaveBeenCalledWith(
          'SELECT * FROM installed_connectors ORDER BY installed_at DESC'
        );
      });

      it('should handle connectors with missing implementation', async () => {
        mockPostgresClient.query.mockResolvedValue({
          rows: [
            {
              connector_type: 'test-connector',
              version: '1.0.0',
              metadata: sampleMetadata,
              install_path: '/opt/cmdb/connectors/test-connector',
            },
          ],
        });

        mockFsExistsSync.mockReturnValue(false); // Implementation doesn't exist

        await registry.loadInstalledConnectors();

        // Should not crash and log warning
        expect(registry.hasConnectorType('test-connector')).toBe(false);
      });

      it('should handle database query errors', async () => {
        mockPostgresClient.query.mockRejectedValue(
          new Error('Database connection failed')
        );

        await registry.loadInstalledConnectors();

        // Should not throw and log error
        expect(registry.getAllConnectorTypes()).toEqual([]);
      });
    });

    describe('getInstalledConnector', () => {
      it('should retrieve installed connector record', async () => {
        mockPostgresClient.query.mockResolvedValue({
          rows: [
            {
              connector_type: 'test-connector',
              installed_version: '1.0.0',
              installed_at: new Date('2025-01-15'),
              metadata: sampleMetadata,
              install_path: '/opt/cmdb/connectors/test-connector',
            },
          ],
        });

        const connector = await registry.getInstalledConnector('test-connector');

        expect(connector).toEqual(installedConnector);
        expect(mockPostgresClient.query).toHaveBeenCalledWith(
          'SELECT * FROM installed_connectors WHERE connector_type = $1',
          ['test-connector']
        );
      });

      it('should return null when connector not found', async () => {
        mockPostgresClient.query.mockResolvedValue({ rows: [] });

        const connector = await registry.getInstalledConnector('unknown');

        expect(connector).toBeNull();
      });

      it('should handle database errors gracefully', async () => {
        mockPostgresClient.query.mockRejectedValue(new Error('DB error'));

        const connector = await registry.getInstalledConnector('test-connector');

        expect(connector).toBeNull();
      });
    });

    describe('saveInstalledConnector', () => {
      it('should save connector to database', async () => {
        mockPostgresClient.query.mockResolvedValue({});

        await registry.saveInstalledConnector(installedConnector);

        expect(mockPostgresClient.query).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO installed_connectors'),
          [
            'test-connector',
            'connector',
            'Test Connector',
            '1.0.0',
            JSON.stringify(sampleMetadata),
            '/opt/cmdb/connectors/test-connector',
            installedConnector.installed_at,
          ]
        );
      });

      it('should update existing connector on conflict', async () => {
        mockPostgresClient.query.mockResolvedValue({});

        await registry.saveInstalledConnector(installedConnector);

        const sql = mockPostgresClient.query.mock.calls[0][0];
        expect(sql).toContain('ON CONFLICT (connector_type)');
        expect(sql).toContain('DO UPDATE SET');
      });

      it('should throw error on database failure', async () => {
        mockPostgresClient.query.mockRejectedValue(
          new Error('Insert failed')
        );

        await expect(
          registry.saveInstalledConnector(installedConnector)
        ).rejects.toThrow('Insert failed');
      });
    });

    describe('removeInstalledConnector', () => {
      it('should remove connector from database', async () => {
        mockPostgresClient.query.mockResolvedValue({});

        await registry.removeInstalledConnector('test-connector');

        expect(mockPostgresClient.query).toHaveBeenCalledWith(
          'DELETE FROM installed_connectors WHERE connector_type = $1',
          ['test-connector']
        );
      });

      it('should throw error on database failure', async () => {
        mockPostgresClient.query.mockRejectedValue(new Error('Delete failed'));

        await expect(
          registry.removeInstalledConnector('test-connector')
        ).rejects.toThrow('Delete failed');
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle connector with no resources', () => {
      const noResourcesMetadata: ConnectorMetadata = {
        ...sampleMetadata,
        resources: [],
      };

      registry.registerConnector(noResourcesMetadata, MockConnector as any);

      expect(registry.getAvailableResources('test-connector')).toEqual([]);
    });

    it('should handle connector with malformed metadata', () => {
      mockFsExistsSync.mockReturnValue(true);
      mockFsReaddirSync.mockReturnValue([
        { name: 'malformed', isDirectory: () => true },
      ]);
      mockFsReadFileSync.mockReturnValue('{ invalid json }');

      expect(async () => {
        await registry.discoverConnectors('/opt/cmdb/connectors');
      }).not.toThrow();
    });

    it('should handle concurrent connector registrations', () => {
      const promises = Array(10)
        .fill(null)
        .map((_, i) => {
          const metadata = { ...sampleMetadata, type: `connector-${i}` };
          return Promise.resolve(
            registry.registerConnector(metadata, MockConnector as any)
          );
        });

      return Promise.all(promises).then(() => {
        expect(registry.getAllConnectorTypes()).toHaveLength(10);
      });
    });
  });
});
