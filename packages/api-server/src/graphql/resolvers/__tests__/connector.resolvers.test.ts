// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { GraphQLError, buildSchema, parse, validate } from 'graphql';
import { connectorTypeDefs } from '../../schema/connector.schema';
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

const mockGetIntegrationManager = jest.fn();
const mockRunConnector = jest.fn();

jest.mock('@cmdb/integration-framework/dist/core/integration-manager', () => ({
  getIntegrationManager: (...args: unknown[]) => mockGetIntegrationManager(...args),
}));


// Imported after the mocks above so the module picks up the mocked singletons.
import { connectorResolvers } from '../connector.resolvers';
import { ConnectorConfigurationFieldResolvers } from '../connector-fields.resolvers';
import type { GraphQLContext } from '../index';

beforeEach(() => {
  mockGetPostgresClient.mockReturnValue(mockPgClient);
  mockGetIntegrationManager.mockReturnValue({ runConnector: mockRunConnector });
});

const adminUser: TokenPayload = {
  _userId: 'admin-1',
  _username: 'admin-alice',
  _role: 'admin',
  _type: 'access',
  _organizationId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
};

const operatorUser: TokenPayload = {
  _userId: 'op-1',
  _username: 'op-bob',
  _role: 'operator',
  _type: 'access',
  _organizationId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
};


function contextWith(user?: TokenPayload): GraphQLContext {
  return {
    _neo4jClient: {} as GraphQLContext['_neo4jClient'],
    _loaders: {} as GraphQLContext['_loaders'],
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

const orgA = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const orgB = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const sentinel = 'SECRET-NESTED-DO-NOT-RETURN';
const configs = [
  { id: 'a', organization_id: orgA, name: 'shared', connector_type: 'acme-crm', enabled: true,
    connection: { nested: { token: sentinel } }, options: { key: sentinel }, resource_configs: { x: sentinel },
    notification_channels: [sentinel] },
  { id: 'b', organization_id: orgB, name: 'shared', connector_type: 'acme-crm', enabled: true,
    connection: { nested: { token: sentinel } } },
  { id: 'legacy', organization_id: null, name: 'old', connector_type: 'acme-crm', enabled: true },
];
const runs = [
  { id: 'ra', organization_id: orgA, config_id: 'a', connector_type: 'acme-crm', config_name: 'shared',
    status: 'completed', errors: [sentinel], error_message: sentinel, job_id: sentinel },
  { id: 'rb', organization_id: orgB, config_id: 'b', connector_type: 'acme-crm', config_name: 'shared',
    status: 'failed', errors: [sentinel] },
  { id: 'rl', organization_id: null, config_id: 'legacy', connector_type: 'acme-crm', config_name: 'old',
    status: 'failed', error_message: sentinel },
];

function installScopedDatabase() {
  const mutations: string[] = [];
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const match = sql.match(/organization_id = \$(\d+)/);
    const visible = (row: { organization_id: string | null }) =>
      !match || row.organization_id === params[Number(match[1]) - 1] ||
      (row.organization_id === null && params[Number(match[1])] === true);
    const table = sql.includes('connector_run_history') ? runs : configs;
    const operation = sql.trim().split(/\s+/)[0];
    let rows = table.filter(visible);
    if (sql.includes('.id = $1')) rows = rows.filter(row => row.id === params[0]);
    const configMatch = sql.match(/\.config_id = \$(\d+)/);
    if (configMatch) rows = rows.filter(row => 'config_id' in row && row.config_id === params[Number(configMatch[1]) - 1]);
    if (operation === 'UPDATE' || operation === 'DELETE') {
      if (rows.length) mutations.push(sql);
    }
    if (operation === 'INSERT') {
      mutations.push(sql);
      rows = [configs[0]];
    }
    return { rows };
  });
  return mutations;
}

describe('connector ownership and public GraphQL boundary', () => {
  it('createConnectorConfiguration rejects viewers with FORBIDDEN', async () => {
    await expectGraphQLErrorCode(
      connectorResolvers.Mutation.createConnectorConfiguration(
        null,
        { input: { name: 'x', connectorType: 'acme-crm', connection: {} } },
        contextWith(viewerUser)
      ),
      'FORBIDDEN'
    );
  });

  it('rejects missing identity or organization before DB access', async () => {
    await expectGraphQLErrorCode(connectorResolvers.Query.connectorConfigurations(null, {}, contextWith()), 'FORBIDDEN');
    await expectGraphQLErrorCode(
      connectorResolvers.Mutation.updateConnectorConfiguration(null, { id: 'a', input: { enabled: false } },
        contextWith({ ...operatorUser, _organizationId: undefined })), 'FORBIDDEN');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('refuses global lifecycle operations for tenant and platform principals before database access', async () => {
    for (const user of [adminUser, operatorUser, { ...adminUser, _platformAdmin: true }]) {
      for (const mutation of [
        connectorResolvers.Mutation.installConnector,
        connectorResolvers.Mutation.updateConnector,
        connectorResolvers.Mutation.uninstallConnector,
      ]) {
        await expectGraphQLErrorCode(
          mutation(null, { connectorType: 'acme-crm', force: true }, contextWith(user)),
          'CONNECTOR_LIFECYCLE_UNAVAILABLE'
        );
      }
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('makes foreign and missing configuration IDs indistinguishable without mutating', async () => {
    const mutations = installScopedDatabase();
    for (const id of ['b', 'missing', 'legacy']) {
      await expectGraphQLErrorCode(connectorResolvers.Mutation.deleteConnectorConfiguration(null, { id }, contextWith(operatorUser)), 'NOT_FOUND');
      await expectGraphQLErrorCode(connectorResolvers.Mutation.updateConnectorConfiguration(
        null, { id, input: { enabled: false } }, contextWith(operatorUser)), 'NOT_FOUND');
      await expectGraphQLErrorCode(connectorResolvers.Mutation.runConnector(null, { id }, contextWith(operatorUser)), 'NOT_FOUND');
    }
    expect(mutations).toEqual([]);
    expect(mockRunConnector).not.toHaveBeenCalled();
  });

  it('returns only own public config/run fields, including nested run history', async () => {
    installScopedDatabase();
    const configsA = await connectorResolvers.Query.connectorConfigurations(null, {}, contextWith(operatorUser));
    const runsA = await connectorResolvers.Query.connectorRuns(null, {}, contextWith(operatorUser));
    expect(configsA.map((row: { id: string }) => row.id)).toEqual(['a']);
    expect(runsA.map((row: { id: string }) => row.id)).toEqual(['ra']);
    expect(JSON.stringify({ configsA, runsA })).not.toContain(sentinel);
    await expectGraphQLErrorCode(connectorResolvers.Query.connectorConfiguration(null, { id: 'b' }, contextWith(operatorUser)), 'NOT_FOUND');
    await expectGraphQLErrorCode(connectorResolvers.Query.connectorRun(null, { id: 'rb' }, contextWith(operatorUser)), 'NOT_FOUND');
  });
  it('excludes legacy from platform lists while allowing explicit legacy ID reads', async () => {
    installScopedDatabase();
    const tenantAdmin = await connectorResolvers.Query.connectorConfigurations(null, {}, contextWith(adminUser));
    expect(tenantAdmin.map((row: { id: string }) => row.id)).toEqual(['a']);
    const platformContext = contextWith({ ...adminUser, _platformAdmin: true });
    const platform = await connectorResolvers.Query.connectorConfigurations(null, {}, platformContext);
    expect(platform.map((row: { id: string }) => row.id)).toEqual(['a']);
    const runs = await connectorResolvers.Query.connectorRuns(null, {}, platformContext);
    expect(runs.map((row: { id: string }) => row.id)).toEqual(['ra']);
    const legacy = await connectorResolvers.Query.connectorConfiguration(null, { id: 'legacy' }, platformContext);
    expect(legacy.id).toBe('legacy');
    await expectGraphQLErrorCode(
      connectorResolvers.Query.connectorConfiguration(null, { id: 'legacy' }, contextWith(adminUser)), 'NOT_FOUND'
    );
  });

  it('runs by owned id and returns only that run public projection', async () => {
    installScopedDatabase();
    mockRunConnector.mockResolvedValue({ run_id: sentinel });
    const result = await connectorResolvers.Mutation.runConnector(null, { id: 'a' }, contextWith(operatorUser));
    expect(mockRunConnector).toHaveBeenCalledWith('a', orgA, 'manual', 'op-bob');
    const [historyQuery] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(historyQuery).toContain('crh.job_id = $1');
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result.status).toBe('COMPLETED');
  });

  it('maps only the trusted credential refusal to a fixed GraphQL error', async () => {
    installScopedDatabase();
    mockRunConnector.mockRejectedValue(new Error('CONNECTOR_CREDENTIAL_UNAVAILABLE'));
    await expectGraphQLErrorCode(
      connectorResolvers.Mutation.runConnector(null, { id: 'a' }, contextWith(operatorUser)),
      'CONNECTOR_CREDENTIAL_UNAVAILABLE'
    );
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('refuses disabled credential-backed runs before exposing enabled state or loading credentials', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      id: 'a', organization_id: orgA, enabled: false, credential_id: 'opaque-reference',
    }] });
    await expectGraphQLErrorCode(
      connectorResolvers.Mutation.runConnector(null, { id: 'a' }, contextWith(operatorUser)),
      'CONNECTOR_CREDENTIAL_UNAVAILABLE'
    );
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockRunConnector).not.toHaveBeenCalled();
  });

  it('keeps saved secret values when updating a public field without write-only inputs', async () => {
    installScopedDatabase();
    const result = await connectorResolvers.Mutation.updateConnectorConfiguration(
      null, { id: 'a', input: { description: 'new public description', connection: {}, options: {}, resourceConfigs: {} } }, contextWith(operatorUser)
    );
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('connection =');
    expect(sql).not.toContain('options =');
    expect(sql).not.toContain('resource_configs =');
    expect(values).not.toContain('{}');
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it('scopes nested run history and metrics even when a forged parent is supplied', async () => {
    installScopedDatabase();
    await expectGraphQLErrorCode(
      ConnectorConfigurationFieldResolvers.runs({ id: 'b' }, {}, contextWith(operatorUser)), 'NOT_FOUND'
    );
    await expectGraphQLErrorCode(
      ConnectorConfigurationFieldResolvers.metrics({ id: 'legacy' }, {}, contextWith(operatorUser)), 'NOT_FOUND'
    );
  });


  it('prevents selecting saved secret fields while retaining write-only input', () => {
    const schema = buildSchema(`scalar JSON\nscalar DateTime\ntype Query { ready: Boolean }\ntype Mutation { ready: Boolean }\n${connectorTypeDefs}`);
    const selection = parse('{ connectorConfiguration(id: "a") { connection options resourceConfigs notificationChannels } }');
    expect(validate(schema, selection)).toHaveLength(4);
    expect(schema.getType('UpdateConnectorConfigInput')?.toString()).toBe('UpdateConnectorConfigInput');
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
