/**
 * HAP-1827 (SENSITIVE): the Grafana datasources must connect as a read-only reporting role
 * configured only through GRAFANA_DS_*, never as the .env superuser.
 *
 * Grafana expands `${VAR}` / `${VAR:-default}` in provisioning files from its own container
 * environment. `expandAsGrafana` mirrors that so the tests assert what each datasource would
 * contain for a given container environment, rather than matching source text.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';

const REPO = resolve(__dirname, '../../..');
const COMPOSE_FILE = resolve(REPO, 'infrastructure/docker/docker-compose.yml');
const DATASOURCES_FILE = resolve(
  REPO,
  'infrastructure/monitoring/grafana/provisioning/datasources/postgres.yml'
);

type Node = Record<string, unknown>;
type Env = Record<string, string>;

const isMap = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Variable names a provisioning file interpolates. */
function interpolated(text: string): string[] {
  return [...new Set([...text.matchAll(VAR)].map((m) => m[1]))].sort();
}

/** `${VAR}` -> env value or ''; `${VAR:-d}` -> env value, or d when unset or empty. */
function expandAsGrafana(text: string, env: Env): string {
  return text.replace(VAR, (_all, name: string, dflt: string | undefined) => {
    const value = env[name] ?? '';
    return value === '' && dflt !== undefined ? dflt : value;
  });
}

/** Environment a compose service receives, with `${VAR:-d}` resolved against the host `.env`. */
function composeServiceEnv(service: string, hostEnv: Env): Env {
  const compose = parse(readFileSync(COMPOSE_FILE, 'utf8')) as Node;
  const services = isMap(compose.services) ? compose.services : {};
  const def = services[service];
  if (!isMap(def)) throw new Error(`compose service ${service} not found`);
  const entries = def.environment;
  const out: Env = {};
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const eq = String(entry).indexOf('=');
      out[String(entry).slice(0, eq)] = expandAsGrafana(String(entry).slice(eq + 1), hostEnv);
    }
  } else if (isMap(entries)) {
    for (const [k, v] of Object.entries(entries)) out[k] = expandAsGrafana(String(v ?? ''), hostEnv);
  }
  return out;
}

/** An empty `user:` / `password:` parses as YAML null; Grafana treats both as no value. */
const blank = (value: unknown): boolean => value === null || value === undefined || value === '';

const raw = readFileSync(DATASOURCES_FILE, 'utf8');

/** Datasources as Grafana would provision them from `containerEnv`. */
function provision(containerEnv: Env): Node[] {
  const doc = parse(expandAsGrafana(raw, containerEnv)) as Node;
  return (doc.datasources as unknown[]).filter(isMap);
}

// The superuser credentials a deploy host has in `.env`.
const HOST_ENV: Env = {
  POSTGRES_USER: 'cmdb_user',
  POSTGRES_PASSWORD: 'superuser-secret',
  POSTGRES_SSL_MODE: 'verify-full',
};
const READER: Env = {
  GRAFANA_DS_USER: 'grafana_reporting',
  GRAFANA_DS_PASSWORD: 'reader-secret',
};

describe('Grafana datasource least privilege (HAP-1827)', () => {
  it('provisions the dashboard and Explore datasources', () => {
    expect(provision({}).map((d) => d.name)).toEqual(['HappyCMDB', 'HappyCMDB (Explore)']);
  });

  it('takes user, password and sslmode from GRAFANA_DS_* for every datasource', () => {
    const env = { ...READER, GRAFANA_DS_SSL_MODE: 'verify-full' };
    for (const ds of provision(env)) {
      expect(ds.user).toBe('grafana_reporting');
      expect((ds.secureJsonData as Node).password).toBe('reader-secret');
      expect((ds.jsonData as Node).sslmode).toBe('verify-full');
    }
  });

  it('never picks up the .env superuser variables, even when the container has them', () => {
    // A POSTGRES_* leak into the container must change nothing in the datasources.
    const withLeak = provision({ ...READER, ...HOST_ENV });
    const without = provision(READER);
    expect(withLeak).toEqual(without);
    expect(JSON.stringify(withLeak)).not.toMatch(/cmdb_user|superuser-secret/);
  });

  it('fails closed with no reporting-role credentials: no user or password to connect with', () => {
    for (const ds of provision({ ...HOST_ENV })) {
      expect(blank(ds.user)).toBe(true);
      expect(blank((ds.secureJsonData as Node).password)).toBe(true);
    }
  });

  it('defaults sslmode to a TLS mode, never to a cleartext-capable one', () => {
    for (const ds of provision(READER)) {
      expect(['require', 'verify-ca', 'verify-full']).toContain((ds.jsonData as Node).sslmode);
    }
  });

  it('marks every datasource editable: false', () => {
    for (const ds of provision(READER)) expect(ds.editable).toBe(false);
  });

  describe('compose grafana service', () => {
    it('supplies every variable the datasource file interpolates', () => {
      const env = composeServiceEnv('grafana', {});
      const missing = interpolated(raw).filter((name) => !(name in env));
      expect(missing).toEqual([]);
    });

    it('forwards GRAFANA_DS_* from the host and leaks no POSTGRES_* superuser value into them', () => {
      const env = composeServiceEnv('grafana', { ...HOST_ENV, ...READER });
      expect(env.GRAFANA_DS_USER).toBe('grafana_reporting');
      expect(env.GRAFANA_DS_PASSWORD).toBe('reader-secret');
      const ds = Object.entries(env).filter(([k]) => k.startsWith('GRAFANA_DS_'));
      expect(JSON.stringify(ds)).not.toMatch(/cmdb_user|superuser-secret/);
    });

    it('leaves user and password empty when the host sets no GRAFANA_DS_*, whatever POSTGRES_* holds', () => {
      const env = composeServiceEnv('grafana', HOST_ENV);
      expect(env.GRAFANA_DS_USER).toBe('');
      expect(env.GRAFANA_DS_PASSWORD).toBe('');
    });

    it('end to end: a host with only superuser credentials yields datasources that cannot authenticate', () => {
      const container = composeServiceEnv('grafana', HOST_ENV);
      for (const ds of provision(container)) {
        expect(blank(ds.user)).toBe(true);
        expect(blank((ds.secureJsonData as Node).password)).toBe(true);
        expect((ds.jsonData as Node).sslmode).toBe('require');
      }
    });
  });
});
