// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * IntegrationManager Tests
 *
 * Tests for IntegrationManager including:
 * - Connector lifecycle management
 * - Connector registration and unregistration
 * - Scheduled connector execution (cron)
 * - Manual connector execution
 * - Event handling
 * - Database integration
 */

import { IntegrationManager } from '../../src/core/integration-manager';
import { getConnectorRegistry } from '../../src/registry/connector-registry';
import { getPostgresClient } from '@cmdb/database';
import { getEventProducer } from '@cmdb/event-processor';
import { BaseIntegrationConnector } from '../../src/core/base-connector';
import { ConnectorConfiguration, ConnectorRunResult } from '../../src/types/connector.types';
import * as cron from 'node-cron';

// Mock dependencies
jest.mock('@cmdb/common', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.mock('../../src/registry/connector-registry');
jest.mock('@cmdb/database');
jest.mock('@cmdb/event-processor');
jest.mock('node-cron');

describe('IntegrationManager', () => {
  let manager: IntegrationManager;
  let mockRegistry: any;
  let mockPostgresClient: any;
  let mockEventProducer: any;
  let mockConnector: any;
  let mockCronTask: any;

  const sampleConfig: ConnectorConfiguration = {
    id: 'config-123',
    name: 'Test Connector',
    type: 'test-connector',
    enabled: true,
    schedule: '0 */6 * * *', // Every 6 hours
    connection: { api_key: 'test-key' },
    options: {},
    enabled_resources: ['servers'],
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock connector instance
    mockConnector = {
      run: jest.fn().mockResolvedValue(undefined),
      testConnection: jest.fn().mockResolvedValue({ success: true }),
      cleanup: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      getConfig: jest.fn().mockReturnValue(sampleConfig),
    };

    // Mock registry
    mockRegistry = {
      createConnector: jest.fn().mockReturnValue(mockConnector),
    };
    (getConnectorRegistry as jest.Mock).mockReturnValue(mockRegistry);

    // Mock PostgreSQL client
    mockPostgresClient = {
      query: jest.fn(),
    };
    (getPostgresClient as jest.Mock).mockReturnValue(mockPostgresClient);

    // Mock event producer
    mockEventProducer = {
      emit: jest.fn().mockResolvedValue(undefined),
    };
    (getEventProducer as jest.Mock).mockReturnValue(mockEventProducer);

    // Mock cron
    mockCronTask = {
      stop: jest.fn(),
    };
    (cron.validate as jest.Mock).mockReturnValue(true);
    (cron.schedule as jest.Mock).mockReturnValue(mockCronTask);

    // Reset singleton
    (IntegrationManager as any).instance = null;
    manager = IntegrationManager.getInstance();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = IntegrationManager.getInstance();
      const instance2 = IntegrationManager.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe('loadConnectors', () => {
    it('should load all enabled connectors from database', async () => {
      mockPostgresClient.query.mockResolvedValue({
        rows: [
          {
            id: 'config-1',
            name: 'Connector 1',
            type: 'test-connector-1',
            enabled: true,
            connection: {},
          },
          {
            id: 'config-2',
            name: 'Connector 2',
            type: 'test-connector-2',
            enabled: true,
            schedule: '0 0 * * *',
            connection: {},
          },
        ],
      });

      await manager.loadConnectors();

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        'SELECT * FROM connector_configurations WHERE enabled = true'
      );
      expect(mockRegistry.createConnector).toHaveBeenCalledTimes(2);
      expect(manager.getConnectors().size).toBe(2);
    });

    it('should skip connectors that fail to register', async () => {
      mockPostgresClient.query.mockResolvedValue({
        rows: [
          { id: '1', name: 'Good', type: 'good', enabled: true, connection: {} },
          { id: '2', name: 'Bad', type: 'bad', enabled: true, connection: {} },
        ],
      });

      mockRegistry.createConnector
        .mockReturnValueOnce(mockConnector)
        .mockImplementationOnce(() => {
          throw new Error('Failed to create connector');
        });

      await manager.loadConnectors();

      expect(manager.getConnectors().size).toBe(1);
      expect(manager.getConnector('Good')).toBeDefined();
    });

    it('should handle empty database result', async () => {
      mockPostgresClient.query.mockResolvedValue({ rows: [] });

      await manager.loadConnectors();

      expect(manager.getConnectors().size).toBe(0);
    });
  });

  describe('registerConnector', () => {
    it('should register connector and set up listeners', async () => {
      await manager.registerConnector(sampleConfig);

      expect(mockRegistry.createConnector).toHaveBeenCalledWith(sampleConfig);
      expect(mockConnector.on).toHaveBeenCalled();
      expect(manager.getConnector(sampleConfig.name)).toBe(mockConnector);
    });

    it('should schedule connector if cron schedule provided', async () => {
      await manager.registerConnector(sampleConfig);

      expect(cron.validate).toHaveBeenCalledWith(sampleConfig.schedule);
      expect(cron.schedule).toHaveBeenCalledWith(
        sampleConfig.schedule,
        expect.any(Function)
      );
    });

    it('should not schedule if no schedule provided', async () => {
      const configNoSchedule = { ...sampleConfig, schedule: undefined };

      await manager.registerConnector(configNoSchedule);

      expect(cron.schedule).not.toHaveBeenCalled();
    });

    it('should throw error on invalid cron expression', async () => {
      (cron.validate as jest.Mock).mockReturnValue(false);

      const configInvalidCron = {
        ...sampleConfig,
        schedule: 'invalid cron',
      };

      await expect(
        manager.registerConnector(configInvalidCron)
      ).rejects.toThrow('Invalid cron schedule');
    });

    it('should replace existing schedule if re-registering', async () => {
      await manager.registerConnector(sampleConfig);

      const updatedConfig = { ...sampleConfig, schedule: '0 0 * * *' };
      await manager.registerConnector(updatedConfig);

      expect(mockCronTask.stop).toHaveBeenCalled();
      expect(cron.schedule).toHaveBeenCalledTimes(2);
    });
  });

  describe('runConnector', () => {
    beforeEach(async () => {
      mockPostgresClient.query.mockResolvedValue({
        rows: [
          {
            id: sampleConfig.id,
            name: sampleConfig.name,
            connector_type: sampleConfig.type,
          },
        ],
      });

      await manager.registerConnector(sampleConfig);
    });

    it('should execute connector and track metrics', async () => {
      const result = await manager.runConnector(sampleConfig.name);

      expect(result.status).toBe('completed');
      expect(result.connector_name).toBe(sampleConfig.name);
      expect(mockConnector.run).toHaveBeenCalled();
    });

    it('should emit connector run started event', async () => {
      await manager.runConnector(sampleConfig.name);

      expect(mockEventProducer.emit).toHaveBeenCalledWith(
        expect.anything(), // EventType.CONNECTOR_RUN_STARTED
        'integration-manager',
        expect.objectContaining({
          connector_name: sampleConfig.name,
          connector_type: sampleConfig.type,
        })
      );
    });

    it('should emit connector run completed event', async () => {
      await manager.runConnector(sampleConfig.name);

      expect(mockEventProducer.emit).toHaveBeenCalledWith(
        expect.anything(), // EventType.CONNECTOR_RUN_COMPLETED
        'integration-manager',
        expect.objectContaining({
          connector_name: sampleConfig.name,
        })
      );
    });

    it('should save run record to database', async () => {
      await manager.runConnector(sampleConfig.name);

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO connector_run_history'),
        expect.arrayContaining([
          expect.stringContaining('run_'),
          sampleConfig.name,
        ])
      );
    });

    it('should update run record on completion', async () => {
      await manager.runConnector(sampleConfig.name);

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE connector_run_history'),
        expect.arrayContaining([
          expect.stringContaining('run_'),
          expect.any(Date), // completed_at
          'completed',
        ])
      );
    });

    it('should handle connector execution failure', async () => {
      mockConnector.run.mockRejectedValue(new Error('Execution failed'));

      await expect(
        manager.runConnector(sampleConfig.name)
      ).rejects.toThrow('Execution failed');

      // Should still save failed run
      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE connector_run_history'),
        expect.arrayContaining(['failed'])
      );
    });

    it('should emit connector run failed event', async () => {
      mockConnector.run.mockRejectedValue(new Error('Execution failed'));

      await expect(
        manager.runConnector(sampleConfig.name)
      ).rejects.toThrow();

      expect(mockEventProducer.emit).toHaveBeenCalledWith(
        expect.anything(), // EventType.CONNECTOR_RUN_FAILED
        'integration-manager',
        expect.objectContaining({
          connector_name: sampleConfig.name,
          error_message: 'Execution failed',
        })
      );
    });

    it('should throw error for unknown connector', async () => {
      await expect(
        manager.runConnector('unknown-connector')
      ).rejects.toThrow('Connector not found');
    });

    it('should track execution duration', async () => {
      const result = await manager.runConnector(sampleConfig.name);

      expect(result.started_at).toBeDefined();
      expect(result.completed_at).toBeDefined();
      expect(result.completed_at!.getTime()).toBeGreaterThanOrEqual(
        result.started_at.getTime()
      );
    });
  });

  describe('testConnector', () => {
    beforeEach(async () => {
      await manager.registerConnector(sampleConfig);
    });

    it('should test connector connection', async () => {
      mockConnector.testConnection.mockResolvedValue({
        success: true,
        message: 'Connection successful',
      });

      const result = await manager.testConnector(sampleConfig.name);

      expect(result.success).toBe(true);
      expect(mockConnector.testConnection).toHaveBeenCalled();
    });

    it('should throw error for unknown connector', async () => {
      await expect(
        manager.testConnector('unknown-connector')
      ).rejects.toThrow('Connector not found');
    });

    it('should return failure result on test error', async () => {
      mockConnector.testConnection.mockResolvedValue({
        success: false,
        message: 'Authentication failed',
      });

      const result = await manager.testConnector(sampleConfig.name);

      expect(result.success).toBe(false);
    });
  });

  describe('unregisterConnector', () => {
    beforeEach(async () => {
      await manager.registerConnector(sampleConfig);
    });

    it('should unregister connector and cleanup', async () => {
      await manager.unregisterConnector(sampleConfig.name);

      expect(mockConnector.cleanup).toHaveBeenCalled();
      expect(manager.getConnector(sampleConfig.name)).toBeUndefined();
    });

    it('should cancel scheduled task on unregister', async () => {
      await manager.unregisterConnector(sampleConfig.name);

      expect(mockCronTask.stop).toHaveBeenCalled();
    });

    it('should handle unregistering unknown connector gracefully', async () => {
      await manager.unregisterConnector('unknown-connector');

      // Should not throw
      expect(manager.getConnector('unknown-connector')).toBeUndefined();
    });
  });

  describe('Event Listeners', () => {
    beforeEach(async () => {
      await manager.registerConnector(sampleConfig);
    });

    it('should listen to extraction_started events', () => {
      const listeners = mockConnector.on.mock.calls.map((call: any) => call[0]);
      expect(listeners).toContain('extraction_started');
    });

    it('should listen to extraction_completed events', () => {
      const listeners = mockConnector.on.mock.calls.map((call: any) => call[0]);
      expect(listeners).toContain('extraction_completed');
    });

    it('should listen to extraction_failed events', () => {
      const listeners = mockConnector.on.mock.calls.map((call: any) => call[0]);
      expect(listeners).toContain('extraction_failed');
    });

    it('should listen to ci_discovered events', () => {
      const listeners = mockConnector.on.mock.calls.map((call: any) => call[0]);
      expect(listeners).toContain('ci_discovered');
    });

    it('should handle ci_discovered event data', () => {
      const ciDiscoveredHandler = mockConnector.on.mock.calls.find(
        (call: any) => call[0] === 'ci_discovered'
      )[1];

      const eventData = {
        connector: sampleConfig.name,
        ci: {
          name: 'Test CI',
          ci_type: 'server',
        },
      };

      // Should not throw
      ciDiscoveredHandler(eventData);
    });
  });

  describe('Scheduled Execution', () => {
    it('should execute connector on schedule', async () => {
      let scheduledCallback: any;

      (cron.schedule as jest.Mock).mockImplementation(
        (schedule: string, callback: any) => {
          scheduledCallback = callback;
          return mockCronTask;
        }
      );

      await manager.registerConnector(sampleConfig);

      expect(scheduledCallback).toBeDefined();

      // Trigger scheduled execution
      await scheduledCallback();

      expect(mockConnector.run).toHaveBeenCalled();
    });

    it('should handle errors in scheduled execution', async () => {
      let scheduledCallback: any;

      (cron.schedule as jest.Mock).mockImplementation(
        (schedule: string, callback: any) => {
          scheduledCallback = callback;
          return mockCronTask;
        }
      );

      await manager.registerConnector(sampleConfig);

      mockConnector.run.mockRejectedValue(new Error('Scheduled run failed'));

      // Should not throw when scheduled task fails
      await expect(scheduledCallback()).rejects.toThrow();
    });
  });

  describe('getConnectors', () => {
    it('should return all registered connectors', async () => {
      const config1 = { ...sampleConfig, name: 'Connector 1' };
      const config2 = { ...sampleConfig, name: 'Connector 2' };

      await manager.registerConnector(config1);
      await manager.registerConnector(config2);

      const connectors = manager.getConnectors();

      expect(connectors.size).toBe(2);
      expect(connectors.has('Connector 1')).toBe(true);
      expect(connectors.has('Connector 2')).toBe(true);
    });

    it('should return empty map when no connectors registered', () => {
      const connectors = manager.getConnectors();

      expect(connectors.size).toBe(0);
    });
  });

  describe('getConnector', () => {
    it('should return specific connector by name', async () => {
      await manager.registerConnector(sampleConfig);

      const connector = manager.getConnector(sampleConfig.name);

      expect(connector).toBe(mockConnector);
    });

    it('should return undefined for unknown connector', () => {
      const connector = manager.getConnector('unknown');

      expect(connector).toBeUndefined();
    });
  });

  describe('Database Operations', () => {
    it('should handle database query errors during load', async () => {
      mockPostgresClient.query.mockRejectedValue(
        new Error('Database connection failed')
      );

      await expect(manager.loadConnectors()).rejects.toThrow();
    });

    it('should handle database errors during run save', async () => {
      await manager.registerConnector(sampleConfig);

      mockPostgresClient.query
        .mockResolvedValueOnce({ rows: [sampleConfig] }) // Get config
        .mockRejectedValueOnce(new Error('Save failed')); // Insert fails

      // Should still complete execution
      await expect(
        manager.runConnector(sampleConfig.name)
      ).resolves.toBeDefined();
    });
  });

  describe('Concurrency', () => {
    it('should handle multiple connectors running concurrently', async () => {
      const config1 = { ...sampleConfig, name: 'Connector 1' };
      const config2 = { ...sampleConfig, name: 'Connector 2' };

      await manager.registerConnector(config1);
      await manager.registerConnector(config2);

      const promises = [
        manager.runConnector('Connector 1'),
        manager.runConnector('Connector 2'),
      ];

      const results = await Promise.all(promises);

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === 'completed')).toBe(true);
    });

    it('should handle re-registering connector while running', async () => {
      await manager.registerConnector(sampleConfig);

      mockConnector.run.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      const runPromise = manager.runConnector(sampleConfig.name);

      // Re-register while running
      const updatedConfig = { ...sampleConfig, schedule: '0 0 * * *' };
      await manager.registerConnector(updatedConfig);

      await runPromise;

      // Should have updated schedule
      expect(cron.schedule).toHaveBeenCalledWith('0 0 * * *', expect.any(Function));
    });
  });

  describe('Edge Cases', () => {
    it('should handle connector with no schedule', async () => {
      const configNoSchedule = {
        ...sampleConfig,
        schedule: undefined,
      };

      await manager.registerConnector(configNoSchedule);

      expect(cron.schedule).not.toHaveBeenCalled();
      expect(manager.getConnector(configNoSchedule.name)).toBeDefined();
    });

    it('should handle connector cleanup errors', async () => {
      await manager.registerConnector(sampleConfig);

      mockConnector.cleanup.mockRejectedValue(new Error('Cleanup failed'));

      // Should not throw
      await expect(
        manager.unregisterConnector(sampleConfig.name)
      ).resolves.toBeUndefined();
    });

    it('should handle malformed configuration from database', async () => {
      mockPostgresClient.query.mockResolvedValue({
        rows: [
          {
            // Missing required fields
            name: 'Bad Config',
          },
        ],
      });

      await manager.loadConnectors();

      // Should skip malformed config
      expect(manager.getConnectors().size).toBe(0);
    });
  });
});
