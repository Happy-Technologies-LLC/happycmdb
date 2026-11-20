// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * With CMDB_*_POSTGRES_SSL=verify-full the operator tools must hand pg `ssl: { rejectUnauthorized: true }` whatever
 * TLS-weakening variables the shell carries. Node lets an explicit `rejectUnauthorized` win over
 * NODE_TLS_REJECT_UNAUTHORIZED=0, and pg ignores PGSSLMODE once `ssl` is set, so the tools need no refusal for either;
 * this pins the resulting pool config (and the connection options pg derives from it) for every tool that opens one.
 *
 * The real PostgresClient and pg are used; only the Pool's network calls are cut off.
 */
import pg from 'pg';
import neo4j from 'neo4j-driver';
import { logger } from '@cmdb/common';
import { openOperatorStores, isolateOperatorEnvironment } from '../operator-stores';
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

describe.each(WEAKENING_ENVS)('verify-full with %s in the environment', (_label, weakening) => {
  it('keeps ssl { rejectUnauthorized: true } for the rotation and identity-window stores', async () => {
    Object.assign(process.env, weakening);
    isolateOperatorEnvironment(process.env);

    const stores = openOperatorStores(rotateEnv());

    expect(pools).toHaveLength(1);
    expect(pools[0].options.ssl).toEqual({ rejectUnauthorized: true });
    expect(connectionSsl(pools[0].options)).toEqual({ rejectUnauthorized: true });
    await stores.close();
  });

  it('keeps ssl { rejectUnauthorized: true } for the organization backfill', async () => {
    Object.assign(process.env, weakening);
    isolateOperatorEnvironment(process.env);

    await backfillMain(
      ['--created-before', '2026-01-01T00:00:00Z', '--writer-timezone', 'Etc/UTC'],
      backfillEnv(),
      { stdout: () => undefined, stderr: () => undefined }
    );

    expect(pools).toHaveLength(1);
    expect(pools[0].options.ssl).toEqual({ rejectUnauthorized: true });
    expect(connectionSsl(pools[0].options)).toEqual({ rejectUnauthorized: true });
  });
});
