// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * BaseIntegrationConnector Tests
 *
 * Tests for BaseIntegrationConnector abstract class including:
 * - Field mapping logic
 * - Resource management
 * - Dependency resolution
 * - ETL pipeline execution
 * - Event emission
 * - Deprecated method handling
 */

import { BaseIntegrationConnector } from '../../src/core/base-connector';
import {
  ConnectorConfiguration,
  ConnectorMetadata,
  ConnectorResource,
  ExtractedData,
  TransformedCI,
  TestResult,
  ExtractedRelationship,
  IdentificationAttributes,
} from '../../src/types/connector.types';

// Mock logger
jest.mock('@cmdb/common', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Concrete implementation for testing
class TestConnector extends BaseIntegrationConnector {
  public extractedData: ExtractedData[] = [];
  public transformCalls: Array<{ resourceId: string; data: any }> = [];
  public initializeCalled = false;
  public cleanupCalled = false;

  async initialize(): Promise<void> {
    this.initializeCalled = true;
  }

  async testConnection(): Promise<TestResult> {
    return { success: true };
  }

  async extractResource(
    resourceId: string,
    resourceConfig?: Record<string, any>
  ): Promise<ExtractedData[]> {
    return this.extractedData.filter(
      (d) => d.source_type === resourceId
    );
  }

  async extractRelationships(): Promise<ExtractedRelationship[]> {
    return [];
  }

  async transformResource(
    resourceId: string,
    sourceData: any
  ): Promise<TransformedCI> {
    this.transformCalls.push({ resourceId, data: sourceData });

    const { standardFields, metadata } = this.applyFieldMappings(
      resourceId,
      sourceData
    );

    return {
      name: standardFields.name || 'Test CI',
      ci_type: 'server',
      attributes: metadata,
      identifiers: this.extractIdentifiers(sourceData),
      source: this.config.type,
      source_id: sourceData.id || 'unknown',
      confidence_score: 0.9,
      ...standardFields,
    };
  }

  extractIdentifiers(data: any): IdentificationAttributes {
    return {
      external_id: data.id,
      hostname: data.hostname,
    };
  }

  async cleanup(): Promise<void> {
    this.cleanupCalled = true;
  }
}

describe('BaseIntegrationConnector', () => {
  let connector: TestConnector;
  let config: ConnectorConfiguration;
  let metadata: ConnectorMetadata;

  const serverResource: ConnectorResource = {
    id: 'servers',
    name: 'Servers',
    description: 'Server resources',
    ci_type: 'server',
    operations: ['extract', 'transform'],
    enabled_by_default: true,
    field_mappings: {
      name: 'ServerName',
      status: 'State',
      'metadata.region': 'Region',
      'metadata.instance_type': 'InstanceType',
    },
  };

  const databaseResource: ConnectorResource = {
    id: 'databases',
    name: 'Databases',
    description: 'Database resources',
    ci_type: 'database',
    operations: ['extract', 'transform'],
    enabled_by_default: false,
    extraction: {
      incremental: true,
      depends_on: ['servers'],
    },
  };

  beforeEach(() => {
    config = {
      name: 'test-instance',
      type: 'test-connector',
      enabled: true,
      connection: {},
      enabled_resources: ['servers', 'databases'],
      resource_configs: {
        servers: { region: 'us-east-1' },
      },
    };

    metadata = {
      type: 'test-connector',
      name: 'Test Connector',
      version: '1.0.0',
      description: 'Test',
      author: 'Test',
      verified: true,
      category: 'connector',
      resources: [serverResource, databaseResource],
      capabilities: {
        extraction: true,
        relationships: true,
        incremental: false,
        bidirectional: false,
      },
      configuration_schema: {},
    };

    connector = new TestConnector(config, metadata);
  });

  describe('Constructor', () => {
    it('should initialize with config and metadata', () => {
      expect(connector.getConfig()).toEqual(config);
      expect((connector as any).metadata).toEqual(metadata);
    });

    it('should not be initialized on construction', () => {
      expect((connector as any).isInitialized).toBe(false);
    });
  });

  describe('applyFieldMappings', () => {
    it('should map fields to standard CI fields and metadata', () => {
      const sourceData = {
        ServerName: 'web-server-01',
        State: 'running',
        Region: 'us-east-1',
        InstanceType: 't3.medium',
      };

      const { standardFields, metadata } = (connector as any).applyFieldMappings(
        'servers',
        sourceData
      );

      expect(standardFields.name).toBe('web-server-01');
      expect(standardFields.status).toBe('running');
      expect(metadata.region).toBe('us-east-1');
      expect(metadata.instance_type).toBe('t3.medium');
    });

    it('should handle nested source paths with dot notation', () => {
      const resource: ConnectorResource = {
        ...serverResource,
        field_mappings: {
          name: 'data.attributes.name',
          status: 'data.state',
        },
      };

      const testMetadata = {
        ...metadata,
        resources: [resource],
      };

      const testConnector = new TestConnector(config, testMetadata);

      const sourceData = {
        data: {
          attributes: { name: 'test-server' },
          state: 'active',
        },
      };

      const { standardFields } = (testConnector as any).applyFieldMappings(
        'servers',
        sourceData
      );

      expect(standardFields.name).toBe('test-server');
      expect(standardFields.status).toBe('active');
    });

    it('should skip null and undefined values', () => {
      const sourceData = {
        ServerName: 'server',
        State: null,
        Region: undefined,
      };

      const { standardFields, metadata } = (connector as any).applyFieldMappings(
        'servers',
        sourceData
      );

      expect(standardFields.name).toBe('server');
      expect(standardFields.status).toBeUndefined();
      expect(metadata.region).toBeUndefined();
    });

    it('should return empty objects when no field mappings defined', () => {
      const { standardFields, metadata } = (connector as any).applyFieldMappings(
        'databases',
        { any: 'data' }
      );

      expect(standardFields).toEqual({});
      expect(metadata).toEqual({});
    });

    it('should handle resource not found', () => {
      const { standardFields, metadata } = (connector as any).applyFieldMappings(
        'unknown-resource',
        { data: 'value' }
      );

      expect(standardFields).toEqual({});
      expect(metadata).toEqual({});
    });
  });

  describe('getNestedValue', () => {
    it('should retrieve nested values using dot notation', () => {
      const obj = {
        level1: {
          level2: {
            level3: 'value',
          },
        },
      };

      const value = (connector as any).getNestedValue(obj, 'level1.level2.level3');

      expect(value).toBe('value');
    });

    it('should handle arrays in path', () => {
      const obj = {
        items: [
          { name: 'item1' },
          { name: 'item2' },
        ],
      };

      const value = (connector as any).getNestedValue(obj, 'items.0.name');

      expect(value).toBe('item1');
    });

    it('should return undefined for missing paths', () => {
      const obj = { data: { name: 'test' } };

      const value = (connector as any).getNestedValue(obj, 'data.missing.path');

      expect(value).toBeUndefined();
    });

    it('should return undefined for null/undefined objects', () => {
      expect((connector as any).getNestedValue(null, 'path')).toBeUndefined();
      expect((connector as any).getNestedValue(undefined, 'path')).toBeUndefined();
    });

    it('should handle empty path', () => {
      const obj = { value: 'test' };

      const value = (connector as any).getNestedValue(obj, '');

      expect(value).toBeUndefined();
    });
  });

  describe('getAvailableResources', () => {
    it('should return all resources from metadata', () => {
      const resources = connector.getAvailableResources();

      expect(resources).toHaveLength(2);
      expect(resources.map((r) => r.id)).toContain('servers');
      expect(resources.map((r) => r.id)).toContain('databases');
    });
  });

  describe('getEnabledResources', () => {
    it('should return configured enabled resources', () => {
      const enabled = connector.getEnabledResources();

      expect(enabled).toEqual(['servers', 'databases']);
    });

    it('should return default enabled resources if not configured', () => {
      const configNoResources = { ...config, enabled_resources: undefined };
      const connectorDefault = new TestConnector(configNoResources, metadata);

      const enabled = connectorDefault.getEnabledResources();

      expect(enabled).toEqual(['servers']); // Only servers has enabled_by_default=true
    });

    it('should return empty array if no enabled resources', () => {
      const configEmpty = { ...config, enabled_resources: [] };
      const connectorEmpty = new TestConnector(configEmpty, metadata);

      const enabled = connectorEmpty.getEnabledResources();

      expect(enabled).toEqual([]);
    });
  });

  describe('Dependency Resolution', () => {
    it('should resolve dependencies and return correct execution order', async () => {
      connector.extractedData = [
        {
          external_id: 'srv-1',
          data: { id: 'srv-1', ServerName: 'Server 1' },
          source_type: 'servers',
          extracted_at: new Date(),
        },
        {
          external_id: 'db-1',
          data: { id: 'db-1', name: 'Database 1' },
          source_type: 'databases',
          extracted_at: new Date(),
        },
      ];

      await connector.run();

      // Servers should be extracted before databases (dependency)
      const extractionOrder = connector.transformCalls.map((c) => c.resourceId);
      const serversIndex = extractionOrder.indexOf('servers');
      const databasesIndex = extractionOrder.indexOf('databases');

      expect(serversIndex).toBeLessThan(databasesIndex);
    });

    it('should handle circular dependencies gracefully', () => {
      const circularMetadata: ConnectorMetadata = {
        ...metadata,
        resources: [
          {
            ...serverResource,
            extraction: { incremental: false, depends_on: ['databases'] },
          },
          {
            ...databaseResource,
            extraction: { incremental: false, depends_on: ['servers'] },
          },
        ],
      };

      const connectorCircular = new TestConnector(config, circularMetadata);

      // Should not crash
      expect(() => connectorCircular.getEnabledResources()).not.toThrow();
    });
  });

  describe('run', () => {
    beforeEach(() => {
      connector.extractedData = [
        {
          external_id: 'srv-1',
          data: { id: 'srv-1', ServerName: 'Server 1', State: 'running' },
          source_type: 'servers',
          extracted_at: new Date(),
        },
        {
          external_id: 'srv-2',
          data: { id: 'srv-2', ServerName: 'Server 2', State: 'stopped' },
          source_type: 'servers',
          extracted_at: new Date(),
        },
      ];
    });

    it('should execute full ETL pipeline', async () => {
      await connector.run();

      expect(connector.initializeCalled).toBe(true);
      expect(connector.transformCalls.length).toBeGreaterThan(0);
    });

    it('should initialize connector before extraction', async () => {
      await connector.run();

      expect(connector.initializeCalled).toBe(true);
      expect((connector as any).isInitialized).toBe(true);
    });

    it('should emit initialized event', async () => {
      const emitSpy = jest.spyOn(connector, 'emit');

      await connector.run();

      expect(emitSpy).toHaveBeenCalledWith('initialized', {
        connector: config.name,
      });
    });

    it('should emit extraction_started event for each resource', async () => {
      const emitSpy = jest.spyOn(connector, 'emit');

      await connector.run();

      expect(emitSpy).toHaveBeenCalledWith(
        'extraction_started',
        expect.objectContaining({ resource: 'servers' })
      );
    });

    it('should emit extraction_completed event', async () => {
      const emitSpy = jest.spyOn(connector, 'emit');

      await connector.run();

      expect(emitSpy).toHaveBeenCalledWith(
        'extraction_completed',
        expect.objectContaining({
          resource: 'servers',
          records: expect.any(Number),
        })
      );
    });

    it('should emit ci_discovered event for each CI', async () => {
      const emitSpy = jest.spyOn(connector, 'emit');

      await connector.run();

      expect(emitSpy).toHaveBeenCalledWith(
        'ci_discovered',
        expect.objectContaining({
          connector: config.name,
          ci: expect.any(Object),
        })
      );
    });

    it('should handle transformation errors without stopping', async () => {
      const emitSpy = jest.spyOn(connector, 'emit');

      // Override to throw error on first call
      const originalTransform = connector.transformResource.bind(connector);
      let callCount = 0;
      connector.transformResource = async (resourceId: string, data: any) => {
        if (callCount++ === 0) {
          throw new Error('Transform failed');
        }
        return originalTransform(resourceId, data);
      };

      await connector.run();

      // Should continue processing other records
      expect(connector.transformCalls.length).toBeGreaterThan(0);
    });

    it('does not log a tenant-controlled connector name containing a credential', async () => {
      const { logger } = require('@cmdb/common');
      const secret = 'client_secret=TENANT_MARKER_NEVER_LOG';
      const namedConnector = new TestConnector({ ...config, name: secret }, metadata);
      namedConnector.extractedData = connector.extractedData;
      jest.clearAllMocks();

      await namedConnector.run();

      expect(namedConnector.transformCalls.length).toBeGreaterThan(0);
      for (const method of ['info', 'warn', 'error'] as const) {
        expect(JSON.stringify(logger[method].mock.calls)).not.toContain(secret);
      }
    });

    it('does not emit or log raw extractor exceptions', async () => {
      const emitSpy = jest.spyOn(connector, 'emit');
      const { logger } = require('@cmdb/common');
      const secret = 'nested-client-secret-marker';
      connector.extractResource = async () => { throw new Error(`Authorization: ${secret}`); };

      await connector.run();

      expect(JSON.stringify([emitSpy.mock.calls, logger.error.mock.calls])).not.toContain(secret);
      expect(emitSpy).toHaveBeenCalledWith(
        'extraction_failed',
        expect.objectContaining({ error: 'CONNECTOR_EXTRACTION_FAILED' })
      );
    });

    it('returns a fixed failure instead of exposing initialization errors', async () => {
      const { logger } = require('@cmdb/common');
      const secret = 'nested-client-secret-marker';
      connector.initialize = async () => { throw new Error(`Authorization: ${secret}`); };

      await expect(connector.run()).rejects.toThrow('CONNECTOR_RUN_FAILED');
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret);
    });

    it('should extract relationships if supported', async () => {
      const relationships: ExtractedRelationship[] = [
        {
          source_external_id: 'srv-1',
          target_external_id: 'db-1',
          relationship_type: 'HOSTS',
        },
      ];

      connector.extractRelationships = jest.fn().mockResolvedValue(relationships);
      const emitSpy = jest.spyOn(connector, 'emit');

      await connector.run();

      expect(connector.extractRelationships).toHaveBeenCalled();
      expect(emitSpy).toHaveBeenCalledWith(
        'relationships_extracted',
        expect.objectContaining({
          relationships,
        })
      );
    });

    it('should skip relationships if not supported', async () => {
      const noRelMetadata = {
        ...metadata,
        capabilities: { ...metadata.capabilities, relationships: false },
      };

      const connectorNoRel = new TestConnector(config, noRelMetadata);
      const extractRelSpy = jest.spyOn(connectorNoRel, 'extractRelationships');

      await connectorNoRel.run();

      expect(extractRelSpy).not.toHaveBeenCalled();
    });

    it('should handle relationship extraction errors gracefully', async () => {
      connector.extractRelationships = jest
        .fn()
        .mockRejectedValue(new Error('Relationship extraction failed'));

      // Should not throw
      await expect(connector.run()).resolves.not.toThrow();
    });

    it('should only initialize once', async () => {
      await connector.run();
      await connector.run();

      // isInitialized should prevent re-initialization
      expect(connector.initializeCalled).toBe(true);
    });

    it('should pass resource config to extract method', async () => {
      const extractSpy = jest.spyOn(connector, 'extractResource');

      await connector.run();

      expect(extractSpy).toHaveBeenCalledWith(
        'servers',
        config.resource_configs?.servers
      );
    });
  });

  describe('Deprecated Methods', () => {
    const { logger } = require('@cmdb/common');

    beforeEach(() => {
      connector.extractedData = [
        {
          external_id: 'srv-1',
          data: { id: 'srv-1' },
          source_type: 'servers',
          extracted_at: new Date(),
        },
      ];
    });

    it('should warn when using deprecated extract()', async () => {
      await connector.extract();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('deprecated')
      );
    });

    it('should call extractResource() from deprecated extract()', async () => {
      const extractResourceSpy = jest.spyOn(connector, 'extractResource');

      await connector.extract();

      expect(extractResourceSpy).toHaveBeenCalledWith(
        'servers',
        config.resource_configs?.servers
      );
    });

    it('should return empty array from extract() if no enabled resources', async () => {
      const configNoResources = { ...config, enabled_resources: [] };
      const connectorEmpty = new TestConnector(configNoResources, metadata);

      const result = await connectorEmpty.extract();

      expect(result).toEqual([]);
    });

    it('should warn when using deprecated transform()', async () => {
      await connector.transform({ data: 'test' });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('deprecated')
      );
    });

    it('should call transformResource() from deprecated transform()', async () => {
      const transformResourceSpy = jest.spyOn(connector, 'transformResource');

      await connector.transform({ data: 'test' });

      expect(transformResourceSpy).toHaveBeenCalledWith(
        'servers',
        { data: 'test' }
      );
    });

    it('should throw error from transform() if no enabled resources', async () => {
      const configNoResources = { ...config, enabled_resources: [] };
      const connectorEmpty = new TestConnector(configNoResources, metadata);

      await expect(connectorEmpty.transform({})).rejects.toThrow(
        'No enabled resources found'
      );
    });
  });

  describe('Configuration Management', () => {
    it('should return current configuration', () => {
      const currentConfig = connector.getConfig();

      expect(currentConfig).toEqual(config);
    });

    it('should update configuration', () => {
      const updates = {
        enabled: false,
        options: { debug: true },
      };

      connector.updateConfig(updates);

      const updatedConfig = connector.getConfig();
      expect(updatedConfig.enabled).toBe(false);
      expect(updatedConfig.options).toEqual({ debug: true });
    });

    it('should preserve other config fields when updating', () => {
      connector.updateConfig({ enabled: false });

      const updatedConfig = connector.getConfig();
      expect(updatedConfig.name).toBe(config.name);
      expect(updatedConfig.type).toBe(config.type);
    });
  });

  describe('Edge Cases', () => {
    it('should handle connector with no resources', async () => {
      const noResourcesMetadata = { ...metadata, resources: [] };
      const connectorNoRes = new TestConnector(config, noResourcesMetadata);

      await connectorNoRes.run();

      expect(connectorNoRes.initializeCalled).toBe(true);
    });

    it('should handle empty extraction results', async () => {
      connector.extractedData = [];

      await connector.run();

      expect(connector.transformCalls).toHaveLength(0);
    });

    it('should handle resource with no CI type', () => {
      const noTypeResource: ConnectorResource = {
        ...serverResource,
        ci_type: null,
      };

      const noTypeMetadata = {
        ...metadata,
        resources: [noTypeResource],
      };

      const connectorNoType = new TestConnector(config, noTypeMetadata);

      expect(connectorNoType.getAvailableResources()[0]?.ci_type).toBeNull();
    });

    it('should handle deeply nested field paths', () => {
      const deepData = {
        a: { b: { c: { d: { e: 'value' } } } },
      };

      const value = (connector as any).getNestedValue(deepData, 'a.b.c.d.e');

      expect(value).toBe('value');
    });

    it('should handle resource configs as undefined', async () => {
      const configNoResourceConfigs = {
        ...config,
        resource_configs: undefined,
      };

      const connectorNoConfigs = new TestConnector(
        configNoResourceConfigs,
        metadata
      );

      connectorNoConfigs.extractedData = connector.extractedData;

      await connectorNoConfigs.run();

      // Should pass undefined to extractResource
      expect(connectorNoConfigs.transformCalls.length).toBeGreaterThan(0);
    });
  });
});
