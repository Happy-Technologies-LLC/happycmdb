// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector Lifecycle Integration Tests
 *
 * Service-level coverage of ConnectorRegistry, ConnectorInstaller and
 * ConnectorExecutor against the shared (global) Postgres + Neo4j containers.
 * The full canonical schema (installed_connectors, connector_configurations,
 * connector_run_history, ...) is already loaded by the global setup.
 */

import { Pool } from 'pg';
import neo4j, { Driver } from 'neo4j-driver';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { getPostgresClient } from '@cmdb/database';
import { ConnectorRegistry } from '../../src/registry/connector-registry';
import { ConnectorInstaller } from '../../src/installer/connector-installer';
import { ConnectorExecutor } from '../../src/executor/connector-executor';
import { ConnectorMetadata } from '../../src/types/connector.types';

/**
 * Build a canonical-shaped connector.json payload for a given type/version.
 * Named because it encodes the required ConnectorMetadata contract (category,
 * capabilities, ...) reused by every install test.
 */
function makeMeta(
  type: string,
  version: string,
  overrides: Partial<ConnectorMetadata> = {}
): ConnectorMetadata {
  return {
    type,
    name: `Connector ${type}`,
    version,
    description: `Test connector ${type}`,
    author: 'integration-test',
    verified: false,
    category: 'connector',
    resources: [
      {
        id: 'servers',
        name: 'Servers',
        description: 'Server resources',
        ci_type: 'server',
        operations: ['extract', 'transform'],
        enabled_by_default: true,
        field_mappings: { name: '$.name', status: '$.state' },
      },
    ],
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

/**
 * Package a connector directory into a .tar.gz the real installer can consume
 * via installConnector(type, { localPath }). The installer extracts the archive,
 * runs `npm install` + build, then reads connector.json and dist/index.js — so
 * the archive layout (connector.json / package.json / dist) mirrors a real
 * published connector package.
 */
function buildTarball(
  buildRoot: string,
  name: string,
  connectorJson: unknown,
  opts: { dist?: boolean; packageJson?: boolean } = {}
): string {
  const dir = fs.mkdtempSync(path.join(buildRoot, `${name}-`));
  const entries: string[] = ['connector.json'];
  fs.writeFileSync(
    path.join(dir, 'connector.json'),
    JSON.stringify(connectorJson, null, 2)
  );

  if (opts.packageJson !== false) {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', private: true }, null, 2)
    );
    entries.push('package.json');
  }

  if (opts.dist !== false) {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'dist', 'index.js'),
      'class TestConnector { async discover() { return []; } }\n' +
        'module.exports = TestConnector;\n' +
        'module.exports.default = TestConnector;\n'
    );
    entries.push('dist');
  }

  const tarball = path.join(dir, `${name}.tar.gz`);
  execSync(`tar -czf "${tarball}" -C "${dir}" ${entries.join(' ')}`);
  return tarball;
}

interface ConfigRow {
  name: string;
  description: string | null;
  connector_type: string;
  enabled: boolean;
  schedule: string | null;
}

describe('Connector Lifecycle Integration Tests', () => {
  let pool: Pool;
  let neo4jDriver: Driver;
  let registry: ConnectorRegistry;
  let installer: ConnectorInstaller;
  let executor: ConnectorExecutor;
  let connectorsDir: string;
  let buildRoot: string;

  const createdConfigIds: string[] = [];
  const installedTypes: string[] = [];

  beforeAll(() => {
    pool = getPostgresClient().pool;
    neo4jDriver = neo4j.driver(
      process.env.NEO4J_URI!,
      neo4j.auth.basic(process.env.NEO4J_USERNAME!, process.env.NEO4J_PASSWORD!)
    );

    connectorsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdb-connectors-'));
    buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdb-connector-build-'));

    registry = ConnectorRegistry.getInstance();
    installer = ConnectorInstaller.getInstance(connectorsDir);
    executor = ConnectorExecutor.getInstance();
  });

  afterEach(async () => {
    if (createdConfigIds.length > 0) {
      // connector_run_history cascades from connector_configurations.
      await pool.query(
        'DELETE FROM connector_configurations WHERE id = ANY($1::uuid[])',
        [createdConfigIds]
      );
      createdConfigIds.length = 0;
    }

    if (installedTypes.length > 0) {
      // connector_configurations cascades from installed_connectors.
      await pool.query(
        'DELETE FROM installed_connectors WHERE connector_type = ANY($1::text[])',
        [installedTypes]
      );
      installedTypes.length = 0;
    }

    const session = neo4jDriver.session();
    try {
      await session.run('MATCH (n) DETACH DELETE n');
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    await neo4jDriver.close();
    fs.rmSync(connectorsDir, { recursive: true, force: true });
    fs.rmSync(buildRoot, { recursive: true, force: true });
  });

  describe('Connector Installation', () => {
    it('should install a connector package and register it', async () => {
      const type = `json-connector-${Date.now()}`;
      installedTypes.push(type);
      const tarball = buildTarball(buildRoot, type, makeMeta(type, '1.0.0'));

      await installer.installConnector(type, { localPath: tarball });

      const status = await installer.getConnectorStatus(type);
      expect(status.installed).toBe(true);
      expect(status.version).toBe('1.0.0');
      expect(status.install_path).toContain(type);

      expect(registry.hasConnectorType(type)).toBe(true);

      const installed = await installer.listInstalledConnectors();
      const connector = installed.find((c) => c.connector_type === type);
      expect(connector).toBeDefined();
      expect(connector?.version).toBe('1.0.0');
      expect(connector?.metadata.name).toBe(`Connector ${type}`);
      expect(connector?.metadata.category).toBe('connector');
    }, 60000);

    it('should install a second connector with a distinct type', async () => {
      const type = `ts-connector-${Date.now()}`;
      installedTypes.push(type);
      const tarball = buildTarball(
        buildRoot,
        type,
        makeMeta(type, '1.0.0', { name: 'TypeScript Connector' })
      );

      await installer.installConnector(type, { localPath: tarball });

      const installed = await installer.listInstalledConnectors();
      const connector = installed.find((c) => c.connector_type === type);
      expect(connector).toBeDefined();
      expect(connector?.metadata.name).toBe('TypeScript Connector');
      expect(connector?.metadata.type).toBe(type);
    }, 60000);

    it('should reject a package whose connector.json type does not match the requested type', async () => {
      const type = `mismatch-connector-${Date.now()}`;
      installedTypes.push(type);
      // connector.json advertises a different type than the one we install as.
      const tarball = buildTarball(
        buildRoot,
        type,
        makeMeta(`${type}-other`, '1.0.0')
      );

      await expect(
        installer.installConnector(type, { localPath: tarball })
      ).rejects.toThrow(/type mismatch/i);
    }, 60000);

    it('should reject a package missing the built implementation (dist/index.js)', async () => {
      const type = `nodist-connector-${Date.now()}`;
      installedTypes.push(type);
      const tarball = buildTarball(buildRoot, type, makeMeta(type, '1.0.0'), {
        dist: false,
      });

      await expect(
        installer.installConnector(type, { localPath: tarball })
      ).rejects.toThrow(/implementation not found/i);
    }, 60000);
  });

  describe('Connector Configuration Management', () => {
    async function installFixtureConnector(type: string): Promise<void> {
      installedTypes.push(type);
      const tarball = buildTarball(buildRoot, type, makeMeta(type, '1.0.0'));
      await installer.installConnector(type, { localPath: tarball });
    }

    it('should create and retrieve a connector configuration', async () => {
      const type = `config-connector-${Date.now()}`;
      await installFixtureConnector(type);

      const configId = uuidv4();
      createdConfigIds.push(configId);
      await pool.query(
        `INSERT INTO connector_configurations (
          id, name, description, connector_type, connection, options,
          enabled, schedule, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          configId,
          `Config ${configId}`,
          'Test connector configuration',
          type,
          { api_key: 'test-api-key-12345', base_url: 'https://api.example.com' },
          { timeout: 30000, retry_count: 3 },
          true,
          '0 */6 * * *',
          'test-user',
        ]
      );

      const result = await pool.query<ConfigRow>(
        'SELECT * FROM connector_configurations WHERE id = $1',
        [configId]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].name).toBe(`Config ${configId}`);
      expect(result.rows[0].connector_type).toBe(type);
      expect(result.rows[0].enabled).toBe(true);
    }, 60000);

    it('should update a connector configuration', async () => {
      const type = `update-connector-${Date.now()}`;
      await installFixtureConnector(type);

      const configId = uuidv4();
      createdConfigIds.push(configId);
      await pool.query(
        `INSERT INTO connector_configurations (
          id, name, description, connector_type, connection, enabled, schedule, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          configId,
          `Initial ${configId}`,
          'Initial description',
          type,
          { api_key: 'initial-key' },
          true,
          '0 0 * * *',
          'test-user',
        ]
      );

      await pool.query(
        `UPDATE connector_configurations
         SET name = $1, description = $2, schedule = $3, enabled = $4, updated_at = NOW()
         WHERE id = $5`,
        [`Updated ${configId}`, 'Updated description', '0 */12 * * *', false, configId]
      );

      const result = await pool.query<ConfigRow>(
        'SELECT * FROM connector_configurations WHERE id = $1',
        [configId]
      );

      expect(result.rows[0].name).toBe(`Updated ${configId}`);
      expect(result.rows[0].description).toBe('Updated description');
      expect(result.rows[0].schedule).toBe('0 */12 * * *');
      expect(result.rows[0].enabled).toBe(false);
    }, 60000);

    it('should deactivate a connector configuration', async () => {
      const type = `deactivate-connector-${Date.now()}`;
      await installFixtureConnector(type);

      const configId = uuidv4();
      createdConfigIds.push(configId);
      await pool.query(
        `INSERT INTO connector_configurations (
          id, name, connector_type, connection, enabled, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [configId, `Active ${configId}`, type, { api_key: 'test-key' }, true, 'test-user']
      );

      await pool.query(
        'UPDATE connector_configurations SET enabled = false WHERE id = $1',
        [configId]
      );

      const result = await pool.query<{ enabled: boolean }>(
        'SELECT enabled FROM connector_configurations WHERE id = $1',
        [configId]
      );

      expect(result.rows[0].enabled).toBe(false);
    }, 60000);
  });

  describe('Connector Execution', () => {
    it('should persist discovered CIs to Neo4j', async () => {
      const mockCIs = [
        { id: uuidv4(), name: 'test-server-01', ip: '10.0.1.10' },
        { id: uuidv4(), name: 'test-server-02', ip: '10.0.1.11' },
      ];

      const session = neo4jDriver.session();
      try {
        for (const ci of mockCIs) {
          await session.run(
            `CREATE (ci:CI:Server {
              id: $id,
              name: $name,
              type: 'server',
              status: 'active',
              environment: 'production',
              metadata: $metadata,
              discovered_at: datetime($discovered_at)
            })`,
            {
              id: ci.id,
              name: ci.name,
              metadata: JSON.stringify({ ip: ci.ip, status: 'running' }),
              discovered_at: new Date().toISOString(),
            }
          );
        }

        const result = await session.run(
          'MATCH (ci:CI:Server) WHERE ci.name IN $names RETURN ci ORDER BY ci.name',
          { names: mockCIs.map((ci) => ci.name) }
        );

        expect(result.records.length).toBe(2);
        const names = result.records.map(
          (r) => (r.get('ci').properties as { name: string }).name
        );
        expect(names).toEqual(['test-server-01', 'test-server-02']);
      } finally {
        await session.close();
      }
    }, 60000);

    it('should reject execution when the configuration does not exist', async () => {
      await expect(executor.executeConnector(uuidv4())).rejects.toThrow(
        /configuration not found/i
      );
    }, 60000);

    it('should reject execution when no resources are enabled', async () => {
      const type = `exec-connector-${Date.now()}`;
      installedTypes.push(type);
      const tarball = buildTarball(buildRoot, type, makeMeta(type, '1.0.0'));
      await installer.installConnector(type, { localPath: tarball });

      const configId = uuidv4();
      createdConfigIds.push(configId);
      // enabled_resources intentionally omitted (NULL) -> no resources to run.
      await pool.query(
        `INSERT INTO connector_configurations (
          id, name, connector_type, connection, enabled, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [configId, `Exec ${configId}`, type, { api_key: 'test-key' }, true, 'test-user']
      );

      await expect(executor.executeConnector(configId)).rejects.toThrow(
        /no resources enabled/i
      );
    }, 60000);
  });

  describe('Connector Update', () => {
    it('should upgrade a connector to a newer version', async () => {
      const type = `upgrade-connector-${Date.now()}`;
      installedTypes.push(type);

      const v1 = buildTarball(buildRoot, type, makeMeta(type, '1.0.0'));
      await installer.installConnector(type, { localPath: v1 });

      let installed = await installer.listInstalledConnectors();
      let connector = installed.find((c) => c.connector_type === type);
      expect(connector?.version).toBe('1.0.0');

      const v2 = buildTarball(
        buildRoot,
        type,
        makeMeta(type, '2.0.0', { description: 'Upgraded connector v2' })
      );
      await installer.updateConnector(type, { localPath: v2 });

      installed = await installer.listInstalledConnectors();
      connector = installed.find((c) => c.connector_type === type);
      expect(connector?.version).toBe('2.0.0');
      expect(connector?.metadata.description).toBe('Upgraded connector v2');
    }, 90000);
  });

  describe('Connector Uninstallation', () => {
    it('should uninstall a connector', async () => {
      const type = `uninstall-connector-${Date.now()}`;
      installedTypes.push(type);
      const tarball = buildTarball(buildRoot, type, makeMeta(type, '1.0.0'));
      await installer.installConnector(type, { localPath: tarball });

      let installed = await installer.listInstalledConnectors();
      expect(installed.find((c) => c.connector_type === type)).toBeDefined();

      await installer.uninstallConnector(type);

      installed = await installer.listInstalledConnectors();
      expect(installed.find((c) => c.connector_type === type)).toBeUndefined();

      const status = await installer.getConnectorStatus(type);
      expect(status.installed).toBe(false);
    }, 60000);

    it('should cascade-delete configurations when its connector is uninstalled', async () => {
      // NOTE: restructured from the original "prevent uninstallation with active
      // configurations" test. The real ConnectorInstaller does NOT block uninstall
      // when configurations exist — installed_connectors -> connector_configurations
      // has ON DELETE CASCADE, so uninstall succeeds and its configs are removed.
      const type = `cascade-connector-${Date.now()}`;
      installedTypes.push(type);
      const tarball = buildTarball(buildRoot, type, makeMeta(type, '1.0.0'));
      await installer.installConnector(type, { localPath: tarball });

      const configId = uuidv4();
      await pool.query(
        `INSERT INTO connector_configurations (
          id, name, connector_type, connection, enabled, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [configId, `Cascade ${configId}`, type, { api_key: 'test-key' }, true, 'test-user']
      );

      await installer.uninstallConnector(type);

      const connectorRows = await pool.query(
        'SELECT 1 FROM installed_connectors WHERE connector_type = $1',
        [type]
      );
      expect(connectorRows.rows.length).toBe(0);

      const configRows = await pool.query(
        'SELECT 1 FROM connector_configurations WHERE id = $1',
        [configId]
      );
      expect(configRows.rows.length).toBe(0);
    }, 60000);
  });
});
