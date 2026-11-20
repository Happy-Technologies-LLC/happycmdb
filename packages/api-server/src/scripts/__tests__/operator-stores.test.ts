// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * `openOperatorStores` (rotate-user-password, identity-window) accepts only a plain `bolt://` or `neo4j://` URI.
 * A `+ssc` scheme would make the driver trust any certificate; TLS is selected only by
 * CMDB_ROTATE_NEO4J_ENCRYPTED=true (system-CA verification).
 */
import neo4j from 'neo4j-driver';
import { logger } from '@cmdb/common';
import { PostgresClient } from '../../../../database/src/postgres/client';
import { assertPlainNeo4jUri, API_SERVER_CLIENT_ENV_NAMES, isolateOperatorEnvironment, openOperatorStores } from '../operator-stores';

jest.mock('neo4j-driver', () => ({
  __esModule: true,
  default: {
    driver: jest.fn(),
    auth: { basic: () => ({}) },
  },
}));
jest.mock('../../../../database/src/postgres/client', () => ({
  PostgresClient: jest.fn(),
}));

const driverMock = neo4j.driver as unknown as jest.Mock;
const postgresMock = PostgresClient as unknown as jest.Mock;
const FIXED_MESSAGE =
  'CMDB_ROTATE_NEO4J_URI must be bolt://<host>[:port] or neo4j://<host>[:port] (use CMDB_ROTATE_NEO4J_ENCRYPTED=true for TLS)';

function envWith(uri: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CMDB_ROTATE_POSTGRES_HOST: 'pg',
    CMDB_ROTATE_POSTGRES_PORT: '5432',
    CMDB_ROTATE_POSTGRES_DB: 'cmdb',
    CMDB_ROTATE_POSTGRES_USER: 'u',
    CMDB_ROTATE_POSTGRES_PASSWORD: 'p',
    CMDB_ROTATE_NEO4J_URI: uri,
    CMDB_ROTATE_NEO4J_USERNAME: 'neo4j',
    CMDB_ROTATE_NEO4J_PASSWORD: 'p',
    ...extra,
  };
}

const SAVED_ENV = new Map<string, string | undefined>();

// The API server's own TLS toggles must not leak in from the CI host or a developer shell.
beforeEach(() => {
  for (const name of API_SERVER_CLIENT_ENV_NAMES) {
    SAVED_ENV.set(name, process.env[name]);
  }
  isolateOperatorEnvironment(process.env);
  driverMock.mockReset();
  driverMock.mockReturnValue({});
  postgresMock.mockReset();
  postgresMock.mockReturnValue({});
  jest.spyOn(logger, 'info').mockImplementation(() => logger);
  jest.spyOn(logger, 'warn').mockImplementation(() => logger);
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const [name, value] of SAVED_ENV) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  SAVED_ENV.clear();
});

describe('openOperatorStores CMDB_ROTATE_NEO4J_URI', () => {
  it.each([
    'bolt+s://h',
    'bolt+ssc://h',
    'neo4j+s://h',
    'neo4j+ssc://h:7687',
    'BOLT://h',
    'bolt://user:secret@h',
    'bolt://h/db',
    'bolt://h?x=1',
    'bolt://h#f',
    'bolt://',
  ])('refuses %s with the fixed message, before any client is built', (uri) => {
    let message = '';
    try {
      openOperatorStores(envWith(uri, { CMDB_ROTATE_NEO4J_ENCRYPTED: 'true' }));
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe(FIXED_MESSAGE);
    expect(message).not.toContain('secret');
    expect(postgresMock).not.toHaveBeenCalled();
    expect(driverMock).not.toHaveBeenCalled();
  });

  it.each(['bolt://h:7687', 'neo4j://h'])('accepts %s', (uri) => {
    openOperatorStores(envWith(uri));

    expect(postgresMock).toHaveBeenCalledTimes(1);
    expect(driverMock).toHaveBeenCalledTimes(1);
    expect(driverMock.mock.calls[0][0]).toBe(uri);
    expect(driverMock.mock.calls[0][2].encrypted).toBe('ENCRYPTION_OFF');
  });

  describe('with the API server TLS toggles exported by the host', () => {
    const HOST_TOGGLES = ['NEO4J_SSL_ENABLED', 'NEO4J_ENCRYPTION', 'NEO4J_ENCRYPTED'];
    const original = new Map<string, string | undefined>();

    beforeAll(() => {
      for (const name of HOST_TOGGLES) {
        original.set(name, process.env[name]);
        process.env[name] = 'true';
      }
    });

    afterAll(() => {
      for (const [name, value] of original) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    });

    it('still connects plain: the suite scrubs them before each test', () => {
      expect(process.env['NEO4J_SSL_ENABLED']).toBeUndefined();
      openOperatorStores(envWith('bolt://h:7687'));

      expect(driverMock.mock.calls[0][2].encrypted).toBe('ENCRYPTION_OFF');
    });
  });

  it('gives CMDB_ROTATE_NEO4J_ENCRYPTED=true encryption with system-CA trust, not trust-all', () => {
    openOperatorStores(envWith('neo4j://h', { CMDB_ROTATE_NEO4J_ENCRYPTED: 'true' }));

    const config = driverMock.mock.calls[0][2];
    expect(config.encrypted).toBe('ENCRYPTION_ON');
    expect(config.trust).toBe('TRUST_SYSTEM_CA_SIGNED_CERTIFICATES');
  });
});

describe('assertPlainNeo4jUri', () => {
  const message = (variable: string, encryptedVariable: string): string =>
    `${variable} must be bolt://<host>[:port] or neo4j://<host>[:port] (use ${encryptedVariable}=true for TLS)`;

  it.each([
    'bolt://h',
    'bolt://h:7687',
    'neo4j://db.example.internal:7687',
    'bolt://127.0.0.1:1',
    'bolt://[::1]:7687',
    'neo4j://[fe80::1]',
    'bolt://[::ffff:127.0.0.1]',
    'bolt://h:1',
    'bolt://h:65535',
  ])('accepts %s', (uri) => {
    expect(() => assertPlainNeo4jUri(uri, 'V', 'E')).not.toThrow();
  });

  it.each([
    'bolt://h\n',
    'bolt://h ',
    ' bolt://h',
    'bolt://h\t',
    'bolt://h%41',
    'bolt://h\\x',
    'bolt://h:abc',
    'bolt://h:',
    'bolt://h:123456',
    'bolt://h:0',
    'bolt://h:00000',
    'bolt://h:65536',
    'bolt://h:99999',
    'bolt://[.]',
    'bolt://[...]',
    'bolt://[]',
    'bolt://[1.2.3.4]',
    'bolt://[1.2.3.4]:7687',
    'bolt://:7687',
    'bolt://',
    'BOLT://h',
    'bolt+s://h',
    'bolt+ssc://h',
    'neo4j+s://h',
    'u:p@bolt://h',
    'bolt://u:p@h',
    'bolt://h/db',
    'bolt://h?x=1',
    'bolt://h#f',
  ])('refuses %j with the fixed message that does not carry the value', (uri) => {
    let thrown = '';
    try {
      assertPlainNeo4jUri(uri, 'CMDB_X_NEO4J_URI', 'CMDB_X_NEO4J_ENCRYPTED');
    } catch (error) {
      thrown = (error as Error).message;
    }
    // Exact equality with a text built from the variable names only: the value cannot be in it.
    expect(thrown).toBe(message('CMDB_X_NEO4J_URI', 'CMDB_X_NEO4J_ENCRYPTED'));
  });
});
