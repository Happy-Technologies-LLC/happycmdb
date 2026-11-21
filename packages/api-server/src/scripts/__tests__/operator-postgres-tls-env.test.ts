// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * With CMDB_*_POSTGRES_SSL=verify-full the operator tools must hand pg `ssl: { rejectUnauthorized: true }` whatever
 * TLS-weakening variables the shell carries. Node lets an explicit `rejectUnauthorized` win over
 * NODE_TLS_REJECT_UNAUTHORIZED=0, and pg ignores PGSSLMODE once `ssl` is set, so the tools need no refusal for either;
 * this pins the resulting pool config (and the connection options pg derives from it) for every tool that opens one,
 * both with the built-in trust store and with the tool-scoped CMDB_*_POSTGRES_SSL_CA_FILE bundle (`ca` is passed
 * next to `rejectUnauthorized: true`). It also pins that an unset SSL setting for a remote host refuses to build a
 * pool whatever the shell carries; the refusal messages themselves are covered by operator-stores.test.ts and
 * backfill-business-service-organization.test.ts.
 *
 * The real PostgresClient and pg are used; only the Pool's network calls are cut off. The tests never call
 * isolateOperatorEnvironment, so the POSTGRES_SSL_* rows prove that an explicit `verify-full` wins over those
 * variables inside the client; that the entry points isolate the environment is covered by the CLI process tests
 * (rotate-user-password.test.ts, backfill-business-service-organization.test.ts).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import pg from 'pg';
import type tls from 'tls';
import neo4j from 'neo4j-driver';
import { logger } from '@cmdb/common';
import { openOperatorStores } from '../operator-stores';
import { main as backfillMain } from '../backfill-business-service-organization';

jest.mock('neo4j-driver', () => ({
  __esModule: true,
  default: {
    driver: jest.fn(),
    auth: { basic: () => ({}) },
  },
}));

jest.mock('pg', () => {
  const actual = jest.requireActual('pg');
  const pools: unknown[] = [];
  class RecordingPool extends actual.Pool {
    constructor(options: unknown) {
      super(options);
      pools.push(this);
    }
    query(): Promise<never> {
      return Promise.reject(new Error('network disabled in test'));
    }
    connect(): Promise<never> {
      return Promise.reject(new Error('network disabled in test'));
    }
    end(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { __esModule: true, default: { ...actual, Pool: RecordingPool }, Pool: RecordingPool, __pools: pools };
});

const pools = (jest.requireMock('pg') as { __pools: Array<{ options: pg.PoolConfig }> }).__pools;
const driverMock = neo4j.driver as unknown as jest.Mock;
const originalEnv = process.env;
const CA_PEM = '-----BEGIN CERTIFICATE-----\nprivate-ca-for-test\n-----END CERTIFICATE-----\n';
let caDir: string;
let caFile: string;

beforeAll(() => {
  caDir = mkdtempSync(join(tmpdir(), 'operator-postgres-tls-env-'));
  caFile = join(caDir, 'ca.pem');
  writeFileSync(caFile, CA_PEM);
});

afterAll(() => rmSync(caDir, { recursive: true, force: true }));

const WEAKENING_ENVS: Array<[string, NodeJS.ProcessEnv]> = [
  ['NODE_TLS_REJECT_UNAUTHORIZED=0', { NODE_TLS_REJECT_UNAUTHORIZED: '0' }],
  ['PGSSLMODE=no-verify', { PGSSLMODE: 'no-verify' }],
  ['PGSSLMODE=disable', { PGSSLMODE: 'disable' }],
  ['POSTGRES_SSL_MODE=disable', { POSTGRES_SSL_MODE: 'disable' }],
  ['POSTGRES_SSL_ENABLED=off', { POSTGRES_SSL_ENABLED: 'off' }],
  [
    'all of them together',
    {
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      PGSSLMODE: 'no-verify',
      POSTGRES_SSL_MODE: 'disable',
      POSTGRES_SSL_ENABLED: 'off',
    },
  ],
];

const NEO4J_ENV = {
  NEO4J_URI: 'bolt://neo4j-host:7687',
  NEO4J_USERNAME: 'neo4j',
  NEO4J_PASSWORD: 'p',
};

function rotateEnv(): NodeJS.ProcessEnv {
  return {
    CMDB_ROTATE_POSTGRES_HOST: 'pg.example.test',
    CMDB_ROTATE_POSTGRES_PORT: '5432',
    CMDB_ROTATE_POSTGRES_DB: 'cmdb',
    CMDB_ROTATE_POSTGRES_USER: 'u',
    CMDB_ROTATE_POSTGRES_PASSWORD: 'p',
    CMDB_ROTATE_POSTGRES_SSL: 'verify-full',
    CMDB_ROTATE_NEO4J_URI: NEO4J_ENV.NEO4J_URI,
    CMDB_ROTATE_NEO4J_ENCRYPTED: 'true',
    CMDB_ROTATE_NEO4J_USERNAME: NEO4J_ENV.NEO4J_USERNAME,
    CMDB_ROTATE_NEO4J_PASSWORD: NEO4J_ENV.NEO4J_PASSWORD,
  };
}

function backfillEnv(): NodeJS.ProcessEnv {
  return {
    CMDB_BACKFILL_POSTGRES_HOST: 'pg.example.test',
    CMDB_BACKFILL_POSTGRES_PORT: '5432',
    CMDB_BACKFILL_POSTGRES_DB: 'cmdb',
    CMDB_BACKFILL_POSTGRES_USER: 'u',
    CMDB_BACKFILL_POSTGRES_PASSWORD: 'p',
    CMDB_BACKFILL_POSTGRES_SSL: 'verify-full',
    CMDB_BACKFILL_NEO4J_URI: NEO4J_ENV.NEO4J_URI,
    CMDB_BACKFILL_NEO4J_ENCRYPTED: 'true',
    CMDB_BACKFILL_NEO4J_USERNAME: NEO4J_ENV.NEO4J_USERNAME,
    CMDB_BACKFILL_NEO4J_PASSWORD: NEO4J_ENV.NEO4J_PASSWORD,
  };
}

/** The ssl pg's Client resolves from the pool options, after pg's own PGSSLMODE handling. */
function connectionSsl(options: pg.PoolConfig): unknown {
  return new pg.Client(options).connectionParameters.ssl;
}

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env['PGSSLMODE'];
  pools.length = 0;
  driverMock.mockReset();
  driverMock.mockReturnValue({ close: async () => undefined, session: () => ({ close: async () => undefined }) });
  jest.spyOn(logger, 'info').mockImplementation(() => logger);
  jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  jest.spyOn(logger, 'error').mockImplementation(() => logger);
});

afterEach(() => {
  process.env = originalEnv;
  jest.restoreAllMocks();
});

const TRUST_ROUTES: Array<[string, { withCaFile: boolean }]> = [
  ['the built-in trust store', { withCaFile: false }],
  ['a CMDB_*_POSTGRES_SSL_CA_FILE bundle', { withCaFile: true }],
];

describe.each(WEAKENING_ENVS)('verify-full with %s in the environment', (_label, weakening) => {
  describe.each(TRUST_ROUTES)('trusting %s', (_route, { withCaFile }) => {
    const expectedSsl = withCaFile ? { rejectUnauthorized: true, ca: CA_PEM } : { rejectUnauthorized: true };

    it('keeps rejectUnauthorized: true for the rotation and identity-window stores', async () => {
      Object.assign(process.env, weakening);

      const stores = openOperatorStores({ ...rotateEnv(), ...(withCaFile ? { CMDB_ROTATE_POSTGRES_SSL_CA_FILE: caFile } : {}) });

      expect(pools).toHaveLength(1);
      expect(pools[0].options.ssl).toEqual(expectedSsl);
      expect(connectionSsl(pools[0].options)).toEqual(expectedSsl);
      await stores.close();
    });

    it('keeps rejectUnauthorized: true for the organization backfill', async () => {
      Object.assign(process.env, weakening);

      await backfillMain(
        ['--created-before', '2026-01-01T00:00:00Z', '--writer-timezone', 'Etc/UTC'],
        { ...backfillEnv(), ...(withCaFile ? { CMDB_BACKFILL_POSTGRES_SSL_CA_FILE: caFile } : {}) },
        { stdout: () => undefined, stderr: () => undefined }
      );

      expect(pools).toHaveLength(1);
      expect(pools[0].options.ssl).toEqual(expectedSsl);
      expect(connectionSsl(pools[0].options)).toEqual(expectedSsl);
    });
  });
});

describe.each(WEAKENING_ENVS)('an unset POSTGRES_SSL setting on a remote host, with %s in the environment', (_label, weakening) => {
  it('refuses the rotation and identity-window stores before a pool exists', () => {
    Object.assign(process.env, weakening);
    const env = rotateEnv();
    delete env['CMDB_ROTATE_POSTGRES_SSL'];

    expect(() => openOperatorStores(env)).toThrow('CMDB_ROTATE_POSTGRES_SSL must be set for a non-loopback host');
    expect(pools).toHaveLength(0);
  });

  it('refuses the organization backfill before a pool exists', async () => {
    Object.assign(process.env, weakening);
    const env = backfillEnv();
    delete env['CMDB_BACKFILL_POSTGRES_SSL'];
    let stderr = '';

    const code = await backfillMain(
      ['--created-before', '2026-01-01T00:00:00Z', '--writer-timezone', 'Etc/UTC'],
      env,
      { stdout: () => undefined, stderr: text => { stderr += text; } }
    );

    expect(code).not.toBe(0);
    expect(stderr).toContain('CMDB_BACKFILL_POSTGRES_SSL must be set for a non-loopback host');
    expect(pools).toHaveLength(0);
  });
});

describe('verify-full with an IP-address host', () => {
  it('pins the identity check to the configured IP, not to the connection servername', async () => {
    const stores = openOperatorStores({ ...rotateEnv(), CMDB_ROTATE_POSTGRES_HOST: '192.0.2.10' });

    const ssl = pools[0].options.ssl as { rejectUnauthorized: boolean; checkServerIdentity: tls.CheckServerIdentityFunction };
    expect(ssl.rejectUnauthorized).toBe(true);
    const certFor = (san: string) => ({ subject: { CN: 'pg' }, subjectaltname: san }) as unknown as tls.PeerCertificate;
    expect(ssl.checkServerIdentity('localhost', certFor('IP Address:192.0.2.10'))).toBeUndefined();
    expect(ssl.checkServerIdentity('localhost', certFor('IP Address:192.0.2.99'))?.message).toContain('192.0.2.10');
    await stores.close();
  });
});
