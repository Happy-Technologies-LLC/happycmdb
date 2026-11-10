/**
 * HAP-1810 / HAP-1819: every api-server liveness/readiness/health probe definition must
 * reach the port the api-server listens on and a route that answers 2xx without credentials.
 *
 * HAP-1806 found every probe returning 404 or 401 because the probe definitions and
 * the registered routes had drifted apart. This reads every probe URL out of each
 * definition (Dockerfile HEALTHCHECKs, Compose healthchecks, the k8s Deployment probes,
 * the Prometheus blackbox targets) and checks, per URL:
 *   - the port equals what the api-server binds in that definition (`PORT`, read through
 *     the real `listenTargetFromEnv`; Dockerfile EXPOSE and k8s containerPort agree);
 *   - the path is answered 2xx, anonymously, by the REAL `RestAPIServer` app (real mount
 *     order, so a health mount moved under the `/api/v1` auth gate gets a 401). Only the
 *     auth middleware and the databases are stubbed.
 * A chained `curl A || curl B` is checked URL by URL.
 */
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import request from 'supertest';
import { parse, parseAllDocuments } from 'yaml';

// Placeholder config so loadConfig() validates; no database is contacted.
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
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

import {
  RestAPIServer,
  listenTargetFromEnv,
} from '../../../packages/api-server/src/rest/server';

const REPO = resolve(__dirname, '../../..');
const API_SERVICE_NAMES = ['api-server', 'api-server-e2e'];
const URL_PATTERN = /https?:\/\/[^\s"'\\]+/g;
const MAIN_COMPOSE = 'infrastructure/docker/docker-compose.yml';

/** One probe URL, with the port the api-server binds in the same definition. */
type Probe = { source: string; path: string; urlPort: number; listenPort: number };
type Node = Record<string, unknown>;

const isMap = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const read = (file: string): string => readFileSync(resolve(REPO, file), 'utf8');

/** The port `RestAPIServer` binds for this `PORT` value (undefined: its default). */
const listenPortFor = (portEnv: string | undefined): number =>
  listenTargetFromEnv(portEnv === undefined ? {} : { PORT: portEnv }).port;

const urlPortOf = (url: URL): number => Number(url.port || (url.protocol === 'https:' ? 443 : 80));

/** Every URL in `text`; chained probes (`curl A || curl B`) yield one Probe each. */
function probesIn(source: string, text: string, listenPort: number): Probe[] {
  const urls = text.match(URL_PATTERN) ?? [];
  if (urls.length === 0) throw new Error(`${source}: no probe URL in ${JSON.stringify(text)}`);
  return urls.map((raw, index) => {
    const url = new URL(raw);
    return {
      source: urls.length === 1 ? source : `${source}[url ${index + 1}]`,
      path: url.pathname,
      urlPort: urlPortOf(url),
      listenPort,
    };
  });
}

function dockerfileProbes(file: string): Probe[] {
  // Join backslash continuations, then take the HEALTHCHECK/ENV/EXPOSE instructions.
  const lines = read(file).replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  const only = (keyword: string): string[] =>
    lines.filter((line) => new RegExp(`^\\s*${keyword}\\s`, 'i').test(line));
  const healthchecks = only('HEALTHCHECK');
  if (healthchecks.length !== 1) throw new Error(`${file}: expected one HEALTHCHECK`);
  const portEnv = only('ENV').flatMap((line) => [...line.matchAll(/\bPORT=(\d+)/g)].map((m) => m[1]));
  if (portEnv.length !== 1) throw new Error(`${file}: expected one ENV PORT`);
  const listenPort = listenPortFor(portEnv[0]);
  const exposed = only('EXPOSE').flatMap((line) => line.split(/\s+/).slice(1).map(Number));
  if (exposed.length !== 1 || exposed[0] !== listenPort) {
    throw new Error(`${file}: EXPOSE ${exposed} does not match ENV PORT ${listenPort}`);
  }
  return probesIn(file, healthchecks[0], listenPort);
}

function envValue(environment: unknown, name: string): string | undefined {
  if (Array.isArray(environment)) {
    const entry = environment.map(String).find((item) => item.startsWith(`${name}=`));
    return entry?.slice(name.length + 1);
  }
  const value = isMap(environment) ? environment[name] : undefined;
  return value === undefined ? undefined : String(value);
}

function composeProbes(file: string): Probe[] {
  const services = (parse(read(file)) as Node).services as Node;
  const probes = Object.entries(services)
    .filter(([name]) => API_SERVICE_NAMES.includes(name))
    .flatMap(([name, service]) => {
      const healthcheck = isMap(service) ? service.healthcheck : undefined;
      if (!isMap(healthcheck)) throw new Error(`${file}: ${name} has no healthcheck`);
      const listenPort = listenPortFor(envValue((service as Node).environment, 'PORT'));
      return probesIn(`${file}#${name}`, JSON.stringify(healthcheck.test), listenPort);
    });
  if (probes.length === 0) throw new Error(`${file}: no api-server service`);
  return probes;
}

function kubernetesProbes(file: string): Probe[] {
  const deployment = parseAllDocuments(read(file))
    .map((doc) => doc.toJS() as unknown)
    .find(
      (doc): doc is Node =>
        isMap(doc) && doc.kind === 'Deployment' && (doc.metadata as Node).name === 'api-server'
    );
  if (!deployment) throw new Error(`${file}: no api-server Deployment`);
  const spec = ((deployment.spec as Node).template as Node).spec as Node;
  const probes: Probe[] = [];
  for (const container of spec.containers as Node[]) {
    const containerPorts = (container.ports as Node[] | undefined) ?? [];
    const listenPort = listenPortFor(
      envValue(
        ((container.env as Node[] | undefined) ?? []).map((e) => `${e.name}=${e.value}`),
        'PORT'
      )
    );
    for (const kind of ['livenessProbe', 'readinessProbe', 'startupProbe']) {
      const probe = container[kind];
      if (probe === undefined) continue;
      const httpGet = isMap(probe) ? probe.httpGet : undefined;
      if (!isMap(httpGet)) throw new Error(`${file}: ${container.name}.${kind} is not httpGet`);
      // A probe port is a number or the name of a containerPort.
      const named = containerPorts.find((entry) => entry.name === httpGet.port);
      const urlPort = Number(named ? named.containerPort : httpGet.port);
      if (named && named.containerPort !== listenPort) {
        throw new Error(`${file}: containerPort ${named.containerPort} is not PORT ${listenPort}`);
      }
      probes.push({
        source: `${file}#${container.name}.${kind}`,
        path: String(httpGet.path),
        urlPort,
        listenPort,
      });
    }
    if (!containerPorts.some((entry) => entry.containerPort === listenPort)) {
      throw new Error(`${file}: ${container.name} declares no containerPort ${listenPort}`);
    }
  }
  if (probes.length === 0) throw new Error(`${file}: api-server has no probes`);
  return probes;
}

function prometheusProbes(file: string): Probe[] {
  const config = parse(read(file)) as Node;
  const job = (config.scrape_configs as Node[]).find((entry) => entry.job_name === 'blackbox');
  if (!job) throw new Error(`${file}: no blackbox job`);
  // Targets reach the api-server container on the network: the port it binds in the main compose.
  const listenPort = composeProbes(MAIN_COMPOSE)[0].listenPort;
  const targets = (job.static_configs as Node[]).flatMap((entry) => entry.targets as string[]);
  const probes = targets
    .filter((target) => new URL(target).hostname === 'api-server')
    .flatMap((target) => probesIn(`${file}#${target}`, target, listenPort));
  if (probes.length === 0) throw new Error(`${file}: no api-server blackbox target`);
  return probes;
}

const PROBES: Probe[] = [
  ...dockerfileProbes('infrastructure/docker/Dockerfile.api'),
  ...dockerfileProbes('infrastructure/docker/Dockerfile.api.dev'),
  ...composeProbes(MAIN_COMPOSE),
  ...composeProbes('infrastructure/docker/docker-compose.test.yml'),
  ...composeProbes('tests/e2e/docker-compose.e2e.yml'),
  ...composeProbes('deploy/build01-staging.compose.yml'),
  ...kubernetesProbes('infrastructure/kubernetes/deployments/api-server-deployment.yaml'),
  ...prometheusProbes('infrastructure/monitoring/prometheus/prometheus.yml'),
];

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

  it.each(PROBES)('$source targets the bound port $listenPort', ({ urlPort, listenPort }) => {
    expect(urlPort).toBe(listenPort);
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
