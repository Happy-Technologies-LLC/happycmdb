/**
 * HAP-1810: every api-server liveness/readiness/health probe definition must hit a
 * route that answers 2xx without credentials.
 *
 * HAP-1806 found every probe returning 404 or 401 because the probe definitions and
 * the registered routes had drifted apart. This reads the probe path out of each
 * definition (Dockerfile HEALTHCHECKs, Compose healthchecks, the k8s Deployment
 * probes, the Prometheus blackbox targets), mounts the REAL health router where
 * `rest/server.ts` mounts it (`/api/v1/cmdb-health`, above the shared `/api/v1`
 * auth gate, which is stubbed here as a 401), and fires each path.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import express from 'express';
import request from 'supertest';
import { parse, parseAllDocuments } from 'yaml';

const mockRun = jest.fn<Promise<unknown>, [string]>();
const mockClose = jest.fn(async () => undefined);
const mockGetSession = jest.fn(() => ({ run: mockRun, close: mockClose }));
const mockGet = jest.fn<Promise<string | null>, [string]>();
const mockSet = jest.fn<Promise<unknown>, [string, string, number]>();
const mockPostgresQuery = jest.fn<Promise<{ rows: unknown[] }>, [string]>();

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => ({ getSession: mockGetSession }),
  getPostgresClient: () => ({ query: mockPostgresQuery }),
  getRedisClient: () => ({ get: mockGet, set: mockSet }),
}));

// Authenticated health routes (/services, /metrics, /timeseries) refuse like the real gate.
jest.mock('../../../packages/api-server/src/auth/auth-bootstrap', () => ({
  getAuthMiddleware: () => ({
    authenticate: () => (_req: unknown, res: { status(code: number): { end(): void } }) =>
      res.status(401).end(),
  }),
}));

import healthRoutes from '../../../packages/api-server/src/health/health.routes';

const REPO = resolve(__dirname, '../../..');
const API_SERVICE_NAMES = ['api-server', 'api-server-e2e'];
const URL_PATTERN = /https?:\/\/[^\s"'\\]+/;

type Probe = { source: string; path: string };
type Node = Record<string, unknown>;

const isMap = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const read = (file: string): string => readFileSync(resolve(REPO, file), 'utf8');

function pathOf(source: string, text: string): string {
  const match = URL_PATTERN.exec(text);
  if (!match) throw new Error(`${source}: no probe URL in ${JSON.stringify(text)}`);
  return new URL(match[0]).pathname;
}

function dockerfileProbe(file: string): Probe {
  // Join backslash continuations, then take the HEALTHCHECK instruction.
  const lines = read(file).replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  const instruction = lines.filter((line) => /^\s*HEALTHCHECK\s/i.test(line));
  if (instruction.length !== 1) throw new Error(`${file}: expected one HEALTHCHECK`);
  return { source: file, path: pathOf(file, instruction[0]) };
}

function composeProbes(file: string): Probe[] {
  const services = (parse(read(file)) as Node).services as Node;
  const probes = Object.entries(services)
    .filter(([name]) => API_SERVICE_NAMES.includes(name))
    .map(([name, service]) => {
      const healthcheck = isMap(service) ? service.healthcheck : undefined;
      if (!isMap(healthcheck)) throw new Error(`${file}: ${name} has no healthcheck`);
      return {
        source: `${file}#${name}`,
        path: pathOf(`${file}#${name}`, JSON.stringify(healthcheck.test)),
      };
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
    for (const kind of ['livenessProbe', 'readinessProbe', 'startupProbe']) {
      const probe = container[kind];
      if (probe === undefined) continue;
      const httpGet = isMap(probe) ? probe.httpGet : undefined;
      if (!isMap(httpGet)) throw new Error(`${file}: ${container.name}.${kind} is not httpGet`);
      probes.push({ source: `${file}#${container.name}.${kind}`, path: String(httpGet.path) });
    }
  }
  if (probes.length === 0) throw new Error(`${file}: api-server has no probes`);
  return probes;
}

function prometheusProbes(file: string): Probe[] {
  const config = parse(read(file)) as Node;
  const job = (config.scrape_configs as Node[]).find((entry) => entry.job_name === 'blackbox');
  if (!job) throw new Error(`${file}: no blackbox job`);
  const targets = (job.static_configs as Node[]).flatMap((entry) => entry.targets as string[]);
  const probes = targets
    .filter((target) => new URL(target).hostname === 'api-server')
    .map((target) => ({ source: `${file}#${target}`, path: new URL(target).pathname }));
  if (probes.length === 0) throw new Error(`${file}: no api-server blackbox target`);
  return probes;
}

const PROBES: Probe[] = [
  dockerfileProbe('infrastructure/docker/Dockerfile.api'),
  dockerfileProbe('infrastructure/docker/Dockerfile.api.dev'),
  ...composeProbes('infrastructure/docker/docker-compose.yml'),
  ...composeProbes('infrastructure/docker/docker-compose.test.yml'),
  ...composeProbes('tests/e2e/docker-compose.e2e.yml'),
  ...composeProbes('deploy/build01-staging.compose.yml'),
  ...kubernetesProbes('infrastructure/kubernetes/deployments/api-server-deployment.yaml'),
  ...prometheusProbes('infrastructure/monitoring/prometheus/prometheus.yml'),
];

const app = express();
// Same order as RestAPIServer.setupRoutes: health above the shared /api/v1 auth gate.
app.use('/api/v1/cmdb-health', healthRoutes);
app.use('/api/v1', (_req, res) => res.status(401).end());

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
  it.each(PROBES)('$source probes $path and the real router answers 2xx', async ({ path }) => {
    const { status } = await request(app).get(path);
    expect({ path, ok2xx: status >= 200 && status < 300, status }).toEqual({
      path,
      ok2xx: true,
      status,
    });
  });
});
