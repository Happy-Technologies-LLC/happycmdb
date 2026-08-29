// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { GraphQLError } from 'graphql';
import type { TokenPayload } from '../../../auth/types';

// jest.config.unit.js sets resetMocks/restoreMocks: true, which strips mock
// implementations set inside a jest.mock() factory before every test runs.
// So the factories below only forward calls to named `mock*` functions, and
// a top-level beforeEach re-arms those functions' return values every test.
const mockQuery = jest.fn();
const mockPgClient = { query: mockQuery };
const mockGetPostgresClient = jest.fn();

jest.mock('@cmdb/database', () => ({
  getPostgresClient: (...args: unknown[]) => mockGetPostgresClient(...args),
}));

const mockGetConnector = jest.fn();
const mockRegisterConnector = jest.fn();
const mockRunConnector = jest.fn();
const mockMapRowToConfig = jest.fn((row: any) => ({
  id: row.id,
  name: row.name,
  type: row.connector_type,
  enabled: row.enabled,
  connection: row.connection,
}));
const mockGetIntegrationManager = jest.fn();

jest.mock('@cmdb/integration-framework', () => ({
  getIntegrationManager: (...args: unknown[]) => mockGetIntegrationManager(...args),
}));

const mockInstallConnector = jest.fn();
const mockUpdateConnector = jest.fn();
const mockUninstallConnector = jest.fn();
const MockConnectorLifecycleService = jest.fn();

jest.mock('../../../services/connector-lifecycle.service', () => ({
  ConnectorLifecycleService: MockConnectorLifecycleService,
}));

// Imported after the mocks above so the module picks up the mocked singletons.
import { connectorResolvers } from '../connector.resolvers';
import type { GraphQLContext } from '../index';

beforeEach(() => {
  mockGetPostgresClient.mockReturnValue(mockPgClient);
  mockGetIntegrationManager.mockReturnValue({
    getConnector: mockGetConnector,
    registerConnector: mockRegisterConnector,
    runConnector: mockRunConnector,
    mapRowToConfig: mockMapRowToConfig,
  });
  MockConnectorLifecycleService.mockImplementation(function (this: unknown) {
    Object.assign(this as object, {
      installConnector: mockInstallConnector,
      updateConnector: mockUpdateConnector,
      uninstallConnector: mockUninstallConnector,
    });
  });
});

const adminUser: TokenPayload = {
  _userId: 'admin-1',
  _username: 'admin-alice',
  _role: 'admin',
  _type: 'access',
};

const operatorUser: TokenPayload = {
  _userId: 'op-1',
  _username: 'op-bob',
  _role: 'operator',
  _type: 'access',
};

const viewerUser: TokenPayload = {
  _userId: 'viewer-1',
  _username: 'viewer-carol',
  _role: 'viewer',
  _type: 'access',
};

function contextWith(user?: TokenPayload): GraphQLContext {
  return {
    _neo4jClient: {} as any,
    _loaders: {} as any,
    user,
  };
}

async function expectGraphQLErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error('expected promise to reject, but it resolved');
  } catch (error) {
    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).extensions?.['code']).toBe(code);
  }
}

describe('connector mutation resolvers: authentication and authorization', () => {
  it('has no NOT_IMPLEMENTED stub resolvers left', () => {
    const mutationSource = Object.entries(connectorResolvers.Mutation)
      .map(([name, fn]) => `${name}:${(fn as (...args: unknown[]) => unknown).toString()}`)
      .join('\n');
    expect(mutationSource).not.toMatch(/NOT_IMPLEMENTED/);
  });

  it('does not expose testConnectorConnection or cancelConnectorRun', () => {
    expect(connectorResolvers.Mutation).not.toHaveProperty('testConnectorConnection');
    expect(connectorResolvers.Mutation).not.toHaveProperty('cancelConnectorRun');
  });

  it('installConnector rejects unauthenticated requests with UNAUTHENTICATED', async () => {
    await expectGraphQLErrorCode(
      connectorResolvers.Mutation.installConnector(
        null,
        { connectorType: 'acme-crm' },
        contextWith(undefined)
      ),
      'UNAUTHENTICATED'
    );
    expect(mockInstallConnector).not.toHaveBeenCalled();
  });

  it('installConnector rejects non-admin authenticated users with FORBIDDEN', async () => {
    await expectGraphQLErrorCode(
      connectorResolvers.Mutation.installConnector(
        null,
        { connectorType: 'acme-crm' },
        contextWith(operatorUser)
      ),
      'FORBIDDEN'
    );
    expect(mockInstallConnector).not.toHaveBeenCalled();
  });

  it('installConnector succeeds for an admin and delegates to the lifecycle service', async () => {
    mockInstallConnector.mockResolvedValue({
      success: true,
      connector: {
        id: 'row-1',
        connector_type: 'acme-crm',
        category: 'connector',
        name: 'Acme CRM',
        description: null,
        installed_version: '1.0.0',
        latest_available_version: '1.0.0',
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
        tags: [],
      },
      message: 'installed',
    });

    const result = await connectorResolvers.Mutation.installConnector(
      null,
      { connectorType: 'acme-crm', version: '1.0.0' },
      contextWith(adminUser)
    );

    expect(mockInstallConnector).toHaveBeenCalledWith('acme-crm', '1.0.0');
    expect(result.success).toBe(true);
    expect(result.connector.connectorType).toBe('acme-crm');
    expect(result.connector.category).toBe('CONNECTOR');
  });

  it('createConnectorConfiguration rejects viewers with FORBIDDEN', async () => {
    await expectGraphQLErrorCode(
      connectorResolvers.Mutation.createConnectorConfiguration(
        null,
        { input: { name: 'x', connectorType: 'acme-crm', connection: {} } },
        contextWith(viewerUser)
      ),
      'FORBIDDEN'
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('createConnectorConfiguration succeeds for an operator and records the real actor as created_by', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'cfg-1',
          name: 'My Config',
          description: null,
          connector_type: 'acme-crm',
          enabled: true,
          schedule: null,
          schedule_enabled: false,
          connection: {},
          options: {},
          enabled_resources: [],
          resource_configs: {},
          max_retries: 3,
          retry_delay_seconds: 300,
          continue_on_error: false,
          notification_channels: [],
          notification_on_success: false,
          notification_on_failure: true,
          created_at: new Date(),
          updated_at: new Date(),
          created_by: operatorUser._username,
        },
      ],
    });

    const result = await connectorResolvers.Mutation.createConnectorConfiguration(
      null,
      { input: { name: 'My Config', connectorType: 'acme-crm', connection: {} } },
      contextWith(operatorUser)
    );

    expect(result.createdBy).toBe('op-bob');
    const [, values] = mockQuery.mock.calls[0];
    expect(values).toContain('op-bob');
  });
});

describe('runConnector mutation', () => {
  it('rejects unauthenticated requests', async () => {
    await expectGraphQLErrorCode(
      connectorResolvers.Mutation.runConnector(null, { id: 'cfg-1' }, contextWith(undefined)),
      'UNAUTHENTICATED'
    );
  });

  it('registers the connector on demand, runs it, and returns the resulting run record on success', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'cfg-1', name: 'my-connector', connector_type: 'acme-crm', enabled: true, connection: {} }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'run-1',
            config_id: 'cfg-1',
            connector_type: 'acme-crm',
            config_name: 'my-connector',
            resource_id: null,
            started_at: new Date(),
            completed_at: new Date(),
            status: 'completed',
            records_extracted: 5,
            records_transformed: 5,
            records_loaded: 5,
            records_failed: 0,
            duration_ms: 120,
            errors: [],
            error_message: null,
            triggered_by: 'manual',
            triggered_by_user: 'op-bob',
            job_id: 'run_123',
          },
        ],
      });

    mockGetConnector.mockReturnValue(undefined);
    mockRunConnector.mockResolvedValue({ status: 'completed' });

    const result = await connectorResolvers.Mutation.runConnector(
      null,
      { id: 'cfg-1' },
      contextWith(operatorUser)
    );

    expect(mockRegisterConnector).toHaveBeenCalled();
    expect(mockRunConnector).toHaveBeenCalledWith('my-connector', 'manual', 'op-bob');
    expect(result.status).toBe('COMPLETED');
    expect(result.triggeredByUser).toBe('op-bob');
  });

  it('still returns the recorded run when the connector run itself fails', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'cfg-1', name: 'my-connector', connector_type: 'acme-crm', enabled: true, connection: {} }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'run-2',
            config_id: 'cfg-1',
            connector_type: 'acme-crm',
            config_name: 'my-connector',
            resource_id: null,
            started_at: new Date(),
            completed_at: new Date(),
            status: 'failed',
            records_extracted: 0,
            records_transformed: 0,
            records_loaded: 0,
            records_failed: 0,
            duration_ms: 40,
            errors: ['boom'],
            error_message: 'boom',
            triggered_by: 'manual',
            triggered_by_user: 'op-bob',
            job_id: 'run_124',
          },
        ],
      });

    mockGetConnector.mockReturnValue({});
    mockRunConnector.mockRejectedValue(new Error('boom'));

    const result = await connectorResolvers.Mutation.runConnector(
      null,
      { id: 'cfg-1' },
      contextWith(operatorUser)
    );

    expect(mockRegisterConnector).not.toHaveBeenCalled();
    expect(result.status).toBe('FAILED');
    expect(result.errorMessage).toBe('boom');
  });

  it('rejects running a disabled configuration', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'cfg-1', name: 'my-connector', connector_type: 'acme-crm', enabled: false, connection: {} }],
    });

    await expectGraphQLErrorCode(
      connectorResolvers.Mutation.runConnector(null, { id: 'cfg-1' }, contextWith(operatorUser)),
      'BAD_USER_INPUT'
    );
    expect(mockRunConnector).not.toHaveBeenCalled();
  });
});

describe('connectorRegistry: version releasedAt mapping', () => {
  it('falls back to the legacy releaseDate key and tolerates an already-correct releasedAt', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          connector_type: 'acme-crm',
          category: 'connector',
          name: 'Acme CRM',
          description: null,
          verified: true,
          latest_version: '2.0.0',
          versions: [
            { version: '1.0.0', releaseDate: '2025-01-01T00:00:00.000Z' },
            { version: '2.0.0', releasedAt: '2025-06-01T00:00:00.000Z' },
          ],
          author: null,
          homepage: null,
          repository: null,
          license: null,
          downloads: 0,
          rating: '0',
          tags: [],
        },
      ],
    });

    const [result] = await connectorResolvers.Query.connectorRegistry(null, {});

    expect(result.versions[0].releasedAt).toBe('2025-01-01T00:00:00.000Z');
    expect(result.versions[1].releasedAt).toBe('2025-06-01T00:00:00.000Z');
  });
});
