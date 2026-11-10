/**
 * HAP-1820: every relative bind-mount source in infrastructure/docker/docker-compose.yml
 * must resolve to an existing path in the repo.
 *
 * Grafana's provisioning mounts used `../../monitoring/...` (-> <repo>/monitoring, which
 * does not exist). Docker silently bind-mounts an empty auto-created directory for a
 * missing source, so Grafana booted with no datasource and no dashboards. Compose resolves
 * relative sources against the compose file's directory; this does the same.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { parse } from 'yaml';

const REPO = resolve(__dirname, '../../..');
const COMPOSE_FILE = resolve(REPO, 'infrastructure/docker/docker-compose.yml');
const COMPOSE_DIR = dirname(COMPOSE_FILE);

// Gitignored TLS material written by the operator's certificate tooling before `up`
// (see infrastructure/docker/SSL_CERTIFICATE_SETUP.md); absent in a clean checkout by design.
const GENERATED_AT_DEPLOY = new Set([
  'infrastructure/docker/ssl/neo4j',
  'infrastructure/docker/ssl/postgres',
  'infrastructure/docker/ssl/redis',
]);

type Node = Record<string, unknown>;
type Mount = { service: string; source: string; resolved: string; repoRelative: string };

const isMap = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A short-syntax source is a bind mount when it is a path (starts with `.`); named volumes
// and absolute / interpolated host paths are not relative bind mounts. Long syntax is
// explicit via `type: bind`.
function relativeSource(entry: unknown): string | null {
  let source: string | null = null;
  if (typeof entry === 'string') {
    const first = entry.split(':')[0];
    source = first.startsWith('.') ? first : null;
  } else if (isMap(entry) && entry.type === 'bind' && typeof entry.source === 'string') {
    source = entry.source;
  }
  return source !== null && source.startsWith('.') ? source : null;
}

function relativeBindMounts(): Mount[] {
  const compose = parse(readFileSync(COMPOSE_FILE, 'utf8')) as Node;
  const services = compose.services;
  if (!isMap(services)) throw new Error('docker-compose.yml has no services map');

  const mounts: Mount[] = [];
  for (const [service, definition] of Object.entries(services)) {
    const volumes = isMap(definition) ? definition.volumes : undefined;
    if (!Array.isArray(volumes)) continue;
    for (const entry of volumes) {
      const source = relativeSource(entry);
      if (source === null) continue;
      const resolved = resolve(COMPOSE_DIR, source);
      mounts.push({
        service,
        source,
        resolved,
        repoRelative: resolved.slice(REPO.length + 1),
      });
    }
  }
  return mounts;
}

describe('docker-compose relative bind-mount sources', () => {
  const mounts = relativeBindMounts();

  it('Grafana provisioning mounts resolve to existing paths', () => {
    const grafana = mounts.filter((m) => m.service === 'grafana');
    expect(grafana.length).toBeGreaterThanOrEqual(3);
    const missing = grafana.filter((m) => !existsSync(m.resolved)).map((m) => m.source);
    expect(missing).toEqual([]);
  });

  it('every service relative bind-mount source exists (except deploy-time TLS material)', () => {
    const missing = mounts
      .filter((m) => !GENERATED_AT_DEPLOY.has(m.repoRelative))
      .filter((m) => !existsSync(m.resolved))
      .map((m) => `${m.service}: ${m.source} -> ${m.repoRelative}`);
    expect(missing).toEqual([]);
  });
});
