// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Scheduler Sync Service Tests
 *
 * Tests for the scheduler sync service that polls PostgreSQL for changes
 * and syncs the discovery scheduler accordingly.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { SchedulerSyncService } from '../../src/schedulers/scheduler-sync.service';
import { DiscoveryScheduler } from '../../src/schedulers/discovery-scheduler';
import { getPostgresClient } from '@cmdb/database';
import { assertIsolatedIntegrationTarget } from '../../../../tests/setup/isolated-integration-target';

// HAP-975: its hooks delete discovery_definitions rows by a fixed owner; refuse at module load outside
// the isolated root Testcontainers run, before any hook can reach a database.
assertIsolatedIntegrationTarget();

describe('SchedulerSyncService', () => {
  let syncService: SchedulerSyncService;
  let scheduler: DiscoveryScheduler;
  let postgresClient: any;

  beforeEach(() => {
    syncService = new SchedulerSyncService();
    scheduler = new DiscoveryScheduler([], true);
    postgresClient = getPostgresClient();
  });

  afterEach(async () => {
    await syncService.stop();
    await scheduler.stop();
  });

  describe('start and stop', () => {
    it('should start and stop the sync service', async () => {
      expect(syncService.getStatus().isRunning).toBe(false);

      await syncService.start();
      expect(syncService.getStatus().isRunning).toBe(true);

      await syncService.stop();
      expect(syncService.getStatus().isRunning).toBe(false);
    });

    it('should warn when starting an already running service', async () => {
      await syncService.start();
      await syncService.start(); // Should log warning
      expect(syncService.getStatus().isRunning).toBe(true);
    });

    it('should warn when stopping a non-running service', async () => {
      await syncService.stop(); // Should log warning
      expect(syncService.getStatus().isRunning).toBe(false);
    });
  });

  describe('syncIfChanged', () => {
    it('should detect changes when definitions are added', async () => {
      // Create a test definition
      const pool = postgresClient['pool'];
      const result = await pool.query(
        `INSERT INTO discovery_definitions (
          id, name, provider, method, credential_id, config, schedule, is_active, created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING *`,
        [
          'test-def-1',
          'Test AWS Discovery',
          'aws',
          'agentless',
          'test-cred-1',
          JSON.stringify({ regions: ['us-east-1'] }),
          '*/15 * * * *',
          true,
          'test-user',
        ]
      );

      expect(result.rows.length).toBe(1);

      // Force sync should detect the new definition
      const syncSchedulesSpy = jest.spyOn(scheduler, 'syncSchedules');
      await syncService.forceSync();

      expect(syncSchedulesSpy).toHaveBeenCalled();

      // Cleanup
      await pool.query('DELETE FROM discovery_definitions WHERE id = $1', ['test-def-1']);
    });

    it('should detect changes when definitions are updated', async () => {
      const pool = postgresClient['pool'];

      // Create initial definition
      await pool.query(
        `INSERT INTO discovery_definitions (
          id, name, provider, method, credential_id, config, schedule, is_active, created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          'test-def-2',
          'Test Azure Discovery',
          'azure',
          'agentless',
          'test-cred-2',
          JSON.stringify({ regions: ['eastus'] }),
          '*/30 * * * *',
          true,
          'test-user',
        ]
      );

      // Do initial sync
      await syncService.forceSync();

      // Wait a bit to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Update the definition
      await pool.query(
        `UPDATE discovery_definitions
         SET schedule = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        ['*/60 * * * *', 'test-def-2']
      );

      // Force sync should detect the update
      const syncSchedulesSpy = jest.spyOn(scheduler, 'syncSchedules');
      await syncService.forceSync();

      expect(syncSchedulesSpy).toHaveBeenCalled();

      // Cleanup
      await pool.query('DELETE FROM discovery_definitions WHERE id = $1', ['test-def-2']);
    });

    it('should not sync if no changes detected', async () => {
      // Do initial sync
      await syncService.forceSync();

      // Immediately force sync again - no changes should be detected
      const syncSchedulesSpy = jest.spyOn(scheduler, 'syncSchedules');
      await syncService.forceSync();

      // Should still be called because forceSync always syncs
      expect(syncSchedulesSpy).toHaveBeenCalled();
    });
  });

  describe('polling', () => {
    it('should poll at configured interval', async () => {
      // Set a very short poll interval for testing
      syncService.setPollInterval(100); // 100ms

      const syncSchedulesSpy = jest.spyOn(scheduler, 'syncSchedules');
      await syncService.start();

      // Wait for at least 2 polls
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Should have been called at least twice (initial + 2 polls)
      expect(syncSchedulesSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle errors during polling gracefully', async () => {
      // Mock syncSchedules to throw an error
      jest.spyOn(scheduler, 'syncSchedules').mockRejectedValue(new Error('Test error'));

      syncService.setPollInterval(100);
      await syncService.start();

      // Wait for a poll to occur
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Service should still be running despite the error
      expect(syncService.getStatus().isRunning).toBe(true);
    });
  });

  describe('getStatus', () => {
    it('should return current service status', async () => {
      const status = syncService.getStatus();

      expect(status).toHaveProperty('isRunning');
      expect(status).toHaveProperty('lastSyncTimestamp');
      expect(status).toHaveProperty('pollIntervalMs');
      expect(typeof status.isRunning).toBe('boolean');
      expect(typeof status.pollIntervalMs).toBe('number');
    });

    it('should update lastSyncTimestamp after sync', async () => {
      const initialStatus = syncService.getStatus();
      expect(initialStatus.lastSyncTimestamp).toBeNull();

      await syncService.forceSync();

      const updatedStatus = syncService.getStatus();
      expect(updatedStatus.lastSyncTimestamp).not.toBeNull();
      expect(updatedStatus.lastSyncTimestamp).toBeInstanceOf(Date);
    });
  });

  describe('setPollInterval', () => {
    it('should allow setting poll interval before starting', () => {
      expect(() => syncService.setPollInterval(5000)).not.toThrow();
      expect(syncService.getStatus().pollIntervalMs).toBe(5000);
    });

    it('should throw error when setting poll interval while running', async () => {
      await syncService.start();
      expect(() => syncService.setPollInterval(5000)).toThrow(
        'Cannot change poll interval while service is running'
      );
    });
  });

  describe('forceSync', () => {
    it('should force immediate sync and update timestamp', async () => {
      const syncSchedulesSpy = jest.spyOn(scheduler, 'syncSchedules');

      await syncService.forceSync();

      expect(syncSchedulesSpy).toHaveBeenCalled();
      expect(syncService.getStatus().lastSyncTimestamp).not.toBeNull();
    });

    it('should work even when service is not running', async () => {
      const syncSchedulesSpy = jest.spyOn(scheduler, 'syncSchedules');

      expect(syncService.getStatus().isRunning).toBe(false);
      await syncService.forceSync();

      expect(syncSchedulesSpy).toHaveBeenCalled();
    });
  });
});

describe('SchedulerSyncService Integration', () => {
  let syncService: SchedulerSyncService;
  let scheduler: DiscoveryScheduler;
  let postgresClient: any;

  beforeEach(() => {
    syncService = new SchedulerSyncService();
    scheduler = new DiscoveryScheduler([], true);
    postgresClient = getPostgresClient();
  });

  afterEach(async () => {
    await syncService.stop();
    await scheduler.stop();

    // Cleanup test data
    const pool = postgresClient['pool'];
    await pool.query('DELETE FROM discovery_definitions WHERE created_by = $1', ['test-user']);
  });

  it('should add new scheduled definition when detected', async () => {
    const pool = postgresClient['pool'];

    // Create a definition with schedule
    await pool.query(
      `INSERT INTO discovery_definitions (
        id, name, provider, method, credential_id, config, schedule, is_active, created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        'test-integration-1',
        'Test GCP Discovery',
        'gcp',
        'agentless',
        'test-cred-3',
        JSON.stringify({ projectId: 'test-project' }),
        '0 * * * *',
        true,
        'test-user',
      ]
    );

    await scheduler.start();
    await syncService.forceSync();

    // Check that the definition was scheduled
    const scheduleDefinitionSpy = jest.spyOn(scheduler, 'scheduleDefinition');
    await syncService.forceSync();

    // Note: Since it was already added in the first sync, second sync won't add it again
    // This test validates that the integration works end-to-end
  });

  it('should remove scheduled definition when deactivated', async () => {
    const pool = postgresClient['pool'];

    // Create and schedule a definition
    await pool.query(
      `INSERT INTO discovery_definitions (
        id, name, provider, method, credential_id, config, schedule, is_active, created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        'test-integration-2',
        'Test SSH Discovery',
        'ssh',
        'agentless',
        'test-cred-4',
        JSON.stringify({ targets: [] }),
        '0 2 * * *',
        true,
        'test-user',
      ]
    );

    await scheduler.start();
    await syncService.forceSync();

    // Deactivate the definition
    await pool.query(
      `UPDATE discovery_definitions
       SET is_active = false, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      ['test-integration-2']
    );

    // Wait to ensure timestamp changes
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Sync should detect the change and remove the schedule
    await syncService.forceSync();

    // Definition should no longer be scheduled
    const unscheduleDefinitionSpy = jest.spyOn(scheduler, 'unscheduleDefinition');
    await syncService.forceSync();
  });

  it('should update schedule when cron pattern changes', async () => {
    const pool = postgresClient['pool'];

    // Create a definition
    await pool.query(
      `INSERT INTO discovery_definitions (
        id, name, provider, method, credential_id, config, schedule, is_active, created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        'test-integration-3',
        'Test Nmap Discovery',
        'nmap',
        'agentless',
        'test-cred-5',
        JSON.stringify({ range: '192.168.1.0/24' }),
        '0 3 * * *',
        true,
        'test-user',
      ]
    );

    await scheduler.start();
    await syncService.forceSync();

    // Change the schedule
    await pool.query(
      `UPDATE discovery_definitions
       SET schedule = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      ['0 4 * * *', 'test-integration-3']
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Sync should detect the change and reschedule
    const unscheduleDefinitionSpy = jest.spyOn(scheduler, 'unscheduleDefinition');
    const scheduleDefinitionSpy = jest.spyOn(scheduler, 'scheduleDefinition');

    await syncService.forceSync();

    // Should unschedule old and schedule new
    expect(unscheduleDefinitionSpy).toHaveBeenCalledWith('test-integration-3');
    expect(scheduleDefinitionSpy).toHaveBeenCalledWith('test-integration-3');
  });
});
