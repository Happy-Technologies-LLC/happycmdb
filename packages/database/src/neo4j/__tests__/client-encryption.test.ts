// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Neo4j TLS configuration: which `Config` the constructor hands to `neo4j.driver` for the main and the journal driver.
 * neo4j-driver refuses `encrypted`/`trust` in the config next to a URL scheme that already carries them, so a
 * `+s`/`+ssc` URI must reach the driver without those keys.
 */
import neo4j from 'neo4j-driver';
import { logger } from '@cmdb/common';
import { Neo4jClient } from '../client';

jest.mock('neo4j-driver', () => ({
  __esModule: true,
  default: {
    driver: jest.fn(),
    auth: { basic: () => ({}) },
  },
}));

const ENV_KEYS = ['NEO4J_SSL_ENABLED', 'NEO4J_ENCRYPTION', 'NEO4J_ENCRYPTED', 'NEO4J_SSL_TRUST_STRATEGY'] as const;
const saved: Record<string, string | undefined> = {};
const driverMock = neo4j.driver as unknown as jest.Mock;

beforeEach(() => {
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  driverMock.mockReset();
  driverMock.mockReturnValue({ session: () => ({ run: async () => ({ records: [] }), close: async () => undefined }) });
  jest.spyOn(logger, 'info').mockImplementation(() => logger);
  jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  jest.spyOn(logger, 'error').mockImplementation(() => logger);
  jest.spyOn(logger, 'debug').mockImplementation(() => logger);
});

afterEach(() => {
  for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  jest.restoreAllMocks();
});

const mainConfig = () => driverMock.mock.calls[0][2];
const journalConfig = async (client: Neo4jClient) => {
  await (client as unknown as { runJournalStatement: (q: string, p: object) => Promise<unknown> }).runJournalStatement('RETURN 1', {});
  return driverMock.mock.calls[1][2];
};
const loggedText = () => JSON.stringify([logger.info, logger.warn, logger.error, logger.debug].map(fn => (fn as jest.Mock).mock.calls));

describe('plain bolt:// and neo4j:// URIs', () => {
  it.each(['NEO4J_ENCRYPTED', 'NEO4J_SSL_ENABLED', 'NEO4J_ENCRYPTION'])('%s=true turns encryption on', name => {
    process.env[name] = 'true';
    new Neo4jClient('bolt://x', 'u', 'p');
    expect(mainConfig().encrypted).toBe('ENCRYPTION_ON');
  });

  it.each(['false', '1', '', 'TRUE'])('NEO4J_ENCRYPTED=%p leaves encryption off', value => {
    process.env['NEO4J_ENCRYPTED'] = value;
    new Neo4jClient('neo4j://x', 'u', 'p');
    expect(mainConfig().encrypted).toBe('ENCRYPTION_OFF');
  });

  it('unset variables leave encryption off and warn', () => {
    new Neo4jClient('bolt://x', 'u', 'p');
    expect(mainConfig().encrypted).toBe('ENCRYPTION_OFF');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('the constructor option { encrypted: true } turns encryption on', () => {
    new Neo4jClient('bolt://x', 'u', 'p', { encrypted: true });
    expect(mainConfig().encrypted).toBe('ENCRYPTION_ON');
  });

  it('the journal driver gets the same encryption', async () => {
    process.env['NEO4J_ENCRYPTED'] = 'true';
    const client = new Neo4jClient('bolt://x', 'u', 'p');
    expect((await journalConfig(client)).encrypted).toBe('ENCRYPTION_ON');
  });

  it('the trust strategy defaults to system CA and follows NEO4J_SSL_TRUST_STRATEGY', () => {
    new Neo4jClient('bolt://x', 'u', 'p');
    expect(mainConfig().trust).toBe('TRUST_SYSTEM_CA_SIGNED_CERTIFICATES');
    driverMock.mockClear();
    process.env['NEO4J_SSL_TRUST_STRATEGY'] = 'TRUST_ALL_CERTIFICATES';
    new Neo4jClient('bolt://x', 'u', 'p');
    expect(mainConfig().trust).toBe('TRUST_ALL_CERTIFICATES');
  });
});

describe.each(['neo4j+s://h', 'neo4j+ssc://h', 'bolt+s://h'])('TLS-carrying URI %s', uri => {
  it.each([false, true])('reaches neo4j.driver without encrypted or trust (NEO4J_SSL_ENABLED set: %p)', enabled => {
    if (enabled) process.env['NEO4J_SSL_ENABLED'] = 'true';
    process.env['NEO4J_SSL_TRUST_STRATEGY'] = 'TRUST_ALL_CERTIFICATES';
    new Neo4jClient(uri, 'u', 'p', { encrypted: true, trust: 'TRUST_ALL_CERTIFICATES' });
    const config = mainConfig();
    expect(config).not.toHaveProperty('encrypted');
    expect(config).not.toHaveProperty('trust');
    expect(config).toHaveProperty('maxConnectionPoolSize', 50);
    expect(config).toHaveProperty('maxConnectionLifetime', 3 * 60 * 60 * 1000);
    expect(driverMock.mock.calls[0][0]).toBe(uri);
  });

  it('the journal driver gets no encrypted or trust either', async () => {
    process.env['NEO4J_SSL_ENABLED'] = 'true';
    const config = await journalConfig(new Neo4jClient(uri, 'u', 'p'));
    expect(config).not.toHaveProperty('encrypted');
    expect(config).not.toHaveProperty('trust');
    expect(config).toHaveProperty('maxConnectionPoolSize', 50);
    expect(config).toHaveProperty('connectionAcquisitionTimeout', 5_000);
  });

  it('logs that the URI scheme sets encryption and does not warn about plaintext', () => {
    new Neo4jClient(uri, 'u', 'p');
    expect(logger.info).toHaveBeenCalledWith('Neo4j client initialized with encryption set by the URI scheme');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

it('never logs the URI, whose userinfo can carry a password', () => {
  new Neo4jClient('neo4j+s://user:sentinel-pw@h', 'u', 'p');
  new Neo4jClient('bolt://user:sentinel-pw@h', 'u', 'p');
  expect(loggedText()).not.toContain('sentinel-pw');
  expect(loggedText()).not.toContain('user:');
});
