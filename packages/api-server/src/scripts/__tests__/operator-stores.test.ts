// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * `openOperatorStores` (rotate-user-password, identity-window) accepts only a plain `bolt://` or `neo4j://` URI.
 * A `+ssc` scheme would make the driver trust any certificate; TLS is selected only by
 * CMDB_ROTATE_NEO4J_ENCRYPTED=true (system-CA verification).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
    CMDB_ROTATE_POSTGRES_HOST: '127.0.0.1',
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

  it.each(['bolt://127.0.0.1:7687', 'neo4j://localhost'])('accepts %s', (uri) => {
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
      openOperatorStores(envWith('bolt://127.0.0.1:7687'));

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

describe('openOperatorStores TLS settings (CMDB_ROTATE_*)', () => {
  const PG_UNSET = 'CMDB_ROTATE_POSTGRES_SSL must be set for a non-loopback host';
  const NEO4J_UNSET = 'CMDB_ROTATE_NEO4J_ENCRYPTED must be set for a non-loopback host';
  const open = (uri: string, extra: NodeJS.ProcessEnv): void => void openOperatorStores(envWith(uri, extra));
  const caDirectory = mkdtempSync(join(tmpdir(), 'operator-tls-'));
  const caFile = (name: string, contents: string): string => {
    const path = join(caDirectory, name);
    writeFileSync(path, contents);
    return path;
  };
  afterAll(() => rmSync(caDirectory, { recursive: true, force: true }));

  it.each(['db.example', '192.0.2.10', '127.0.0.1.evil.com', 'localhost.example', '0.0.0.0', '::ffff:127.0.0.1'])(
    'refuses an unset CMDB_ROTATE_POSTGRES_SSL for %s, before any client is built', (host) => {
      expect(() => open('bolt://127.0.0.1:7687', { CMDB_ROTATE_POSTGRES_HOST: host })).toThrow(PG_UNSET);
      expect(postgresMock).not.toHaveBeenCalled();
      expect(driverMock).not.toHaveBeenCalled();
    });

  it.each(['bolt://db.example:7687', 'neo4j://192.0.2.10', 'bolt://127.0.0.1.evil.com', 'bolt://localhost.example', 'bolt://[fe80::1]'])(
    'refuses an unset CMDB_ROTATE_NEO4J_ENCRYPTED for %s, before any client is built', (uri) => {
      expect(() => open(uri, {})).toThrow(NEO4J_UNSET);
      expect(postgresMock).not.toHaveBeenCalled();
      expect(driverMock).not.toHaveBeenCalled();
    });

  it.each(['localhost', '127.0.0.1', '127.9.9.9', '::1', '/var/run/postgresql'])('allows an unset CMDB_ROTATE_POSTGRES_SSL for %s', (host) => {
    open('bolt://127.0.0.1:7687', { CMDB_ROTATE_POSTGRES_HOST: host });
    expect(postgresMock.mock.calls[0][0]).toMatchObject({ _host: host, ssl: false });
  });

  it.each(['bolt://localhost', 'bolt://127.0.0.1:7687', 'neo4j://127.1.2.3', 'bolt://[::1]:7687'])('allows an unset CMDB_ROTATE_NEO4J_ENCRYPTED for %s', (uri) => {
    open(uri, {});
    expect(driverMock.mock.calls[0][2].encrypted).toBe('ENCRYPTION_OFF');
  });

  const nonLoopbackWarnings = (): string[] =>
    (logger.warn as jest.Mock).mock.calls.map(call => String(call[0])).filter(text => text.includes('non-loopback host'));

  it('allows an explicit plaintext opt-out to a remote host and warns for each store', () => {
    open('bolt://db.example:7687', {
      CMDB_ROTATE_POSTGRES_HOST: 'db.example', CMDB_ROTATE_POSTGRES_SSL: 'disable', CMDB_ROTATE_NEO4J_ENCRYPTED: 'false',
    });

    expect(postgresMock.mock.calls[0][0]).toMatchObject({ _host: 'db.example', ssl: false });
    expect(driverMock.mock.calls[0][2].encrypted).toBe('ENCRYPTION_OFF');
    // The shared clients add their own "WITHOUT encryption" warnings; only the opt-out warnings are under test.
    const warnings = nonLoopbackWarnings();
    expect(warnings).toEqual([
      'CMDB_ROTATE_POSTGRES_SSL=disable: the PostgreSQL connection to a non-loopback host is NOT encrypted',
      'CMDB_ROTATE_NEO4J_ENCRYPTED=false: the Neo4j connection to a non-loopback host is NOT encrypted',
    ]);
  });

  it('does not warn for an explicit opt-out on loopback or for TLS to a remote host', () => {
    open('bolt://127.0.0.1:7687', { CMDB_ROTATE_POSTGRES_SSL: 'disable', CMDB_ROTATE_NEO4J_ENCRYPTED: 'false' });
    open('bolt://db.example', {
      CMDB_ROTATE_POSTGRES_HOST: 'db.example', CMDB_ROTATE_POSTGRES_SSL: 'verify-full', CMDB_ROTATE_NEO4J_ENCRYPTED: 'true',
    });

    expect(nonLoopbackWarnings()).toEqual([]);
    expect(postgresMock.mock.calls[1][0]).toMatchObject({ ssl: 'verify-full' });
  });

  it.each(['', 'false', 'off', 'verify-ca', 'TRUE'])('refuses CMDB_ROTATE_POSTGRES_SSL=%j', (value) => {
    expect(() => open('bolt://127.0.0.1:7687', { CMDB_ROTATE_POSTGRES_SSL: value }))
      .toThrow('CMDB_ROTATE_POSTGRES_SSL must be require, verify-full or disable when set');
  });

  it('refuses a missing CMDB_ROTATE_POSTGRES_SSL_CA_FILE without naming the path or building a client', () => {
    const missing = join(caDirectory, 'absent-ca.pem');
    let message = '';
    try {
      open('bolt://127.0.0.1:7687', { CMDB_ROTATE_POSTGRES_SSL: 'verify-full', CMDB_ROTATE_POSTGRES_SSL_CA_FILE: missing });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe('CMDB_ROTATE_POSTGRES_SSL_CA_FILE cannot be read');
    expect(postgresMock).not.toHaveBeenCalled();
    expect(driverMock).not.toHaveBeenCalled();
  });

  it('refuses an unreadable CA path (a directory) and an empty CA file instead of widening trust', () => {
    const env = { CMDB_ROTATE_POSTGRES_SSL: 'verify-full' };
    expect(() => open('bolt://127.0.0.1:7687', { ...env, CMDB_ROTATE_POSTGRES_SSL_CA_FILE: caDirectory }))
      .toThrow('CMDB_ROTATE_POSTGRES_SSL_CA_FILE cannot be read');
    expect(() => open('bolt://127.0.0.1:7687', { ...env, CMDB_ROTATE_POSTGRES_SSL_CA_FILE: caFile('empty.pem', ' \n') }))
      .toThrow('CMDB_ROTATE_POSTGRES_SSL_CA_FILE is empty or not a readable CA bundle');
    expect(() => open('bolt://127.0.0.1:7687', { ...env, CMDB_ROTATE_POSTGRES_SSL_CA_FILE: '' }))
      .toThrow('CMDB_ROTATE_POSTGRES_SSL_CA_FILE is empty or not a readable CA bundle');
    expect(postgresMock).not.toHaveBeenCalled();
  });

  it.each([undefined, 'require', 'disable'])('refuses a CA file when CMDB_ROTATE_POSTGRES_SSL is %s: it would be silently unused', (ssl) => {
    const extra: NodeJS.ProcessEnv = { CMDB_ROTATE_POSTGRES_SSL_CA_FILE: caFile('ca.pem', 'pem'), ...(ssl === undefined ? {} : { CMDB_ROTATE_POSTGRES_SSL: ssl }) };
    expect(() => open('bolt://127.0.0.1:7687', extra))
      .toThrow('CMDB_ROTATE_POSTGRES_SSL_CA_FILE needs CMDB_ROTATE_POSTGRES_SSL=verify-full');
  });

  it('passes the CA file contents to the Postgres client with verify-full', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nprivate\n-----END CERTIFICATE-----\n';
    open('bolt://127.0.0.1:7687', {
      CMDB_ROTATE_POSTGRES_HOST: 'db.example', CMDB_ROTATE_POSTGRES_SSL: 'verify-full',
      CMDB_ROTATE_POSTGRES_SSL_CA_FILE: caFile('private-ca.pem', pem),
    });

    expect(postgresMock.mock.calls[0][0]).toMatchObject({ _host: 'db.example', ssl: 'verify-full', sslCa: pem });
  });
});
