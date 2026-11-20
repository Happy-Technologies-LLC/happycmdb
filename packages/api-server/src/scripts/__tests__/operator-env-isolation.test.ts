// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator tools (credential rotation, identity window, backfill, seed) define their connections only through their
 * own CMDB_* variables. `isolateOperatorEnvironment` must remove every API-server toggle the shared clients read from
 * `process.env`, or an ambient `NEO4J_ENCRYPTED=true` overrides the tool's `{ encrypted: false }`.
 */
import neo4j from 'neo4j-driver';
import { logger } from '@cmdb/common';
import { Neo4jClient } from '../../../../database/src/neo4j/client';
import { isolateOperatorEnvironment } from '../operator-stores';

jest.mock('neo4j-driver', () => ({
  __esModule: true,
  default: {
    driver: jest.fn(),
    auth: { basic: () => ({}) },
  },
}));

const driverMock = neo4j.driver as unknown as jest.Mock;
const originalEnv = process.env;
/** Every variable PostgresClient / Neo4jClient read ambiently for TLS; spelled out so a dropped name is caught. */
const CLIENT_TLS_ENV_NAMES = [
  'POSTGRES_SSL_MODE',
  'POSTGRES_SSL_ENABLED',
  'POSTGRES_SSL_CA_FILE',
  'NEO4J_SSL_ENABLED',
  'NEO4J_ENCRYPTION',
  'NEO4J_ENCRYPTED',
  'NEO4J_SSL_TRUST_STRATEGY',
];

beforeEach(() => {
  process.env = { ...originalEnv };
  driverMock.mockReset();
  driverMock.mockReturnValue({});
  jest.spyOn(logger, 'info').mockImplementation(() => logger);
  jest.spyOn(logger, 'warn').mockImplementation(() => logger);
});

afterEach(() => {
  process.env = originalEnv;
  jest.restoreAllMocks();
});

describe('isolateOperatorEnvironment', () => {
  it('removes every API-server client toggle and keeps unrelated variables', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', CMDB_ROTATE_NEO4J_URI: 'bolt://h' };
    for (const name of CLIENT_TLS_ENV_NAMES) env[name] = 'true';

    isolateOperatorEnvironment(env);

    expect(env).toEqual({ PATH: '/usr/bin', CMDB_ROTATE_NEO4J_URI: 'bolt://h' });
  });

  it('lets { encrypted: false } win over an ambient NEO4J_ENCRYPTED=true and TRUST_ALL_CERTIFICATES', () => {
    process.env['NEO4J_ENCRYPTED'] = 'true';
    process.env['NEO4J_SSL_TRUST_STRATEGY'] = 'TRUST_ALL_CERTIFICATES';

    isolateOperatorEnvironment(process.env);
    new Neo4jClient('bolt://h', 'u', 'p', { encrypted: false });

    const config = driverMock.mock.calls[0][2];
    expect(config.encrypted).toBe('ENCRYPTION_OFF');
    expect(config.trust).not.toBe('TRUST_ALL_CERTIFICATES');
  });

  it('gives { encrypted: true } the default system-CA trust, not the ambient TRUST_ALL_CERTIFICATES', () => {
    process.env['NEO4J_ENCRYPTED'] = 'true';
    process.env['NEO4J_SSL_TRUST_STRATEGY'] = 'TRUST_ALL_CERTIFICATES';

    isolateOperatorEnvironment(process.env);
    new Neo4jClient('bolt://h', 'u', 'p', { encrypted: true });

    const config = driverMock.mock.calls[0][2];
    expect(config.encrypted).toBe('ENCRYPTION_ON');
    expect(config.trust).toBe('TRUST_SYSTEM_CA_SIGNED_CERTIFICATES');
  });
});
