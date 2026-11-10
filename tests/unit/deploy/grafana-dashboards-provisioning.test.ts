/**
 * HAP-1822: every file in the Grafana dashboards directory must be a bare dashboard model.
 *
 * Grafana's file provisioner (10.2.0) reads each JSON file as the dashboard itself. The
 * HTTP API import envelope `{"dashboard": {...}, "overwrite": ...}` has no top-level
 * `title`, so every wrapped file failed with `Dashboard title cannot be empty` and
 * `/api/search?type=dash-db` returned 0 dashboards. The provisioner also keys dashboards
 * on `uid`, so each file needs its own, and `id` is instance-local and must not be pinned.
 *
 * The directory under test is derived from the provider config: the provider's `options.path`
 * (a container path) is matched against the compose bind mounts to find the host directory.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, posix, resolve } from 'path';
import { parse } from 'yaml';

const REPO = resolve(__dirname, '../../..');
const COMPOSE_FILE = resolve(REPO, 'infrastructure/docker/docker-compose.yml');
const PROVIDER_FILE = resolve(
  REPO,
  'infrastructure/monitoring/grafana/provisioning/dashboards/cmdb-dashboards.yml'
);
const DASHBOARDS_DIR = resolve(REPO, 'infrastructure/monitoring/grafana/dashboards');

type Node = Record<string, unknown>;

const isMap = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function providerPaths(): string[] {
  const doc = parse(readFileSync(PROVIDER_FILE, 'utf8')) as Node;
  const providers = Array.isArray(doc.providers) ? doc.providers : [];
  const paths = providers
    .filter(isMap)
    .filter((p) => p.type === 'file')
    .map((p) => (isMap(p.options) ? p.options.path : undefined))
    .filter((p): p is string => typeof p === 'string');
  return paths.map((p) => posix.normalize(p));
}

/** Host directories the compose file bind-mounts onto `containerPath` (short syntax). */
function composeSourcesFor(containerPath: string): string[] {
  const compose = parse(readFileSync(COMPOSE_FILE, 'utf8')) as Node;
  const services = isMap(compose.services) ? compose.services : {};
  const sources: string[] = [];
  for (const service of Object.values(services)) {
    const volumes = isMap(service) && Array.isArray(service.volumes) ? service.volumes : [];
    for (const volume of volumes) {
      if (typeof volume === 'string') {
        const [source, target] = volume.split(':');
        if (target && posix.normalize(target) === containerPath) {
          sources.push(resolve(dirname(COMPOSE_FILE), source));
        }
      } else if (isMap(volume) && typeof volume.source === 'string') {
        if (typeof volume.target === 'string' && posix.normalize(volume.target) === containerPath) {
          sources.push(resolve(dirname(COMPOSE_FILE), volume.source));
        }
      }
    }
  }
  return sources;
}

function dashboardFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...dashboardFiles(full));
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out.sort();
}

const files = dashboardFiles(DASHBOARDS_DIR);
const rel = (file: string): string => file.slice(REPO.length + 1);

describe('Grafana dashboard provisioning (HAP-1822)', () => {
  it('provider config points at the dashboards directory the compose file mounts', () => {
    const paths = providerPaths();
    expect(paths).toHaveLength(1);
    expect(composeSourcesFor(paths[0])).toContain(DASHBOARDS_DIR);
    expect(existsSync(DASHBOARDS_DIR)).toBe(true);
  });

  it('has dashboards to provision', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  describe.each(files.map((file) => [rel(file), file]))('%s', (_name, file) => {
    let model: Node;

    beforeAll(() => {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isMap(parsed)) throw new Error('dashboard JSON must be an object');
      model = parsed;
    });

    it('is a bare dashboard model, not the HTTP API envelope', () => {
      expect(model).not.toHaveProperty('dashboard');
    });

    it('has a non-empty title', () => {
      expect(typeof model.title).toBe('string');
      expect((model.title as string).trim()).not.toBe('');
    });

    it('has a uid', () => {
      expect(typeof model.uid).toBe('string');
      expect((model.uid as string).trim()).not.toBe('');
    });

    it('has a null or absent id', () => {
      expect(model.id ?? null).toBeNull();
    });
  });

  // Grafana keys file-provisioned dashboards on uid, and refuses to write any dashboard whose
  // title is shared inside a folder ("dashboard title is not unique in folder"). The provider
  // has foldersFromFilesStructure: false, so every file lands in the same folder.
  const duplicatesOf = (key: 'uid' | 'title'): [string, string[]][] => {
    const owners = new Map<string, string[]>();
    for (const file of files) {
      const value = (JSON.parse(readFileSync(file, 'utf8')) as Node)[key];
      if (typeof value !== 'string') continue;
      owners.set(value, [...(owners.get(value) ?? []), rel(file)]);
    }
    return [...owners].filter(([, owned]) => owned.length > 1);
  };

  it('uses a unique uid per file', () => {
    expect(duplicatesOf('uid')).toEqual([]);
  });

  it('uses a unique title per file (single provisioned folder)', () => {
    expect(duplicatesOf('title')).toEqual([]);
  });
});
