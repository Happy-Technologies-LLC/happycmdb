/**
 * HAP-881: the web-ui Compose healthcheck must probe a socket the web-ui image's
 * nginx actually listens on.
 *
 * nginx in the web-ui image listens on IPv4 only (`listen 80;`). Inside the
 * nginx:alpine container busybox wget resolves `localhost` to ::1 first and does
 * not fall back to 127.0.0.1, so a `http://localhost/health` probe exits 1 and
 * Docker reports web-ui UNHEALTHY while nginx serves /health 200 on 127.0.0.1
 * (operator g32 staging observation).
 *
 * Each stack is rendered from the ordered `-f` file list Compose would use, and
 * the probe is checked against the `listen` directives of the nginx config the
 * service's Dockerfile copies into the image. The staging stack is the actual
 * Build01 pair: deploy/build01-staging.compose.yml, then the deploy-app.sh
 * generation override (byte-faithful operator copy of happycmdb-g33.yml,
 * sha256 b2b9c9c943af6cc336031c5eea3ba4b0078270ff3e088f5f1412c1e88eb5c011).
 */
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { parseDocument } from 'yaml';

const REPO = resolve(__dirname, '../../..');
const NGINX_CONF_TARGET = '/etc/nginx/conf.d/default.conf';

type Node = Record<string, unknown>;
type Socket = { family: 4 | 6; address: string | null; port: number };

const isMap = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function loadComposeFile(path: string): Node {
  const doc = parseDocument(readFileSync(path, 'utf8'));
  // Fail closed on anything this renderer does not model (e.g. !reset/!override tags).
  const problems = [...doc.errors, ...doc.warnings].map((problem) => problem.message);
  if (problems.length > 0) throw new Error(`${path}: ${problems.join('; ')}`);
  const content = doc.toJS() as Node;
  if ('include' in content) throw new Error(`${path}: include is not modelled`);
  return content;
}

// Compose merge rules: mappings merge, scalars replace, sequences append, except
// command/entrypoint/healthcheck.test, which the later file replaces.
function merge(base: unknown, override: unknown, path: string[]): unknown {
  if (isMap(base) && isMap(override)) {
    const merged: Node = { ...base };
    for (const [key, value] of Object.entries(override)) {
      merged[key] = key in base ? merge(base[key], value, [...path, key]) : value;
    }
    return merged;
  }
  const key = path.join('.');
  const replaces = /^services\.[^.]+\.(command|entrypoint|healthcheck\.test)$/.test(key);
  if (Array.isArray(base) && Array.isArray(override) && !replaces) return [...base, ...override];
  return override;
}

function renderWebUi(composeFiles: string[]): { service: Node; projectDir: string } {
  const paths = composeFiles.map((file) => resolve(REPO, file));
  const rendered = paths.map(loadComposeFile).reduce((base, next) => merge(base, next, []) as Node);
  const service = (rendered.services as Node | undefined)?.['web-ui'];
  if (!isMap(service)) throw new Error('web-ui service missing from rendered stack');
  if ('extends' in service) throw new Error('web-ui extends is not modelled');
  // Compose resolves relative paths against the first file's directory.
  return { service, projectDir: dirname(paths[0]) };
}

function probeOf(service: Node): { socket: Socket; path: string } {
  const healthcheck = service.healthcheck;
  if (!isMap(healthcheck) || healthcheck.disable === true) throw new Error('no web-ui healthcheck');
  const test = healthcheck.test;
  if (!Array.isArray(test) || test[0] !== 'CMD' || test[1] !== 'wget') {
    throw new Error(`unexpected web-ui healthcheck test: ${JSON.stringify(test)}`);
  }
  const url = new URL(String(test.find((arg) => /^https?:\/\//.test(String(arg)))));
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const host = url.hostname;
  if (host === 'localhost')
    return { socket: { family: 6, address: '::1', port }, path: url.pathname };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return { socket: { family: 4, address: host, port }, path: url.pathname };
  }
  if (host.startsWith('[')) {
    return { socket: { family: 6, address: host.slice(1, -1), port }, path: url.pathname };
  }
  throw new Error(`probe host ${host} has no modelled in-container resolution`);
}

function nginxListens(service: Node, projectDir: string): Socket[] {
  const build = service.build;
  if (!isMap(build)) throw new Error('web-ui has no build section');
  const context = resolve(projectDir, String(build.context ?? '.'));
  const dockerfile = readFileSync(
    resolve(context, String(build.dockerfile ?? 'Dockerfile')),
    'utf8'
  );
  const finalStage = dockerfile.split(/^FROM\s/m).pop() ?? '';
  const copy = finalStage
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find((words) => words[0] === 'COPY' && words[words.length - 1] === NGINX_CONF_TARGET);
  if (!copy) throw new Error(`Dockerfile does not COPY ${NGINX_CONF_TARGET}`);
  const source = copy.slice(1, -1).filter((word) => !word.startsWith('--'));
  if (source.length !== 1) throw new Error(`unexpected COPY sources: ${source.join(' ')}`);

  const conf = readFileSync(resolve(context, source[0]), 'utf8').replace(/#.*$/gm, '');
  return [...conf.matchAll(/^\s*listen\s+([^\s;]+)[^;]*;/gm)].map(([, value]) => {
    const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
    if (v6) return { family: 6, address: v6[1] === '::' ? null : v6[1], port: Number(v6[2] ?? 80) };
    const v4 = /^(?:(\*|\d+\.\d+\.\d+\.\d+):)?(\d+)$/.exec(value);
    if (v4) {
      return { family: 4, address: !v4[1] || v4[1] === '*' ? null : v4[1], port: Number(v4[2]) };
    }
    throw new Error(`unmodelled nginx listen ${value}`);
  });
}

const accepts = (listen: Socket, probe: Socket): boolean =>
  listen.family === probe.family &&
  listen.port === probe.port &&
  (listen.address === null || listen.address === probe.address);

describe.each([
  {
    stack: 'Build01 staging (deploy-app.sh pair)',
    files: [
      'deploy/build01-staging.compose.yml',
      'tests/unit/deploy/fixtures/happycmdb-g33.override.yml',
    ],
  },
  { stack: 'local Docker', files: ['infrastructure/docker/docker-compose.yml'] },
])('$stack web-ui healthcheck', ({ files }) => {
  it('probes /health on a socket the web-ui nginx listens on', () => {
    const { service, projectDir } = renderWebUi(files);
    const probe = probeOf(service);
    const listens = nginxListens(service, projectDir);

    expect({
      probe: probe.socket,
      listens,
      bound: listens.some((l) => accepts(l, probe.socket)),
    }).toEqual({ probe: probe.socket, listens, bound: true });
    expect(probe).toEqual({
      socket: { family: 4, address: '127.0.0.1', port: 80 },
      path: '/health',
    });
  });
});
