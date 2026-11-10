/**
 * HAP-1810 / HAP-1819: every api-server liveness/readiness/health probe definition must
 * reach the port the api-server listens on and a route that answers 2xx without credentials.
 *
 * HAP-1806 found every probe returning 404 or 401 because the probe definitions and
 * the registered routes had drifted apart. This reads every probe URL out of each
 * definition (Dockerfile HEALTHCHECKs, Compose healthchecks, the k8s Deployment probes,
 * the Prometheus blackbox targets) and checks, per URL:
 *   - the port equals what the api-server binds in that definition. Precedence: explicit env
 *     `PORT` > the image's `ENV PORT` (a compose service resolves its `build.dockerfile`) > the
 *     code default, read through the real `listenTargetFromEnv`. A compose service with no
 *     `PORT` and no repo build, or a k8s container with no literal `PORT` (its registry image
 *     is not derivable here), fails instead of assuming a default. Dockerfile EXPOSE and k8s
 *     containerPort must agree: each is a named test, not a collection error;
 *   - the scheme is plain HTTP and the host is loopback (Dockerfile/Compose, run inside the
 *     container), `api-server` (Prometheus), or unset (k8s httpGet.host; scheme HTTP or unset);
 *   - the path is answered 2xx, anonymously, by the REAL `RestAPIServer` app (real mount
 *     order, so a health mount moved under the `/api/v1` auth gate gets a 401). Only the
 *     auth middleware and the databases are stubbed.
 * A chained `curl A || curl B` is checked URL by URL.
 */
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, relative, resolve } from 'path';
import request from 'supertest';
import { parse, parseAllDocuments } from 'yaml';

// Placeholder config so loadConfig() validates; no database is contacted.
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1',
  NEO4J_USERNAME: 'unused',
  NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1',
  POSTGRES_DB: 'unused',
  POSTGRES_USER: 'unused',
  POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1',
  KAFKA_CLIENT_ID: 'unused',
  KAFKA_GROUP_ID: 'unused',
});

const mockRun = jest.fn<Promise<unknown>, [string]>();
const mockClose = jest.fn(async () => undefined);
const mockGetSession = jest.fn(() => ({ run: mockRun, close: mockClose }));
const mockGet = jest.fn<Promise<string | null>, [string]>();
const mockSet = jest.fn<Promise<unknown>, [string, string, number]>();
const mockPostgresQuery = jest.fn<Promise<{ rows: unknown[] }>, [string]>();

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => ({ getSession: mockGetSession }),
  getPostgresClient: () => ({ query: mockPostgresQuery }),
  getRedisClient: () => ({ get: mockGet, set: mockSet, getConnection: () => ({}) }),
  getAuditService: () => ({}),
  getUnifiedCredentialService: () => ({}),
  getCredentialSetService: () => ({}),
}));

// The shared /api/v1 gate (and the health router's own authenticated routes) refuse like the
// real gate without credentials; role/permission factories pass through.
jest.mock('../../../packages/api-server/src/auth/auth-bootstrap', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  const deny = (_req: unknown, res: { status(code: number): { end(): void } }) =>
    res.status(401).end();
  const middleware = new Proxy(
    {},
    { get: (_target, name) => (name === 'authenticate' ? () => deny : () => pass) }
  );
  return { getAuthMiddleware: () => middleware, getAuthService: () => ({}) };
});

// JobsController opens a BullMQ Redis connection at import.
jest.mock('../../../packages/api-server/src/rest/routes/jobs.routes', () => ({
  __esModule: true,
  default: jest.requireActual('express').Router(),
}));

// RateLimitMiddleware starts an un-unref'd interval in its constructor.
jest.mock('../../../packages/api-server/src/middleware/rate-limit.middleware', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    RateLimitMiddleware: function RateLimitMiddleware() {
      return new Proxy({}, { get: () => () => pass });
    },
  };
});

import { RestAPIServer, listenTargetFromEnv } from '../../../packages/api-server/src/rest/server';

const REPO = resolve(__dirname, '../../..');
const API_SERVICE_NAMES = ['api-server', 'api-server-e2e'];
const URL_PATTERN = /https?:\/\/[^\s"'\\]+/g;
const MAIN_COMPOSE = 'infrastructure/docker/docker-compose.yml';

/**
 * One probe URL, with the port the api-server binds in the same definition.
 * `host` is undefined for a k8s httpGet without `host` (the pod IP). `scheme` is upper-case.
 */
type Probe = {
  source: string;
  path: string;
  scheme: string;
  host: string | undefined;
  allowedHosts: (string | undefined)[];
  urlPort: number;
  listenPort: number;
};
/** A definition-consistency check; `problem` is undefined when it holds. */
type Check = { name: string; problem: string | undefined };
type Collected = { probes: Probe[]; checks: Check[] };
type Node = Record<string, unknown>;

// A probe run inside the container reaches the api-server through loopback.
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

const isMap = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const read = (file: string): string => readFileSync(resolve(REPO, file), 'utf8');

/** The port `RestAPIServer` binds for this `PORT` value (undefined: its code default). */
const listenPortFor = (portEnv: string | undefined): number =>
  listenTargetFromEnv(portEnv === undefined ? {} : { PORT: portEnv }).port;

const urlPortOf = (url: URL): number => Number(url.port || (url.protocol === 'https:' ? 443 : 80));

/**
 * Runs one definition's collector. A parse/structure failure becomes a named failing check
 * (and the definition's probes are dropped) instead of throwing during collection.
 */
function collect(source: string, collector: () => Collected): Collected {
  const name = `${source}: reads as an api-server definition`;
  try {
    const collected = collector();
    return {
      probes: collected.probes,
      checks: [{ name, problem: undefined }, ...collected.checks],
    };
  } catch (error) {
    return { probes: [], checks: [{ name, problem: (error as Error).message }] };
  }
}

/**
 * The port the api-server binds. Precedence: explicit env `PORT` > the image's `ENV PORT` >
 * the code default. The code default applies only when the image resolves from this repo and
 * declares no `ENV PORT`; an image that cannot be resolved here is a problem, never a guess.
 * `imagePort` is called only when no explicit `PORT` is set, and throws when unresolvable.
 */
function resolveListenPort(
  label: string,
  explicit: string | undefined,
  imagePort: () => string | undefined
): { port: number | undefined; check: Check } {
  const name = `${label}: effective listen port resolves`;
  try {
    return { port: listenPortFor(explicit ?? imagePort()), check: { name, problem: undefined } };
  } catch (error) {
    return { port: undefined, check: { name, problem: (error as Error).message } };
  }
}

/** Every URL in `text`; chained probes (`curl A || curl B`) yield one Probe each. */
function probesIn(
  source: string,
  text: string,
  listenPort: number,
  allowedHosts: string[]
): Probe[] {
  const urls = text.match(URL_PATTERN) ?? [];
  if (urls.length === 0) throw new Error(`${source}: no probe URL in ${JSON.stringify(text)}`);
  return urls.map((raw, index) => {
    const url = new URL(raw);
    return {
      source: urls.length === 1 ? source : `${source}[url ${index + 1}]`,
      path: url.pathname,
      scheme: url.protocol.slice(0, -1).toUpperCase(),
      host: url.hostname,
      allowedHosts,
      urlPort: urlPortOf(url),
      listenPort,
    };
  });
}

/** A Dockerfile's instructions, backslash continuations joined. */
function dockerfileInstructions(file: string): (keyword: string) => string[] {
  const lines = read(file)
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/);
  return (keyword) => lines.filter((line) => new RegExp(`^\\s*${keyword}\\s`, 'i').test(line));
}

/** The image's `ENV PORT`; undefined when the Dockerfile sets none. */
function dockerfileEnvPort(file: string): string | undefined {
  const found = dockerfileInstructions(file)('ENV').flatMap((line) =>
    [...line.matchAll(/\bPORT=(\d+)/g)].map((m) => m[1])
  );
  if (found.length > 1) throw new Error(`${file}: expected at most one ENV PORT`);
  return found[0];
}

function dockerfileProbes(file: string): Collected {
  const only = dockerfileInstructions(file);
  const healthchecks = only('HEALTHCHECK');
  if (healthchecks.length !== 1) throw new Error(`${file}: expected one HEALTHCHECK`);
  const portEnv = dockerfileEnvPort(file);
  if (portEnv === undefined) throw new Error(`${file}: expected one ENV PORT`);
  const listenPort = listenPortFor(portEnv);
  const exposed = only('EXPOSE').flatMap((line) => line.split(/\s+/).slice(1).map(Number));
  const consistent = exposed.length === 1 && exposed[0] === listenPort;
  return {
    probes: probesIn(file, healthchecks[0], listenPort, LOOPBACK_HOSTS),
    checks: [
      {
        name: `${file}: EXPOSE equals ENV PORT`,
        problem: consistent ? undefined : `EXPOSE ${exposed} does not match ENV PORT ${listenPort}`,
      },
    ],
  };
}

function envValue(environment: unknown, name: string): string | undefined {
  if (Array.isArray(environment)) {
    const entry = environment.map(String).find((item) => item.startsWith(`${name}=`));
    return entry?.slice(name.length + 1);
  }
  const value = isMap(environment) ? environment[name] : undefined;
  return value === undefined ? undefined : String(value);
}

/** The Dockerfile a compose service builds, relative to the compose file's directory. */
function composeDockerfile(file: string, name: string, service: Node): string {
  const build = service.build;
  if (build === undefined) {
    throw new Error(
      `${name} has no build in this repo, so its image's ENV PORT is not derivable: set PORT explicitly`
    );
  }
  const context = isMap(build) ? String(build.context ?? '.') : String(build);
  const dockerfile = isMap(build) && build.dockerfile ? String(build.dockerfile) : 'Dockerfile';
  return relative(REPO, resolve(REPO, dirname(file), context, dockerfile));
}

function composeProbes(file: string): Collected {
  const services = (parse(read(file)) as Node).services as Node;
  const probes: Probe[] = [];
  const checks: Check[] = [];
  for (const [name, service] of Object.entries(services)) {
    if (!API_SERVICE_NAMES.includes(name)) continue;
    const source = `${file}#${name}`;
    const svc = service as Node;
    const healthcheck = isMap(service) ? service.healthcheck : undefined;
    if (!isMap(healthcheck)) throw new Error(`${file}: ${name} has no healthcheck`);
    const { port, check } = resolveListenPort(source, envValue(svc.environment, 'PORT'), () =>
      dockerfileEnvPort(composeDockerfile(file, name, svc))
    );
    checks.push(check);
    if (port !== undefined) {
      probes.push(...probesIn(source, JSON.stringify(healthcheck.test), port, LOOPBACK_HOSTS));
    }
  }
  if (checks.length === 0) throw new Error(`${file}: no api-server service`);
  return { probes, checks };
}

function kubernetesProbes(file: string): Collected {
  const deployment = parseAllDocuments(read(file))
    .map((doc) => doc.toJS() as unknown)
    .find(
      (doc): doc is Node =>
        isMap(doc) && doc.kind === 'Deployment' && (doc.metadata as Node).name === 'api-server'
    );
  if (!deployment) throw new Error(`${file}: no api-server Deployment`);
  const spec = ((deployment.spec as Node).template as Node).spec as Node;
  const probes: Probe[] = [];
  const checks: Check[] = [];
  for (const container of spec.containers as Node[]) {
    const source = `${file}#${container.name}`;
    const containerPorts = (container.ports as Node[] | undefined) ?? [];
    const env = (container.env as Node[] | undefined) ?? [];
    const literal = env
      .filter((entry) => entry.value !== undefined)
      .map((entry) => `${entry.name}=${entry.value}`);
    const { port: listenPort, check } = resolveListenPort(source, envValue(literal, 'PORT'), () => {
      // A k8s image is a registry tag (`happycmdb/api-server:latest`); nothing here maps it to a Dockerfile.
      throw new Error(
        `${container.name} sets no literal env PORT and image ${container.image} is not derivable from this repo: set PORT explicitly`
      );
    });
    checks.push(check);
    if (listenPort === undefined) continue;
    for (const kind of ['livenessProbe', 'readinessProbe', 'startupProbe']) {
      const probe = container[kind];
      if (probe === undefined) continue;
      const httpGet = isMap(probe) ? probe.httpGet : undefined;
      if (!isMap(httpGet)) throw new Error(`${file}: ${container.name}.${kind} is not httpGet`);
      // A probe port is a number or the name of a containerPort.
      const named = containerPorts.find((entry) => entry.name === httpGet.port);
      const urlPort = Number(named ? named.containerPort : httpGet.port);
      if (named) {
        checks.push({
          name: `${source}.${kind}: named port ${named.name} is the bound port`,
          problem:
            named.containerPort === listenPort
              ? undefined
              : `containerPort ${named.containerPort} is not PORT ${listenPort}`,
        });
      }
      probes.push({
        source: `${source}.${kind}`,
        path: String(httpGet.path),
        // httpGet.scheme defaults to HTTP and host to the pod IP; the api-server serves plain HTTP.
        scheme: String(httpGet.scheme ?? 'HTTP'),
        host: httpGet.host === undefined ? undefined : String(httpGet.host),
        allowedHosts: [undefined],
        urlPort,
        listenPort,
      });
    }
    checks.push({
      name: `${source}: declares containerPort equal to PORT`,
      problem: containerPorts.some((entry) => entry.containerPort === listenPort)
        ? undefined
        : `declares no containerPort ${listenPort}`,
    });
  }
  // An unresolved port already failed a named check above; do not mask it with a collection error.
  if (probes.length === 0 && checks.every((check) => check.problem === undefined)) {
    throw new Error(`${file}: api-server has no probes`);
  }
  return { probes, checks };
}

function prometheusProbes(file: string): Collected {
  const config = parse(read(file)) as Node;
  const job = (config.scrape_configs as Node[]).find((entry) => entry.job_name === 'blackbox');
  if (!job) throw new Error(`${file}: no blackbox job`);
  // Targets reach the api-server container on the network: the port it binds in the main compose.
  const mainProbes = composeProbes(MAIN_COMPOSE).probes;
  if (mainProbes.length === 0) throw new Error(`${MAIN_COMPOSE}: api-server port did not resolve`);
  const listenPort = mainProbes[0].listenPort;
  const targets = (job.static_configs as Node[]).flatMap((entry) => entry.targets as string[]);
  const probes = targets
    .filter((target) => new URL(target).hostname === 'api-server')
    .flatMap((target) => probesIn(`${file}#${target}`, target, listenPort, ['api-server']));
  if (probes.length === 0) throw new Error(`${file}: no api-server blackbox target`);
  return { probes, checks: [] };
}

const DEFINITIONS: [string, (file: string) => Collected][] = [
  ['infrastructure/docker/Dockerfile.api', dockerfileProbes],
  ['infrastructure/docker/Dockerfile.api.dev', dockerfileProbes],
  [MAIN_COMPOSE, composeProbes],
  ['infrastructure/docker/docker-compose.test.yml', composeProbes],
  ['tests/e2e/docker-compose.e2e.yml', composeProbes],
  ['deploy/build01-staging.compose.yml', composeProbes],
  ['infrastructure/kubernetes/deployments/api-server-deployment.yaml', kubernetesProbes],
  ['infrastructure/monitoring/prometheus/prometheus.yml', prometheusProbes],
];
const COLLECTED: Collected[] = DEFINITIONS.map(([file, collector]) =>
  collect(file, () => collector(file))
);
const PROBES: Probe[] = COLLECTED.flatMap((collected) => collected.probes);
const CHECKS: Check[] = COLLECTED.flatMap((collected) => collected.checks);

// The real app, as index.ts builds it (error handling is mounted after GraphQL there, not needed).
const app = new RestAPIServer(0).getApp();

beforeEach(() => {
  mockRun.mockResolvedValue({ records: [{ test: 1 }] });
  mockGetSession.mockImplementation(() => ({ run: mockRun, close: mockClose }));
  mockGet.mockImplementation(async (key) =>
    key === '__health_check__' || key === '__readiness_check__' ? 'test' : 'ok'
  );
  mockSet.mockResolvedValue(undefined);
  mockPostgresQuery.mockResolvedValue({ rows: [{ test: 1 }] });
});

describe('api-server probe definitions', () => {
  it('the real app puts the shared auth gate in front of ordinary /api/v1 routes', async () => {
    const { status } = await request(app).get('/api/v1/cis');
    expect(status).toBe(401);
  });

  // Definition consistency: a mismatch is a failing case with the definition in its name,
  // never a collection error that reports `Tests: 0 total`.
  it.each(CHECKS)('$name', ({ problem }) => {
    expect(problem).toBeUndefined();
  });

  it.each(PROBES)('$source targets the bound port $listenPort', ({ urlPort, listenPort }) => {
    expect(urlPort).toBe(listenPort);
  });

  it.each(PROBES)('$source is plain HTTP at an allowed host', ({ scheme, host, allowedHosts }) => {
    // The api-server serves plain HTTP; a probe of `https` or of a foreign host never reaches it.
    expect(scheme).toBe('HTTP');
    expect(allowedHosts).toContain(host);
  });

  it.each(PROBES)('$source probes $path and the real app answers 2xx', async ({ path }) => {
    const { status } = await request(app).get(path);
    expect({ path, ok2xx: status >= 200 && status < 300, status }).toEqual({
      path,
      ok2xx: true,
      status,
    });
  });
});
