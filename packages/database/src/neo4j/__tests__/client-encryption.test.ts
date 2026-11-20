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

  it.each(['false', ''])('NEO4J_ENCRYPTED=%p leaves encryption off', value => {
    process.env['NEO4J_ENCRYPTED'] = value;
    new Neo4jClient('neo4j://x', 'u', 'p');
    expect(mainConfig().encrypted).toBe('ENCRYPTION_OFF');
  });

  describe.each(['NEO4J_ENCRYPTED', 'NEO4J_SSL_ENABLED', 'NEO4J_ENCRYPTION'])('%s with an unrecognised value', name => {
    it.each(['TRUE', 'True', '1', 'yes', ' true', 'true ', 'on'])('%p refuses to start, names the variable and builds no driver', value => {
      process.env[name] = value;
      let error: Error | undefined;
      try { new Neo4jClient('bolt://x', 'u', 'p'); } catch (e) { error = e as Error; }
      expect(error?.message).toBe(`${name} must be true or false when set`);
      expect(driverMock).not.toHaveBeenCalled();
    });

    it('refuses to start next to a valid true in another toggle', () => {
      process.env['NEO4J_SSL_ENABLED'] = 'true';
      process.env[name] = 'yes';
      expect(() => new Neo4jClient('bolt://x', 'u', 'p')).toThrow(`${name} must be true or false when set`);
      expect(driverMock).not.toHaveBeenCalled();
    });

    it('refuses to start with a TLS-carrying URI too', () => {
      process.env[name] = 'TRUE';
      expect(() => new Neo4jClient('neo4j+s://x', 'u', 'p')).toThrow(`${name} must be true or false when set`);
      expect(driverMock).not.toHaveBeenCalled();
    });
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

  it('does not warn about plaintext; only +ssc warns, about certificate verification', () => {
    new Neo4jClient(uri, 'u', 'p');
    if (uri.includes('+ssc')) {
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect((logger.warn as jest.Mock).mock.calls[0][0]).toContain('certificate verification is disabled');
    } else {
      expect(logger.info).toHaveBeenCalledWith('Neo4j client initialized with encryption set by the URI scheme');
      expect(logger.warn).not.toHaveBeenCalled();
    }
  });
});

it('never logs the URI, whose userinfo can carry a password', () => {
  new Neo4jClient('neo4j+s://user:sentinel-pw@h', 'u', 'p');
  new Neo4jClient('bolt://user:sentinel-pw@h', 'u', 'p');
  expect(loggedText()).not.toContain('sentinel-pw');
  expect(loggedText()).not.toContain('user:');
});

describe.each(['neo4j+ssc://h', 'bolt+ssc://h'])('%s trusts any certificate', uri => {
  const stricter = 'TRUST_SYSTEM_CA_SIGNED_CERTIFICATES';
  const refusal = 'A +ssc Neo4j URI trusts any certificate and conflicts with an explicit certificate trust strategy';

  it('refuses an explicit stricter trust strategy from NEO4J_SSL_TRUST_STRATEGY and builds no driver', () => {
    process.env['NEO4J_SSL_TRUST_STRATEGY'] = stricter;
    expect(() => new Neo4jClient(uri, 'u', 'p')).toThrow(refusal);
    expect(driverMock).not.toHaveBeenCalled();
  });

  it('refuses an explicit stricter trust strategy from the constructor option and builds no driver', () => {
    expect(() => new Neo4jClient(uri, 'u', 'p', { encrypted: true, trust: stricter })).toThrow(refusal);
    expect(driverMock).not.toHaveBeenCalled();
  });

  it('connects with no explicit trust setting and warns once, without the URI', () => {
    new Neo4jClient('neo4j+ssc://user:sentinel-pw@h', 'u', 'p');
    new Neo4jClient(uri, 'u', 'p');
    expect(driverMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect((logger.warn as jest.Mock).mock.calls[1]).toEqual([
      'Neo4j client initialized with encryption set by the URI scheme; certificate verification is disabled by the +ssc scheme',
    ]);
    expect(loggedText()).not.toContain('sentinel-pw');
  });

  it('accepts an explicit trust-all strategy', () => {
    process.env['NEO4J_SSL_TRUST_STRATEGY'] = 'TRUST_ALL_CERTIFICATES';
    expect(() => new Neo4jClient(uri, 'u', 'p')).not.toThrow();
  });
});

describe('an explicit TRUST_ALL_CERTIFICATES on a plain URI', () => {
  const info = 'Neo4j client initialized with SSL/TLS encryption enabled';
  const trustAllWarning = 'Neo4j client initialized with SSL/TLS encryption enabled; certificate verification is disabled by NEO4J_SSL_TRUST_STRATEGY=TRUST_ALL_CERTIFICATES';
  const trustAllConfigWarning = 'Neo4j client initialized with SSL/TLS encryption enabled; certificate verification is disabled by the Neo4jClient trust option TRUST_ALL_CERTIFICATES';
  const plaintextWarning = 'Neo4j client initialized WITHOUT encryption (development mode)';

  it.each(['bolt://h', 'neo4j://h'])('warns once with fixed text instead of the info line for %s (env trust)', uri => {
    process.env['NEO4J_ENCRYPTED'] = 'true';
    process.env['NEO4J_SSL_TRUST_STRATEGY'] = 'TRUST_ALL_CERTIFICATES';
    new Neo4jClient(uri, 'u', 'p');
    expect(mainConfig().trust).toBe('TRUST_ALL_CERTIFICATES');
    expect((logger.warn as jest.Mock).mock.calls).toEqual([[trustAllWarning]]);
    expect(logger.info).not.toHaveBeenCalledWith(info);
  });

  it('names the constructor option, not the environment variable, when the option decided the trust', () => {
    new Neo4jClient('bolt://h', 'u', 'p', { encrypted: true, trust: 'TRUST_ALL_CERTIFICATES' });
    expect((logger.warn as jest.Mock).mock.calls).toEqual([[trustAllConfigWarning]]);
    expect(logger.info).not.toHaveBeenCalledWith(info);
  });

  it('names the constructor option when it and the environment both say trust-all (the option wins)', () => {
    process.env['NEO4J_SSL_TRUST_STRATEGY'] = 'TRUST_ALL_CERTIFICATES';
    new Neo4jClient('bolt://h', 'u', 'p', { encrypted: true, trust: 'TRUST_ALL_CERTIFICATES' });
    expect((logger.warn as jest.Mock).mock.calls).toEqual([[trustAllConfigWarning]]);
  });

  it('a system-CA constructor option overrides an environment trust-all: info line only, no warning', () => {
    process.env['NEO4J_SSL_TRUST_STRATEGY'] = 'TRUST_ALL_CERTIFICATES';
    new Neo4jClient('bolt://h', 'u', 'p', { encrypted: true, trust: 'TRUST_SYSTEM_CA_SIGNED_CERTIFICATES' });
    expect(mainConfig().trust).toBe('TRUST_SYSTEM_CA_SIGNED_CERTIFICATES');
    expect(logger.warn).not.toHaveBeenCalled();
    expect((logger.info as jest.Mock).mock.calls).toEqual([[info]]);
  });

  it('logs only the info line, with no warning, under the default and the explicit system-CA strategy', () => {
    process.env['NEO4J_ENCRYPTED'] = 'true';
    new Neo4jClient('bolt://h', 'u', 'p');
    process.env['NEO4J_SSL_TRUST_STRATEGY'] = 'TRUST_SYSTEM_CA_SIGNED_CERTIFICATES';
    new Neo4jClient('bolt://h', 'u', 'p');
    expect((logger.info as jest.Mock).mock.calls).toEqual([[info], [info]]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('with encryption off the trust strategy has no effect: only the plaintext warning is logged', () => {
    process.env['NEO4J_SSL_TRUST_STRATEGY'] = 'TRUST_ALL_CERTIFICATES';
    new Neo4jClient('bolt://h', 'u', 'p');
    expect((logger.warn as jest.Mock).mock.calls).toEqual([[plaintextWarning]]);
  });

  it('leaves the +s and +ssc messages unchanged under an explicit trust-all', () => {
    process.env['NEO4J_ENCRYPTED'] = 'true';
    process.env['NEO4J_SSL_TRUST_STRATEGY'] = 'TRUST_ALL_CERTIFICATES';
    new Neo4jClient('neo4j+s://h', 'u', 'p');
    expect(logger.warn).not.toHaveBeenCalled();
    expect((logger.info as jest.Mock).mock.calls).toEqual([['Neo4j client initialized with encryption set by the URI scheme']]);
    new Neo4jClient('neo4j+ssc://h', 'u', 'p');
    expect((logger.warn as jest.Mock).mock.calls).toEqual([
      ['Neo4j client initialized with encryption set by the URI scheme; certificate verification is disabled by the +ssc scheme'],
    ]);
  });

  it('never logs the URI userinfo or the password', () => {
    process.env['NEO4J_ENCRYPTED'] = 'true';
    process.env['NEO4J_SSL_TRUST_STRATEGY'] = 'TRUST_ALL_CERTIFICATES';
    new Neo4jClient('bolt://user:sentinel-pw@host.example:7687', 'user', 'sentinel-pw');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(loggedText()).not.toMatch(/sentinel-pw|user:|host\.example/);
  });
});

describe('NEO4J_SSL_TRUST_STRATEGY and the trust option are validated at construction', () => {
  const envMessage = 'NEO4J_SSL_TRUST_STRATEGY must be TRUST_SYSTEM_CA_SIGNED_CERTIFICATES or TRUST_ALL_CERTIFICATES when set';
  const configMessage = 'Neo4j trust must be TRUST_SYSTEM_CA_SIGNED_CERTIFICATES or TRUST_ALL_CERTIFICATES when set';
  const invalid = ['TRUST_ALL_CERTS', 'trust_all_certificates', ' TRUST_ALL_CERTIFICATES', 'TRUST_CUSTOM_CA_SIGNED_CERTIFICATES', '1'];
  const thrown = (build: () => unknown): Error | undefined => {
    try { build(); } catch (e) { return e as Error; }
    return undefined;
  };

  it.each(invalid)('env %p refuses to start with the fixed message and builds no driver', value => {
    process.env['NEO4J_SSL_TRUST_STRATEGY'] = value;
    const error = thrown(() => new Neo4jClient('bolt://x', 'u', 'p'));
    expect(error?.message).toBe(envMessage);
    expect(driverMock).not.toHaveBeenCalled();
  });

  it.each(invalid)('config.trust %p refuses to start with the fixed message and builds no driver', value => {
    const error = thrown(() => new Neo4jClient('bolt://x', 'u', 'p', { trust: value as never }));
    expect(error?.message).toBe(configMessage);
    expect(driverMock).not.toHaveBeenCalled();
  });

  it('never echoes the supplied value (a trimmed accepted name is itself part of the fixed message)', () => {
    process.env['NEO4J_SSL_TRUST_STRATEGY'] = 'sentinel-trust-value';
    expect(thrown(() => new Neo4jClient('bolt://x', 'u', 'p'))?.message).not.toContain('sentinel-trust-value');
    delete process.env['NEO4J_SSL_TRUST_STRATEGY'];
    expect(thrown(() => new Neo4jClient('bolt://x', 'u', 'p', { trust: 'sentinel-trust-value' as never }))?.message).not.toContain('sentinel-trust-value');
  });

  it('an invalid env value is refused next to a valid config.trust', () => {
    process.env['NEO4J_SSL_TRUST_STRATEGY'] = 'TRUST_ALL_CERTS';
    expect(() => new Neo4jClient('bolt://x', 'u', 'p', { trust: 'TRUST_ALL_CERTIFICATES' })).toThrow(envMessage);
    expect(driverMock).not.toHaveBeenCalled();
  });

  it.each(['TRUST_SYSTEM_CA_SIGNED_CERTIFICATES', 'TRUST_ALL_CERTIFICATES'])('env %s still constructs and reaches the driver', value => {
    process.env['NEO4J_SSL_TRUST_STRATEGY'] = value;
    new Neo4jClient('bolt://x', 'u', 'p');
    expect(mainConfig().trust).toBe(value);
  });

  it.each(['TRUST_SYSTEM_CA_SIGNED_CERTIFICATES', 'TRUST_ALL_CERTIFICATES'] as const)('config.trust %s still constructs and reaches the driver', value => {
    new Neo4jClient('bolt://x', 'u', 'p', { trust: value });
    expect(mainConfig().trust).toBe(value);
  });

  it.each([undefined, ''])('env %p is not set and keeps the system CA default', value => {
    if (value !== undefined) process.env['NEO4J_SSL_TRUST_STRATEGY'] = value;
    expect(() => new Neo4jClient('bolt://x', 'u', 'p')).not.toThrow();
    expect(mainConfig().trust).toBe('TRUST_SYSTEM_CA_SIGNED_CERTIFICATES');
  });

  it.each(['neo4j+s://h', 'neo4j+ssc://h', 'bolt+s://h', 'bolt://h'])('an invalid env value is refused next to %s', uri => {
    process.env['NEO4J_SSL_TRUST_STRATEGY'] = 'TRUST_ALL_CERTS';
    expect(() => new Neo4jClient(uri, 'u', 'p')).toThrow(envMessage);
    expect(() => new Neo4jClient(uri, 'u', 'p', { encrypted: true })).toThrow(envMessage);
    expect(driverMock).not.toHaveBeenCalled();
  });

  it.each(['neo4j+s://h', 'bolt+s://h', 'bolt://h'])('an invalid config.trust is refused next to %s', uri => {
    expect(() => new Neo4jClient(uri, 'u', 'p', { trust: 'TRUST_ALL_CERTS' as never })).toThrow(configMessage);
    expect(driverMock).not.toHaveBeenCalled();
  });
});
