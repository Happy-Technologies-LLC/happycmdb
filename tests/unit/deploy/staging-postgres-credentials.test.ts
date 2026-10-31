/**
 * HAP-774 S5b C2: the Build01 staging stack splits the Postgres credentials.
 *
 * - api-server connects as the least-privilege app role happycmdb_app (plan D1 a);
 * - the one-shot migrator connects as cmdb_migration_owner (plan D2 a);
 * - the bootstrap superuser cmdb_user and its POSTGRES_PASSWORD stay on the postgres service only.
 *
 * The stack is rendered from the deploy-app.sh pair (staging file + generation override), the same
 * fail-closed YAML loading as web-ui-healthcheck.test.ts. Values are checked as written, before
 * interpolation, so a literal password anywhere fails.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseDocument } from 'yaml';

const REPO = resolve(__dirname, '../../..');
const FILES = ['deploy/build01-staging.compose.yml', 'tests/unit/deploy/fixtures/happycmdb-g33.override.yml'];

type Node = Record<string, unknown>;
const isMap = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function load(file: string): Node {
  const doc = parseDocument(readFileSync(resolve(REPO, file), 'utf8'));
  const problems = [...doc.errors, ...doc.warnings].map((problem) => problem.message);
  if (problems.length > 0) throw new Error(`${file}: ${problems.join('; ')}`);
  const content = doc.toJS() as Node;
  if ('include' in content) throw new Error(`${file}: include is not modelled`);
  return content;
}

function merge(base: unknown, override: unknown): unknown {
  if (!isMap(base) || !isMap(override)) return override;
  const merged: Node = { ...base };
  for (const [key, value] of Object.entries(override)) merged[key] = key in base ? merge(base[key], value) : value;
  return merged;
}

const rendered = FILES.map(load).reduce((base, next) => merge(base, next) as Node);
const services = rendered.services as Record<string, Node>;

function environment(name: string): Record<string, string> {
  const env = services[name]?.environment ?? {};
  if (!isMap(env)) throw new Error(`${name}: environment must be a mapping`);
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)]));
}

const required = (variable: string): string => `\${${variable}:?${variable} is required}`;

// Keyed by service: the Postgres user it connects as and the one interpolated variable that supplies its credential.
const EXPECTED: Record<string, { user: string; variable: string }> = {
  postgres: {
    user: 'cmdb_user',
    variable: 'POSTGRES_PASSWORD',
  },
  'api-server': {
    user: 'happycmdb_app',
    variable: 'HAPPYCMDB_APP_POSTGRES_PASSWORD',
  },
  migrator: {
    user: 'cmdb_migration_owner',
    variable: 'CMDB_MIGRATION_OWNER_PASSWORD',
  },
};
const rows = Object.entries(EXPECTED).map(([service, { user, variable }]) => [service, user, variable]);

describe('Build01 staging Postgres credential split (HAP-774 S5b C2)', () => {
  it.each(rows)('%s connects as %s with the required %s', (service, user, variable) => {
    const env = environment(service);
    expect({ user: env.POSTGRES_USER, credential: env.POSTGRES_PASSWORD }).toEqual({
      user,
      credential: required(variable),
    });
  });

  it('gives each Postgres credential variable to exactly one service', () => {
    const referencing = (variable: string): string[] =>
      Object.keys(services).filter((name) =>
        new RegExp(`\\$\\{${variable}[:}]`).test(JSON.stringify(services[name]))
      );
    const actual = Object.fromEntries(rows.map(([, , variable]) => [variable, referencing(variable)]));
    const owners = Object.fromEntries(rows.map(([service, , variable]) => [variable, [service]]));
    expect(actual).toEqual(owners);
  });

  it('holds no literal secret: each env value under a *PASSWORD* key is one required or empty-default reference', () => {
    const literals = Object.keys(services).flatMap((name) =>
      Object.entries(environment(name))
        .filter(([key]) => key.includes('PASSWORD'))
        .filter(([, value]) => !/^\$\{[A-Z][A-Z0-9_]*(:\?[^}]*|:-)\}$/.test(value))
        .map(([key]) => `${name}.${key}`)
    );
    expect(literals).toEqual([]);
  });
});
