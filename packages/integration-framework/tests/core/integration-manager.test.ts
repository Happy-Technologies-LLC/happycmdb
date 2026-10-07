// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { IntegrationManager } from '../../src/core/integration-manager';
import { getConnectorRegistry } from '../../src/registry/connector-registry';
import { getPostgresClient, getUnifiedCredentialService, getOAuthSubstrate } from '@cmdb/database';
import * as cron from 'node-cron';
import { getEventProducer } from '@cmdb/event-processor';

jest.mock('@cmdb/common', () => ({ logger: { info: jest.fn(), error: jest.fn() } }));
jest.mock('../../src/registry/connector-registry');
jest.mock('@cmdb/database');
jest.mock('@cmdb/event-processor', () => ({
  getEventProducer: jest.fn(),
  EventType: {
    CONNECTOR_RUN_STARTED: 'connector.run.started',
    CONNECTOR_RUN_COMPLETED: 'connector.run.completed',
    CONNECTOR_RUN_FAILED: 'connector.run.failed',
  },
}));
jest.mock('node-cron');

const orgA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const orgB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const config = {
  id: 'config-1', organization_id: orgA, name: 'shared-name', connector_type: 'test',
  credential_id: null, enabled: true, schedule: '* * * * *', connection: {}, options: {},
};

describe('IntegrationManager ownership and secret boundary', () => {
  let manager: IntegrationManager;
  let query: jest.Mock;
  let run: jest.Mock;
  let emit: jest.Mock;
  let cronFire: () => Promise<void>;

  beforeEach(() => {
    jest.clearAllMocks();
    Reflect.set(IntegrationManager, 'instance', undefined);
    query = jest.fn();
    (getPostgresClient as jest.Mock).mockReturnValue({ query });
    run = jest.fn().mockResolvedValue(undefined);
    (getConnectorRegistry as jest.Mock).mockReturnValue({ createConnector: jest.fn().mockReturnValue({
      run, testConnection: jest.fn().mockResolvedValue({ success: true }), cleanup: jest.fn(),
    }) });
    emit = jest.fn().mockResolvedValue(undefined);
    (getEventProducer as jest.Mock).mockReturnValue({ emit });
    (cron.validate as jest.Mock).mockReturnValue(true);
    (cron.schedule as jest.Mock).mockImplementation((_expression, callback) => {
      cronFire = callback;
      return { stop: jest.fn() };
    });
    manager = IntegrationManager.getInstance();
  });

  it('never registers or schedules legacy and credential-referenced configurations', async () => {
    query.mockResolvedValue({ rows: [config] });
    await manager.loadConnectors();
    expect(query.mock.calls[0][0]).toContain('organization_id IS NOT NULL');
    expect(query.mock.calls[0][0]).toContain('credential_id IS NULL');
    await manager.registerConnector({ ...manager.mapRowToConfig(config), organizationId: null });
    await manager.registerConnector({ ...manager.mapRowToConfig(config), credential_id: 'credential-1' });
    expect(cron.schedule).toHaveBeenCalledTimes(1);
    expect((cron.schedule as jest.Mock).mock.results[0].value.stop).toHaveBeenCalledTimes(1);
  });

  it('rejects foreign or deleted config before running or writing history', async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(manager.runConnector(config.id, orgB)).rejects.toThrow('CONNECTOR_NOT_FOUND');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('organization_id IS NOT DISTINCT FROM $2'), [config.id, orgB]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('rechecks stable id and captured org at schedule firing, never falls back to name', async () => {
    await manager.registerConnector(manager.mapRowToConfig(config));
    query.mockResolvedValue({ rows: [] }); // deleted or reassigned since registration
    await cronFire();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), [config.id, orgA]);
    expect(run).not.toHaveBeenCalled();
  });

  it('denies credential references before decrypt, even for their owning org', async () => {
    query.mockResolvedValue({ rows: [{ ...config, credential_id: 'credential-1' }] });
    await expect(manager.runConnector(config.id, orgA)).rejects.toThrow('CONNECTOR_CREDENTIAL_UNAVAILABLE');
    expect(getUnifiedCredentialService).not.toHaveBeenCalled();
    expect(getOAuthSubstrate).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses platform legacy credential tests before any credential lookup or connector construction', async () => {
    query.mockResolvedValue({ rows: [{ ...config, organization_id: null, enabled: false, credential_id: 'credential-1' }] });
    await expect(manager.testConnector(config.id, null)).rejects.toThrow('CONNECTOR_CREDENTIAL_UNAVAILABLE');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('organization_id IS NOT DISTINCT FROM $2'), [config.id, null]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(getUnifiedCredentialService).not.toHaveBeenCalled();
    expect(getOAuthSubstrate).not.toHaveBeenCalled();
    expect(getConnectorRegistry().createConnector).not.toHaveBeenCalled();
  });

  it('runs an owned inline configuration without persisting thrown secret bytes', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT * FROM connector_configurations')) return Promise.resolve({ rows: [config] });
      if (sql.includes('INSERT INTO connector_run_history')) return Promise.resolve({ rows: [{ id: 'history-1' }] });
      return Promise.resolve({ rows: [] });
    });
    run.mockRejectedValue(new Error('nested client_secret=DO_NOT_LEAK'));
    await expect(manager.runConnector(config.id, orgA)).rejects.toThrow('CONNECTOR_RUN_FAILED');
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(query.mock.calls)).not.toContain('DO_NOT_LEAK');
    expect(query.mock.calls.find(([sql]) => sql.includes('INSERT INTO connector_run_history'))?.[1]).toContain(orgA);
    expect(JSON.stringify(emit.mock.calls)).not.toContain('DO_NOT_LEAK');
    expect(emit.mock.calls.find(([event]) => event === 'connector.run.failed')?.[2]).toMatchObject({
      connector_name: config.id, error_message: 'CONNECTOR_RUN_FAILED',
    });
  });
});
