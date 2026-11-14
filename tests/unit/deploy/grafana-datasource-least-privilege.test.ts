/**
 * HAP-1827 (SENSITIVE): the Grafana datasources must connect as a read-only reporting role
 * configured only through GRAFANA_DS_*, never as the .env superuser, and must actually be
 * connectable with the values Grafana 10.2 produces.
 *
 * Two different expanders are involved and they do NOT share syntax:
 *  - Docker Compose expands the `grafana` service `environment:` from the host `.env`
 *    (`${VAR}`, `${VAR:-default}`; `:-` treats unset and empty alike). `composeServiceEnv`.
 *  - Grafana 10.2 expands provisioning values from the container environment through
 *    `setting.ExpandVar` (pkg/setting/expanders.go) and then `os.ExpandEnv`. There is NO
 *    `:-default`: in `${...}` the whole brace content is the variable name, so
 *    `${GRAFANA_DS_HOST:-postgres}` reads a variable literally named `GRAFANA_DS_HOST:-postgres`
 *    and yields "" (url ":", database "", sslmode ""). `expandAsGrafana` follows that.
 *    `$__env{NAME}` and `$__file{path}` (contents, trimmed) are the other recognised forms.
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
/** Files visible to the Grafana container, by absolute path (for `$__file{}`). */
type Files = Record<string, string>;

const isMap = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// --- Grafana 10.2 expansion -------------------------------------------------------------

/** pkg/setting/expanders.go: `\$(|__\w+){([^}]+)}`; kind '' and `__env` read the environment. */
const GRAFANA_VAR = /\$(|__\w+)\{([^}]+)\}/g;

interface Reference {
  kind: '' | '__env' | '__file';
  /** Environment variable name, or file path for `__file`: the whole brace content. */
  name: string;
}

function references(text: string): Reference[] {
  return [...text.matchAll(GRAFANA_VAR)].map((m) => {
    const kind = m[1];
    if (kind !== '' && kind !== '__env' && kind !== '__file') {
      throw new Error(`Grafana has no expander "${kind}" (in ${m[0]})`);
    }
    return { kind, name: m[2] };
  });
}

/** Go `os.ExpandEnv` as applied after `ExpandVar`: `$NAME` and `${NAME}` (name to first `}`). */
function expandEnvLikeGo(text: string, env: Env): string {
  return text.replace(/\$(?:\{([^}]*)\}|([A-Za-z0-9_]+))/g, (_all, braced?: string, bare?: string) => {
    return env[braced ?? bare ?? ''] ?? '';
  });
}

/** One provisioning scalar, expanded as `values.interpolateValue` does. */
function expandAsGrafana(text: string, env: Env, files: Files = {}): string {
  const expanded = text.replace(GRAFANA_VAR, (_all, kind: string, name: string) => {
    if (kind === '' || kind === '__env') return env[name] ?? '';
    if (kind === '__file') {
      if (!(name in files)) throw new Error(`$__file{${name}}: no such file in the container`);
      return files[name].trim();
    }
    throw new Error(`Grafana has no expander "${kind}"`);
  });
  return expandEnvLikeGo(expanded, env);
}

/** Every string scalar of a parsed YAML tree (provisioning interpolates scalars, not comments). */
function scalars(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(scalars);
  if (isMap(node)) return Object.values(node).flatMap(scalars);
  return [];
}

function expandTree(node: unknown, env: Env, files: Files): unknown {
  if (typeof node === 'string') return expandAsGrafana(node, env, files);
  if (Array.isArray(node)) return node.map((n) => expandTree(n, env, files));
  if (isMap(node)) {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, expandTree(v, env, files)]));
  }
  return node;
}

// --- Docker Compose expansion -----------------------------------------------------------

/** Compose `${NAME}` / `${NAME:-default}` against the host `.env`; defaults may nest. */
function expandAsCompose(text: string, hostEnv: Env): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '$' || text[i + 1] !== '{') {
      out += text[i];
      continue;
    }
    let depth = 1;
    let j = i + 2;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    const body = text.slice(i + 2, j - 1);
    const sep = body.indexOf(':-');
    const name = sep === -1 ? body : body.slice(0, sep);
    const value = hostEnv[name] ?? '';
    out += sep !== -1 && value === '' ? expandAsCompose(body.slice(sep + 2), hostEnv) : value;
    i = j - 1;
  }
  return out;
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
      out[String(entry).slice(0, eq)] = expandAsCompose(String(entry).slice(eq + 1), hostEnv);
    }
  } else if (isMap(entries)) {
    for (const [k, v] of Object.entries(entries)) out[k] = expandAsCompose(String(v ?? ''), hostEnv);
  }
  return out;
}

// --- Datasource helpers -----------------------------------------------------------------

const rawDoc = parse(readFileSync(DATASOURCES_FILE, 'utf8')) as Node;

/** Datasources as Grafana would provision them from `containerEnv`. */
function provision(containerEnv: Env, files: Files = {}): Node[] {
  const doc = expandTree(rawDoc, containerEnv, files) as Node;
  return (doc.datasources as unknown[]).filter(isMap);
}

/** Datasources as provisioned by the compose `grafana` service from a host `.env`. */
function provisionFromHost(hostEnv: Env): Node[] {
  return provision(composeServiceEnv('grafana', hostEnv));
}

const blank = (value: unknown): boolean => value === null || value === undefined || value === '';

/** Credential fields a datasource cannot connect without. */
function blankCredentials(ds: Node): string[] {
  const missing: string[] = [];
  if (blank(ds.user)) missing.push('user');
  if (blank((ds.secureJsonData as Node | undefined)?.password)) missing.push('password');
  return missing;
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
    expect(provisionFromHost({}).map((d) => d.name)).toEqual(['HappyCMDB', 'HappyCMDB (Explore)']);
  });

  describe('Grafana 10.2 interpolation (no ${VAR:-default})', () => {
    it('uses no :-default or other shell modifier inside any interpolated value', () => {
      // Grafana takes the whole brace content as the variable name, so `${A:-x}` reads a
      // variable named `A:-x` (always unset) and the value silently becomes "".
      const offenders = scalars(rawDoc)
        .flatMap(references)
        .filter((ref) => ref.kind !== '__file' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.name))
        .map((ref) => ref.name);
      expect(offenders).toEqual([]);
    });

    it('every variable it interpolates is one the compose grafana service sets, by exact name', () => {
      const composeEnv = composeServiceEnv('grafana', {});
      const missing = scalars(rawDoc)
        .flatMap(references)
        .filter((ref) => ref.kind !== '__file')
        .map((ref) => ref.name)
        .filter((name) => !(name in composeEnv));
      expect([...new Set(missing)].sort()).toEqual([]);
    });
  });

  describe('connection values as Grafana produces them', () => {
    it('a stack with only the reporting credentials gets a host:port url, database and require TLS', () => {
      for (const ds of provisionFromHost(READER)) {
        expect(ds.url).toBe('postgres:5432');
        expect(ds.database).toBe('cmdb');
        expect((ds.jsonData as Node).sslmode).toBe('require');
      }
    });

    it('honours GRAFANA_DS_HOST, PORT, DATABASE and SSL_MODE from the host .env', () => {
      for (const sslmode of ['disable', 'verify-full']) {
        const hostEnv = {
          ...READER,
          GRAFANA_DS_HOST: 'pg.internal',
          GRAFANA_DS_PORT: '6432',
          GRAFANA_DS_DATABASE: 'reporting',
          GRAFANA_DS_SSL_MODE: sslmode,
        };
        for (const ds of provisionFromHost(hostEnv)) {
          expect(ds.url).toBe('pg.internal:6432');
          expect(ds.database).toBe('reporting');
          expect((ds.jsonData as Node).sslmode).toBe(sslmode);
        }
      }
    });

    it('takes user and password from GRAFANA_DS_* for every datasource', () => {
      for (const ds of provisionFromHost(READER)) {
        expect(ds.user).toBe('grafana_reporting');
        expect((ds.secureJsonData as Node).password).toBe('reader-secret');
      }
    });

    it('defaults sslmode to a TLS mode, never to a cleartext-capable or empty one', () => {
      for (const ds of provisionFromHost(READER)) {
        expect(['require', 'verify-ca', 'verify-full']).toContain((ds.jsonData as Node).sslmode);
      }
    });
  });

  describe('never the superuser', () => {
    it('never picks up the .env superuser variables, even when the container has them', () => {
      const container = composeServiceEnv('grafana', { ...READER });
      const withLeak = provision({ ...container, ...HOST_ENV });
      expect(withLeak).toEqual(provision(container));
      expect(JSON.stringify(withLeak)).not.toMatch(/cmdb_user|superuser-secret/);
    });

    it('a host with only superuser credentials yields datasources that cannot authenticate', () => {
      for (const ds of provisionFromHost(HOST_ENV)) {
        expect(blankCredentials(ds)).toEqual(['user', 'password']);
      }
    });

    it('forwards GRAFANA_DS_* from the host and leaks no POSTGRES_* superuser value into them', () => {
      const env = composeServiceEnv('grafana', { ...HOST_ENV, ...READER });
      expect(env.GRAFANA_DS_USER).toBe('grafana_reporting');
      expect(env.GRAFANA_DS_PASSWORD).toBe('reader-secret');
      const ds = Object.entries(env).filter(([k]) => k.startsWith('GRAFANA_DS_'));
      expect(JSON.stringify(ds)).not.toMatch(/cmdb_user|superuser-secret/);
    });
  });

  describe('GRAFANA_DS_USER must be non-empty', () => {
    it('rejects an unset user', () => {
      const ds = provisionFromHost({ GRAFANA_DS_PASSWORD: 'reader-secret' });
      for (const d of ds) expect(blankCredentials(d)).toContain('user');
    });

    it('rejects a user that is set but empty', () => {
      const ds = provisionFromHost({ GRAFANA_DS_USER: '', GRAFANA_DS_PASSWORD: 'reader-secret' });
      for (const d of ds) expect(blankCredentials(d)).toEqual(['user']);
    });

    it('accepts a user and password together', () => {
      for (const d of provisionFromHost(READER)) expect(blankCredentials(d)).toEqual([]);
    });
  });

  it('marks every datasource editable: false', () => {
    for (const ds of provisionFromHost(READER)) expect(ds.editable).toBe(false);
  });
});
