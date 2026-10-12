// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for ChangeEventProcessor
 */

import { ChangeEventProcessor } from '../../src/processors/change-event-processor';
import { EventType, CIDiscoveredEvent, CIUpdatedEvent, CIDeletedEvent } from '../../src/types/events';

// Mock dependencies
jest.mock('@cmdb/database', () => ({
  getPostgresClient: jest.fn(() => ({
    query: jest.fn(),
  })),
}));

jest.mock('@cmdb/common', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../src/kafka/event-consumer', () => ({
  createEventConsumer: jest.fn(() => ({
    connect: jest.fn(),
    subscribe: jest.fn(),
    on: jest.fn(),
    run: jest.fn(),
    disconnect: jest.fn(),
  })),
}));

import { getPostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import { createEventConsumer } from '../../src/kafka/event-consumer';

describe('ChangeEventProcessor', () => {
  let processor: ChangeEventProcessor;
  let mockPostgresClient: any;
  let mockConsumer: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPostgresClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };
    (getPostgresClient as jest.Mock).mockReturnValue(mockPostgresClient);

    mockConsumer = {
      connect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      run: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };
    (createEventConsumer as jest.Mock).mockReturnValue(mockConsumer);

    processor = new ChangeEventProcessor();
  });

  describe('start', () => {
    it('should start the event processor successfully', async () => {
      await processor.start();

      expect(mockConsumer.connect).toHaveBeenCalled();
      expect(mockConsumer.subscribe).toHaveBeenCalledWith(
        expect.arrayContaining(['cmdb.ci.events', 'cmdb.ci.changes'])
      );
      expect(mockConsumer.on).toHaveBeenCalledWith(EventType.CI_DISCOVERED, expect.any(Function));
      expect(mockConsumer.on).toHaveBeenCalledWith(EventType.CI_UPDATED, expect.any(Function));
      expect(mockConsumer.on).toHaveBeenCalledWith(EventType.CI_DELETED, expect.any(Function));
      expect(mockConsumer.run).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('ChangeEventProcessor started');
    });
  });

  describe('stop', () => {
    it('should stop the event processor successfully', async () => {
      await processor.stop();

      expect(mockConsumer.disconnect).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('ChangeEventProcessor stopped');
    });
  });

  describe('handleCIDiscovered', () => {
    it('should handle CI discovered event', async () => {
      const event: CIDiscoveredEvent = {
        event_id: 'evt-1',
        event_type: EventType.CI_DISCOVERED,
        timestamp: new Date(),
        ci_id: 'ci-123',
        organization_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        ci_name: 'Web Server 1',
        ci_type: 'server',
        source_system: 'aws-discovery',
        identifiers: { aws_instance_id: 'i-1234567890' },
        confidence_score: 0.95,
      };

      await (processor as any).handleCIDiscovered(event);

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO ci_change_history'),
        expect.arrayContaining([
          'ci-123',
          'discovered',
          'system',
          'aws-discovery',
        ])
      );

      expect(logger.info).toHaveBeenCalledWith(
        'CI discovery tracked',
        expect.objectContaining({
          ci_id: 'ci-123',
          ci_name: 'Web Server 1',
        })
      );
    });

    it('should handle errors during CI discovery tracking', async () => {
      const event: CIDiscoveredEvent = {
        event_id: 'evt-1',
        event_type: EventType.CI_DISCOVERED,
        timestamp: new Date(),
        ci_id: 'ci-123',
        organization_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        ci_name: 'Web Server 1',
        ci_type: 'server',
        source_system: 'aws-discovery',
        identifiers: {},
        confidence_score: 0.95,
      };

      const dbError = new Error('Database connection failed');
      mockPostgresClient.query.mockRejectedValueOnce(dbError);

      await expect((processor as any).handleCIDiscovered(event)).rejects.toThrow(dbError);

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to track CI discovery',
        expect.objectContaining({
          event_id: 'evt-1',
          ci_id: 'ci-123',
        })
      );
    });
  });

  describe('handleCIUpdated', () => {
    it('should handle CI updated event', async () => {
      const event: CIUpdatedEvent = {
        event_id: 'evt-2',
        event_type: EventType.CI_UPDATED,
        timestamp: new Date(),
        ci_id: 'ci-123',
        organization_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        ci_name: 'Web Server 1',
        source_system: 'aws-discovery',
        changed_fields: ['status', 'ip_address'],
        previous_values: { status: 'running', ip_address: '10.0.0.1' },
        new_values: { status: 'stopped', ip_address: '10.0.0.2' },
      };

      await (processor as any).handleCIUpdated(event);

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO ci_change_history'),
        expect.arrayContaining([
          'ci-123',
          'updated',
          'system',
          'aws-discovery',
          ['status', 'ip_address'],
        ])
      );

      expect(logger.info).toHaveBeenCalledWith(
        'CI update tracked',
        expect.objectContaining({
          ci_id: 'ci-123',
          changed_fields: ['status', 'ip_address'],
        })
      );
    });

    it('should detect significant changes and create alerts', async () => {
      const event: CIUpdatedEvent = {
        event_id: 'evt-2',
        event_type: EventType.CI_UPDATED,
        timestamp: new Date(),
        ci_id: 'ci-123',
        organization_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        ci_name: 'Web Server 1',
        source_system: 'aws-discovery',
        changed_fields: ['status', 'tags'],
        previous_values: { status: 'running', tags: ['prod'] },
        new_values: { status: 'stopped', tags: ['prod', 'maint'] },
      };

      await (processor as any).handleCIUpdated(event);

      // Should create alert for status change
      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO ci_change_alerts'),
        expect.arrayContaining([
          'ci-123',
          'Web Server 1',
          'significant_change',
          ['status'],
        ])
      );

      expect(logger.warn).toHaveBeenCalledWith(
        'Significant CI change detected',
        expect.any(Object)
      );
    });

    it('should not create alerts for non-significant changes', async () => {
      const event: CIUpdatedEvent = {
        event_id: 'evt-3',
        event_type: EventType.CI_UPDATED,
        timestamp: new Date(),
        ci_id: 'ci-123',
        organization_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        ci_name: 'Web Server 1',
        source_system: 'aws-discovery',
        changed_fields: ['tags', 'metadata'],
        previous_values: { tags: ['prod'] },
        new_values: { tags: ['prod', 'v2'] },
      };

      await (processor as any).handleCIUpdated(event);

      // Should not create alert
      const alertCalls = mockPostgresClient.query.mock.calls.filter((call: any) =>
        call[0].includes('ci_change_alerts')
      );
      expect(alertCalls.length).toBe(0);
    });
  });

  describe('handleCIDeleted', () => {
    it('should handle CI deleted event', async () => {
      const event: CIDeletedEvent = {
        event_id: 'evt-3',
        event_type: EventType.CI_DELETED,
        timestamp: new Date(),
        ci_id: 'ci-123',
        ci_name: 'Web Server 1',
        ci_type: 'server',
        reason: 'Resource terminated',
      };

      await (processor as any).handleCIDeleted(event);

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO ci_change_history'),
        expect.arrayContaining([
          'ci-123',
          'deleted',
          'system',
        ])
      );

      expect(logger.info).toHaveBeenCalledWith(
        'CI deletion tracked',
        expect.objectContaining({
          ci_id: 'ci-123',
          reason: 'Resource terminated',
        })
      );
    });
  });

  describe('updateCIStatistics', () => {
    it('should update CI statistics with upsert', async () => {
      await (processor as any).updateCIStatistics('ci-123', 'updated');

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO ci_change_statistics'),
        expect.arrayContaining(['ci-123', 'updated'])
      );

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT (ci_id) DO UPDATE'),
        expect.any(Array)
      );
    });
  });

  describe('getChangeHistory', () => {
    it('should retrieve change history for a CI', async () => {
      const mockHistory = [
        { ci_id: 'ci-123', change_type: 'updated', changed_at: new Date() },
        { ci_id: 'ci-123', change_type: 'discovered', changed_at: new Date() },
      ];

      mockPostgresClient.query.mockResolvedValue({ rows: mockHistory });

      const result = await processor.getChangeHistory('ci-123', 50, 0);

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM ci_change_history'),
        ['ci-123', 50, 0]
      );

      expect(result).toEqual(mockHistory);
    });

    it('should use default pagination values', async () => {
      mockPostgresClient.query.mockResolvedValue({ rows: [] });

      await processor.getChangeHistory('ci-123');

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.any(String),
        ['ci-123', 100, 0]
      );
    });
  });

  describe('getChangeStatistics', () => {
    it('should retrieve change statistics for a CI', async () => {
      const mockStats = {
        ci_id: 'ci-123',
        last_change_type: 'updated',
        last_change_at: new Date(),
        total_changes: 42,
      };

      mockPostgresClient.query.mockResolvedValue({ rows: [mockStats] });

      const result = await processor.getChangeStatistics('ci-123');

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM ci_change_statistics'),
        ['ci-123']
      );

      expect(result).toEqual(mockStats);
    });

    it('should return null when no statistics found', async () => {
      mockPostgresClient.query.mockResolvedValue({ rows: [] });

      const result = await processor.getChangeStatistics('ci-123');

      expect(result).toBeNull();
    });
  });

  describe('getChangeAlerts', () => {
    it('should retrieve change alerts for a CI', async () => {
      const mockAlerts = [
        { ci_id: 'ci-123', alert_type: 'significant_change', created_at: new Date() },
      ];

      mockPostgresClient.query.mockResolvedValue({ rows: mockAlerts });

      const result = await processor.getChangeAlerts('ci-123', 25);

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM ci_change_alerts'),
        ['ci-123', 25]
      );

      expect(result).toEqual(mockAlerts);
    });

    it('should use default limit', async () => {
      mockPostgresClient.query.mockResolvedValue({ rows: [] });

      await processor.getChangeAlerts('ci-123');

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.any(String),
        ['ci-123', 50]
      );
    });
  });

  describe('checkForSignificantChanges', () => {
    it('should identify significant field changes', async () => {
      const significantFields = ['status', 'environment', 'ip_address', 'hostname'];

      for (const field of significantFields) {
        const event: CIUpdatedEvent = {
          event_id: 'evt-sig',
          event_type: EventType.CI_UPDATED,
          timestamp: new Date(),
          ci_id: 'ci-123',
          organization_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
          ci_name: 'Test CI',
          source_system: 'test',
          changed_fields: [field, 'other_field'],
          previous_values: {},
          new_values: {},
        };

        await (processor as any).checkForSignificantChanges(event);

        expect(mockPostgresClient.query).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO ci_change_alerts'),
          expect.arrayContaining([
            'ci-123',
            'Test CI',
            'significant_change',
            [field],
          ])
        );

        jest.clearAllMocks();
      }
    });
  });
});
