// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { ConnectorLifecycleService } from '../connector-lifecycle.service';
import type { PostgresClient } from '@cmdb/database';
import type { ConnectorInstaller } from '@cmdb/integration-framework';

type QueryResult = { rows: any[] };

/**
 * Builds a fake PostgresClient whose `.query` dispatches on the SQL text.
 * `installedRowsSequence` lets a test drive the "installed_connectors" SELECT
 * to return different rows on successive calls (e.g. null before install,
 * populated after).
 */
function createMockPgClient(options: {
  registryRow?: any;
  installedRowsSequence?: (any | null)[];
  configCount?: number;
}): PostgresClient {
  let installedCallIndex = 0;
  const sequence = options.installedRowsSequence ?? [null];

  const query = jest.fn(async (sql: string): Promise<QueryResult> => {
    if (sql.includes('FROM connector_registry_cache')) {
      return { rows: options.registryRow ? [options.registryRow] : [] };
    }
    if (sql.includes('SELECT COUNT(*) FROM connector_configurations')) {
      return { rows: [{ count: String(options.configCount ?? 0) }] };
    }
    if (sql.trim().startsWith('UPDATE installed_connectors')) {
      return { rows: [] };
    }
    if (sql.includes('FROM installed_connectors')) {
      const row = sequence[Math.min(installedCallIndex, sequence.length - 1)];
      installedCallIndex++;
      return { rows: row ? [row] : [] };
    }
    return { rows: [] };
  });

  return { query } as unknown as PostgresClient;
}

function createMockInstaller(overrides: Partial<ConnectorInstaller> = {}): ConnectorInstaller {
  return {
    installConnector: jest.fn().mockResolvedValue(undefined),
    updateConnector: jest.fn().mockResolvedValue(undefined),
    uninstallConnector: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ConnectorInstaller;
}

const catalogEntry = {
  connector_type: 'acme-crm',
  category: 'connector',
  name: 'Acme CRM',
  description: 'Acme CRM connector',
  verified: true,
  latest_version: '2.0.0',
  versions: [
    { version: '1.0.0', downloadUrl: 'https://example.com/1.0.0.tar.gz' },
    { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0.tar.gz' },
  ],
  tags: ['crm'],
};

const installedRow = {
  id: 'row-1',
  connector_type: 'acme-crm',
  category: 'connector',
  name: 'Acme CRM',
  description: 'Acme CRM connector',
  installed_version: '1.0.0',
  latest_available_version: '2.0.0',
  installed_at: new Date(),
  updated_at: new Date(),
  enabled: true,
  verified: true,
  install_path: '/opt/cmdb/connectors/acme-crm',
  metadata: {},
  capabilities: {},
  resources: [],
  configuration_schema: {},
  total_runs: 0,
  successful_runs: 0,
  failed_runs: 0,
  last_run_at: null,
  last_run_status: null,
  tags: ['crm'],
};

describe('ConnectorLifecycleService.installConnector', () => {
  it('fails without touching the installer when the catalog has no entry for the type', async () => {
    const installer = createMockInstaller();
    const pgClient = createMockPgClient({ registryRow: undefined });
    const service = new ConnectorLifecycleService(pgClient, installer);

    const outcome = await service.installConnector('unknown-connector');

    expect(outcome.success).toBe(false);
    expect(outcome.code).toBe('NOT_FOUND_IN_REGISTRY');
    expect(outcome.connector).toBeNull();
    expect(installer.installConnector).not.toHaveBeenCalled();
  });

  it('fails with a conflict when already installed and not forced', async () => {
    const installer = createMockInstaller();
    const pgClient = createMockPgClient({
      registryRow: catalogEntry,
      installedRowsSequence: [installedRow],
    });
    const service = new ConnectorLifecycleService(pgClient, installer);

    const outcome = await service.installConnector('acme-crm');

    expect(outcome.success).toBe(false);
    expect(outcome.code).toBe('ALREADY_INSTALLED');
    expect(outcome.connector).toEqual(installedRow);
    expect(installer.installConnector).not.toHaveBeenCalled();
  });

  it('leaves no installed record when the real installer fails', async () => {
    const installer = createMockInstaller({
      installConnector: jest.fn().mockRejectedValue(new Error('download failed: 404')),
    });
    // Not installed before, and still not installed after the failed attempt.
    const pgClient = createMockPgClient({
      registryRow: catalogEntry,
      installedRowsSequence: [null],
    });
    const service = new ConnectorLifecycleService(pgClient, installer);

    const outcome = await service.installConnector('acme-crm');

    expect(outcome.success).toBe(false);
    expect(outcome.code).toBe('INSTALL_FAILED');
    expect(outcome.connector).toBeNull();
    expect(outcome.errors).toEqual(['download failed: 404']);
    expect(installer.installConnector).toHaveBeenCalledWith(
      'acme-crm',
      expect.objectContaining({ version: '2.0.0' })
    );
  });

  it('installs successfully and returns the enriched installed_connectors row', async () => {
    const installer = createMockInstaller();
    const finalRow = { ...installedRow, installed_version: '2.0.0' };
    const pgClient = createMockPgClient({
      registryRow: catalogEntry,
      // 1st call: not-yet-installed check -> null; 2nd call: post-install read -> populated row.
      installedRowsSequence: [null, finalRow],
    });
    const service = new ConnectorLifecycleService(pgClient, installer);

    const outcome = await service.installConnector('acme-crm');

    expect(outcome.success).toBe(true);
    expect(outcome.connector).toEqual(finalRow);
    expect(installer.installConnector).toHaveBeenCalledWith(
      'acme-crm',
      expect.objectContaining({ url: 'https://example.com/2.0.0.tar.gz', version: '2.0.0' })
    );
  });
});

describe('ConnectorLifecycleService.updateConnector', () => {
  it('fails when the connector is not installed', async () => {
    const installer = createMockInstaller();
    const pgClient = createMockPgClient({ installedRowsSequence: [null] });
    const service = new ConnectorLifecycleService(pgClient, installer);

    const outcome = await service.updateConnector('acme-crm');

    expect(outcome.success).toBe(false);
    expect(outcome.code).toBe('NOT_INSTALLED');
    expect(installer.updateConnector).not.toHaveBeenCalled();
  });

  it('is a no-op success when already at the target version', async () => {
    const installer = createMockInstaller();
    const pgClient = createMockPgClient({
      registryRow: catalogEntry,
      installedRowsSequence: [{ ...installedRow, installed_version: '2.0.0' }],
    });
    const service = new ConnectorLifecycleService(pgClient, installer);

    const outcome = await service.updateConnector('acme-crm', '2.0.0');

    expect(outcome.success).toBe(true);
    expect(outcome.previousVersion).toBe('2.0.0');
    expect(outcome.newVersion).toBe('2.0.0');
    expect(installer.updateConnector).not.toHaveBeenCalled();
  });

  it('updates successfully and reports previous/new version', async () => {
    const installer = createMockInstaller();
    const finalRow = { ...installedRow, installed_version: '2.0.0' };
    const pgClient = createMockPgClient({
      registryRow: catalogEntry,
      installedRowsSequence: [installedRow, finalRow],
    });
    const service = new ConnectorLifecycleService(pgClient, installer);

    const outcome = await service.updateConnector('acme-crm');

    expect(outcome.success).toBe(true);
    expect(outcome.previousVersion).toBe('1.0.0');
    expect(outcome.newVersion).toBe('2.0.0');
    expect(outcome.connector).toEqual(finalRow);
    expect(installer.updateConnector).toHaveBeenCalledWith(
      'acme-crm',
      expect.objectContaining({ version: '2.0.0' })
    );
  });

  it('reports failure without mutating state when the installer throws', async () => {
    const installer = createMockInstaller({
      updateConnector: jest.fn().mockRejectedValue(new Error('extract failed')),
    });
    const pgClient = createMockPgClient({
      registryRow: catalogEntry,
      installedRowsSequence: [installedRow],
    });
    const service = new ConnectorLifecycleService(pgClient, installer);

    const outcome = await service.updateConnector('acme-crm');

    expect(outcome.success).toBe(false);
    expect(outcome.code).toBe('UPDATE_FAILED');
    expect(outcome.errors).toEqual(['extract failed']);
  });
});

describe('ConnectorLifecycleService.uninstallConnector', () => {
  it('fails when the connector is not installed', async () => {
    const installer = createMockInstaller();
    const pgClient = createMockPgClient({ installedRowsSequence: [null] });
    const service = new ConnectorLifecycleService(pgClient, installer);

    const outcome = await service.uninstallConnector('acme-crm');

    expect(outcome.success).toBe(false);
    expect(outcome.code).toBe('NOT_INSTALLED');
    expect(installer.uninstallConnector).not.toHaveBeenCalled();
  });

  it('refuses to uninstall while configurations still reference the connector', async () => {
    const installer = createMockInstaller();
    const pgClient = createMockPgClient({
      installedRowsSequence: [installedRow],
      configCount: 2,
    });
    const service = new ConnectorLifecycleService(pgClient, installer);

    const outcome = await service.uninstallConnector('acme-crm');

    expect(outcome.success).toBe(false);
    expect(outcome.code).toBe('HAS_DEPENDENT_CONFIGURATIONS');
    expect(installer.uninstallConnector).not.toHaveBeenCalled();
  });

  it('uninstalls successfully via the real installer', async () => {
    const installer = createMockInstaller();
    const pgClient = createMockPgClient({
      installedRowsSequence: [installedRow],
      configCount: 0,
    });
    const service = new ConnectorLifecycleService(pgClient, installer);

    const outcome = await service.uninstallConnector('acme-crm');

    expect(outcome.success).toBe(true);
    expect(installer.uninstallConnector).toHaveBeenCalledWith('acme-crm');
  });
});
