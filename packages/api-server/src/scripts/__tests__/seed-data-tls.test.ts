// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * `infrastructure/scripts/seed-data.ts` writes the admin user and its password hash over Bolt, so it must honor the
 * Neo4j TLS settings the API client honors. The script stays standalone (no `Neo4jClient` import), so a parity test
 * keeps `neo4jTlsConfig` from drifting away from `Neo4jClient`.
 */
import { logger } from '@cmdb/common';
import { Neo4jClient } from '../../../../database/src/neo4j/client';

jest.mock('neo4j-driver', () => ({
  __esModule: true,
  default: {
    driver: jest.fn(),
    auth: { basic: () => ({}) },
  },
}));

type SeedModule = typeof import('../../../../../infrastructure/scripts/seed-data');

const SCRIPT = '../../../../../infrastructure/scripts/seed-data';
const originalEnv = process.env;
const TOGGLES = ['NEO4J_SSL_ENABLED', 'NEO4J_ENCRYPTION', 'NEO4J_ENCRYPTED'] as const;
const TRUST_ALL = 'TRUST_ALL_CERTIFICATES';
const TRUST_SYSTEM = 'TRUST_SYSTEM_CA_SIGNED_CERTIFICATES';

/** Loads the script (and the isolated registry's `neo4j.driver` mock) with the given process environment. */
function loadSeed(extraEnv: Record<string, string> = {}): { seed: SeedModule; driver: jest.Mock } {
  process.env = {
    ...originalEnv,
    NODE_ENV: 'development',
    NEO4J_PASSWORD: 'x',
    SEED_USER_PASSWORD: 'seed-password',
    SEED_USER_PASSWORD_HASH: 'seed-hash',
    ...extraEnv,
  };
  for (const name of [...TOGGLES, 'NEO4J_SSL_TRUST_STRATEGY']) {
    if (!(name in extraEnv)) delete process.env[name];
  }
  let loaded: { seed: SeedModule; driver: jest.Mock } | undefined;
  jest.isolateModules(() => {
    const driver = (require('neo4j-driver').default.driver as jest.Mock);
    driver.mockReturnValue({});
    loaded = { seed: require(SCRIPT) as SeedModule, driver };
  });
  return loaded!;
}

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'info').mockImplementation(() => logger);
  jest.spyOn(logger, 'warn').mockImplementation(() => logger);
});
afterEach(() => {
  process.env = originalEnv;
  jest.restoreAllMocks();
});

describe('neo4jTlsConfig', () => {
  const { seed } = (() => loadSeed())();

  it('plain bolt:// with nothing set is unencrypted with system-CA trust', () => {
    expect(seed.neo4jTlsConfig('bolt://h', {})).toEqual({ encrypted: 'ENCRYPTION_OFF', trust: TRUST_SYSTEM });
    expect(seed.neo4jTlsConfig('bolt://h', { NEO4J_ENCRYPTED: '', NEO4J_SSL_TRUST_STRATEGY: '' }))
      .toEqual({ encrypted: 'ENCRYPTION_OFF', trust: TRUST_SYSTEM });
  });

  it.each(TOGGLES)('%s: true turns encryption on, false leaves it off', name => {
    expect(seed.neo4jTlsConfig('bolt://h', { [name]: 'true' })).toEqual({ encrypted: 'ENCRYPTION_ON', trust: TRUST_SYSTEM });
    expect(seed.neo4jTlsConfig('bolt://h', { [name]: 'false' })).toEqual({ encrypted: 'ENCRYPTION_OFF', trust: TRUST_SYSTEM });
  });

  it('keeps TRUST_ALL_CERTIFICATES when asked for it', () => {
    expect(seed.neo4jTlsConfig('bolt://h', { NEO4J_ENCRYPTED: 'true', NEO4J_SSL_TRUST_STRATEGY: TRUST_ALL }))
      .toEqual({ encrypted: 'ENCRYPTION_ON', trust: TRUST_ALL });
  });

  describe.each(TOGGLES)('malformed %s', name => {
    it.each(['TRUE', '1', 'yes', ' true'])('%j throws without echoing the value, whatever the URI scheme', value => {
      for (const uri of ['bolt://h', 'neo4j+s://h']) {
        expect(() => seed.neo4jTlsConfig(uri, { [name]: value })).toThrow(new Error(`${name} must be true or false when set`));
      }
    });
  });

  it('a malformed toggle throws even when another toggle is already true', () => {
    expect(() => seed.neo4jTlsConfig('bolt://h', { NEO4J_SSL_ENABLED: 'true', NEO4J_ENCRYPTED: '1' }))
      .toThrow('NEO4J_ENCRYPTED must be true or false when set');
  });

  it.each(['neo4j+s://h', 'BOLT+S://h', 'bolt+s://h', 'neo4j+s://user:secret@h'])('%s carries encryption itself', uri => {
    expect(seed.neo4jTlsConfig(uri, {})).toEqual({});
    expect(seed.neo4jTlsConfig(uri, { NEO4J_ENCRYPTED: 'false', NEO4J_SSL_TRUST_STRATEGY: TRUST_ALL })).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it('bolt+ssc:// alone returns {} and warns once without the URI', () => {
    expect(seed.neo4jTlsConfig('bolt+ssc://user:secret@host.example', {})).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/secret|host\.example|bolt\+ssc:\/\//);
  });

  it('bolt+ssc:// with TRUST_ALL_CERTIFICATES is accepted', () => {
    expect(seed.neo4jTlsConfig('neo4j+ssc://h', { NEO4J_SSL_TRUST_STRATEGY: TRUST_ALL })).toEqual({});
  });

  it('bolt+ssc:// with an explicit system-CA strategy throws', () => {
    expect(() => seed.neo4jTlsConfig('bolt+ssc://h', { NEO4J_SSL_TRUST_STRATEGY: TRUST_SYSTEM })).toThrow(/\+ssc/);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['trust_all_certificates', 'TRUST_NONE', ' TRUST_ALL_CERTIFICATES'])('unknown trust strategy %j throws without echoing it', value => {
    expect.assertions(2);
    try {
      seed.neo4jTlsConfig('bolt://h', { NEO4J_SSL_TRUST_STRATEGY: value });
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('NEO4J_SSL_TRUST_STRATEGY');
      expect(message).toBe('NEO4J_SSL_TRUST_STRATEGY must be TRUST_SYSTEM_CA_SIGNED_CERTIFICATES or TRUST_ALL_CERTIFICATES when set');
    }
  });
});

describe('neo4jTlsConfig on an explicit TRUST_ALL_CERTIFICATES', () => {
  const { seed } = (() => loadSeed())();
  const trustAllWarning = 'Neo4j client initialized with SSL/TLS encryption enabled; certificate verification is disabled by NEO4J_SSL_TRUST_STRATEGY=TRUST_ALL_CERTIFICATES';

  it.each(['bolt://h', 'neo4j://user:sentinel-pw@host.example'])('warns once with fixed text on %s when encryption is on', uri => {
    expect(seed.neo4jTlsConfig(uri, { NEO4J_ENCRYPTED: 'true', NEO4J_SSL_TRUST_STRATEGY: TRUST_ALL }))
      .toEqual({ encrypted: 'ENCRYPTION_ON', trust: TRUST_ALL });
    expect(warn.mock.calls).toEqual([[trustAllWarning]]);
  });

  it('does not warn under the default or the explicit system-CA strategy', () => {
    expect(seed.neo4jTlsConfig('bolt://h', { NEO4J_ENCRYPTED: 'true' })).toEqual({ encrypted: 'ENCRYPTION_ON', trust: TRUST_SYSTEM });
    expect(seed.neo4jTlsConfig('bolt://h', { NEO4J_ENCRYPTED: 'true', NEO4J_SSL_TRUST_STRATEGY: TRUST_SYSTEM }))
      .toEqual({ encrypted: 'ENCRYPTION_ON', trust: TRUST_SYSTEM });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn with encryption off, where the trust strategy has no effect', () => {
    expect(seed.neo4jTlsConfig('bolt://h', { NEO4J_SSL_TRUST_STRATEGY: TRUST_ALL }))
      .toEqual({ encrypted: 'ENCRYPTION_OFF', trust: TRUST_ALL });
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves the +s and +ssc behaviour unchanged under an explicit trust-all', () => {
    expect(seed.neo4jTlsConfig('neo4j+s://h', { NEO4J_ENCRYPTED: 'true', NEO4J_SSL_TRUST_STRATEGY: TRUST_ALL })).toEqual({});
    expect(warn).not.toHaveBeenCalled();
    expect(seed.neo4jTlsConfig('neo4j+ssc://h', { NEO4J_ENCRYPTED: 'true', NEO4J_SSL_TRUST_STRATEGY: TRUST_ALL })).toEqual({});
    expect(warn.mock.calls).toEqual([['WARNING: the +ssc Neo4j URI scheme disables certificate verification']]);
  });
});

describe('createDriver', () => {
  it('passes the TLS config to neo4j.driver next to its pool options', () => {
    const { seed, driver } = loadSeed({ NEO4J_URI: 'bolt://h:7687', NEO4J_ENCRYPTED: 'true' });
    seed.createDriver();
    expect(driver).toHaveBeenCalledTimes(1);
    expect(driver.mock.calls[0]![2]).toEqual({
      maxConnectionLifetime: 3 * 60 * 60 * 1000,
      maxConnectionPoolSize: 50,
      connectionAcquisitionTimeout: 2 * 60 * 1000,
      encrypted: 'ENCRYPTION_ON',
      trust: TRUST_SYSTEM,
    });
  });

  it('omits encrypted and trust for a URI scheme that carries them', () => {
    const { seed, driver } = loadSeed({ NEO4J_URI: 'neo4j+s://h', NEO4J_ENCRYPTED: 'true' });
    seed.createDriver();
    expect(driver.mock.calls[0]![2]).not.toHaveProperty('encrypted');
    expect(driver.mock.calls[0]![2]).not.toHaveProperty('trust');
  });

  it('refuses a malformed toggle before any driver is created', () => {
    const { seed, driver } = loadSeed({ NEO4J_URI: 'bolt://h', NEO4J_ENCRYPTED: 'TRUE' });
    expect(() => seed.createDriver()).toThrow('NEO4J_ENCRYPTED must be true or false when set');
    expect(driver).not.toHaveBeenCalled();
  });
});

describe('parity with Neo4jClient', () => {
  const { seed } = (() => loadSeed())();
  const driver = jest.requireMock('neo4j-driver').default.driver as jest.Mock;
  const toggleValues = ['true', 'false', undefined];
  const trustValues = [undefined, TRUST_SYSTEM, TRUST_ALL];
  const uris = ['bolt://h', 'neo4j://h', 'bolt+s://h', 'neo4j+ssc://h'];

  /** The TLS keys the driver receives from Neo4jClient, or 'throws'. */
  const clientOutcome = (uri: string, env: NodeJS.ProcessEnv): unknown => {
    process.env = { ...originalEnv, ...env };
    for (const name of [...TOGGLES, 'NEO4J_SSL_TRUST_STRATEGY']) if (env[name] === undefined) delete process.env[name];
    driver.mockReset();
    driver.mockReturnValue({});
    try {
      new Neo4jClient(uri, 'u', 'p');
    } catch {
      return 'throws';
    }
    const { encrypted, trust } = driver.mock.calls[0]![2];
    return { encrypted, trust };
  };
  const seedOutcome = (uri: string, env: NodeJS.ProcessEnv): unknown => {
    try {
      const { encrypted, trust } = seed.neo4jTlsConfig(uri, env);
      return { encrypted, trust };
    } catch {
      return 'throws';
    }
  };

  const valid: Array<[string, NodeJS.ProcessEnv]> = [];
  for (const uri of uris) for (const a of toggleValues) for (const b of toggleValues) for (const c of toggleValues) for (const trust of trustValues) {
    valid.push([uri, {
      NEO4J_SSL_ENABLED: a, NEO4J_ENCRYPTION: b, NEO4J_ENCRYPTED: c, NEO4J_SSL_TRUST_STRATEGY: trust,
    }]);
  }

  it('matches Neo4jClient across every valid scheme, toggle and trust combination', () => {
    expect(valid).toHaveLength(uris.length * 27 * trustValues.length);
    const mismatches = valid.filter(([uri, env]) => JSON.stringify(seedOutcome(uri, env)) !== JSON.stringify(clientOutcome(uri, env)));
    expect(mismatches).toEqual([]);
  });

  it('actually exercises encrypted, unencrypted, scheme-carried and refused outcomes', () => {
    const outcomes = new Set(valid.map(([uri, env]) => JSON.stringify(seedOutcome(uri, env))));
    expect(outcomes).toEqual(new Set([
      JSON.stringify({ encrypted: 'ENCRYPTION_ON', trust: TRUST_SYSTEM }),
      JSON.stringify({ encrypted: 'ENCRYPTION_ON', trust: TRUST_ALL }),
      JSON.stringify({ encrypted: 'ENCRYPTION_OFF', trust: TRUST_SYSTEM }),
      JSON.stringify({ encrypted: 'ENCRYPTION_OFF', trust: TRUST_ALL }),
      JSON.stringify({}),
      '"throws"',
    ]));
  });

  it.each(TOGGLES.flatMap(name => ['TRUE', '1', 'yes', ' true'].map(value => [name, value])))(
    'both refuse %s=%j',
    (name, value) => {
      for (const uri of ['bolt://h', 'neo4j+s://h']) {
        expect(seedOutcome(uri, { [name]: value })).toBe('throws');
        expect(clientOutcome(uri, { [name]: value })).toBe('throws');
      }
    }
  );
});
