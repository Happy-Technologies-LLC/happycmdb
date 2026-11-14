/**
 * HAP-1826: the api-server container must not be granted NET_RAW / NET_ADMIN (or run privileged). nmap runs as the
 * unprivileged `nodejs` user with `-sT`, which needs none of them: the required CI job `API image runs nmap as nodejs`
 * (deploy/test-api-image-nmap.sh) proves it under the default caps and under `--cap-drop ALL`.
 *
 * Every tracked compose file defining an `api-server` service, and every tracked Kubernetes workload manifest with an
 * api-server container, is parsed. The detector is also run against inline fixtures that DO grant the caps, so a
 * detector that stopped seeing them (renamed key, new spelling) fails here instead of passing vacuously.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { parse, parseAllDocuments } from 'yaml';

const REPO = resolve(__dirname, '../../..');

const FORBIDDEN = new Set(['NET_RAW', 'NET_ADMIN', 'ALL']);
type Node = Record<string, unknown>;
const isMap = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `cap_net_raw`, `CAP_NET_RAW`, ` net_raw ` -> `NET_RAW`. */
const normalizeCap = (cap: unknown): string => String(cap).trim().toUpperCase().replace(/^CAP_/, '');
const forbiddenCaps = (caps: unknown): string[] =>
  (Array.isArray(caps) ? caps : []).map(normalizeCap).filter((cap) => FORBIDDEN.has(cap));
const isPrivileged = (value: unknown): boolean => value === true || String(value).trim().toLowerCase() === 'true';

/** Violations for the `api-server` service of one parsed compose document. */
function composeViolations(doc: unknown): string[] {
  const service = isMap(doc) && isMap(doc.services) ? doc.services['api-server'] : undefined;
  if (!isMap(service)) return [];
  return [
    ...forbiddenCaps(service.cap_add).map((cap) => `cap_add ${cap}`),
    ...(isPrivileged(service.privileged) ? ['privileged: true'] : []),
  ];
}

const WORKLOAD_KINDS = new Set(['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob']);

/** The pod spec of a workload: `spec` for a Pod, `spec.template.spec` for controllers, `spec.jobTemplate.spec.template.spec` for CronJob. */
function podSpec(doc: Node): Node | undefined {
  const spec = doc.spec;
  if (!isMap(spec)) return undefined;
  if (doc.kind === 'Pod') return spec;
  const template = doc.kind === 'CronJob' && isMap(spec.jobTemplate) && isMap(spec.jobTemplate.spec) ? spec.jobTemplate.spec.template : spec.template;
  return isMap(template) && isMap(template.spec) ? template.spec : undefined;
}

/** Violations for the api-server containers of one parsed Kubernetes document. A container counts when it is named
 *  `api-server`, or sits in a workload named `api-server`, or runs an image whose repository is `api-server`. */
function k8sViolations(doc: unknown): string[] {
  if (!isMap(doc) || typeof doc.kind !== 'string' || !WORKLOAD_KINDS.has(doc.kind)) return [];
  const spec = podSpec(doc);
  if (!spec) return [];
  const workloadName = isMap(doc.metadata) ? doc.metadata.name : undefined;
  const out: string[] = [];
  for (const key of ['containers', 'initContainers', 'ephemeralContainers']) {
    for (const container of Array.isArray(spec[key]) ? spec[key] : []) {
      if (!isMap(container)) continue;
      const image = typeof container.image === 'string' ? container.image : '';
      const repo = image.split('@')[0].split(':')[0].split('/').pop();
      if (container.name !== 'api-server' && workloadName !== 'api-server' && repo !== 'api-server') continue;
      const security = isMap(container.securityContext) ? container.securityContext : {};
      const capabilities = isMap(security.capabilities) ? security.capabilities : {};
      out.push(
        ...forbiddenCaps(capabilities.add).map((cap) => `${String(container.name)}: capabilities.add ${cap}`),
        ...(isPrivileged(security.privileged) ? [`${String(container.name)}: privileged: true`] : []),
      );
    }
  }
  return out;
}

const tracked = (...globs: string[]): string[] =>
  execFileSync('git', ['ls-files', '-z', '--', ...globs], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);

const COMPOSE_FILES = tracked(':(glob)**/*compose*.yml', ':(glob)**/*compose*.yaml').filter(
  (file) => isMap(parse(readFileSync(join(REPO, file), 'utf8'))?.services?.['api-server']),
);
const K8S_FILES = tracked(':(glob)**/*.yml', ':(glob)**/*.yaml').filter((file) => {
  const text = readFileSync(join(REPO, file), 'utf8');
  return /^kind:\s*(Pod|Deployment|StatefulSet|DaemonSet|ReplicaSet|Job|CronJob)\b/m.test(text) && /api-server/.test(text);
});

describe('api-server compose and Kubernetes manifests (HAP-1826)', () => {
  it('discovers the shipped compose files and the api-server Deployment, so the guard cannot go vacuous', () => {
    expect(COMPOSE_FILES).toEqual(expect.arrayContaining([
      'infrastructure/docker/docker-compose.yml',
      'infrastructure/docker/docker-compose.test.yml',
      'deploy/build01-staging.compose.yml',
    ]));
    expect(K8S_FILES).toContain('infrastructure/kubernetes/deployments/api-server-deployment.yaml');
  });

  it.each(COMPOSE_FILES)('%s: api-server has no NET_RAW/NET_ADMIN/ALL cap_add and is not privileged', (file) => {
    expect(composeViolations(parse(readFileSync(join(REPO, file), 'utf8')))).toEqual([]);
  });

  it.each(K8S_FILES)('%s: no api-server container adds NET_RAW/NET_ADMIN/ALL or is privileged', (file) => {
    const docs = parseAllDocuments(readFileSync(join(REPO, file), 'utf8')).map((doc) => doc.toJS());
    expect(docs.flatMap(k8sViolations)).toEqual([]);
  });

  describe('detector', () => {
    const compose = (service: string, body: string) => parse(`services:\n  ${service}:\n    image: x\n${body}`);

    it.each([
      ['NET_RAW', '    cap_add:\n      - NET_RAW\n', ['cap_add NET_RAW']],
      ['NET_ADMIN', '    cap_add: [NET_ADMIN]\n', ['cap_add NET_ADMIN']],
      ['CAP_ prefixed, lower case', '    cap_add: [cap_net_raw]\n', ['cap_add NET_RAW']],
      ['ALL', '    cap_add: [ALL]\n', ['cap_add ALL']],
      ['both', '    cap_add:\n      - NET_RAW\n      - NET_ADMIN\n', ['cap_add NET_RAW', 'cap_add NET_ADMIN']],
      ['privileged', '    privileged: true\n', ['privileged: true']],
    ])('reports %s on api-server', (_name, body, expected) => {
      expect(composeViolations(compose('api-server', body))).toEqual(expected);
    });

    it('ignores unrelated caps, cap_drop and the same caps on another service (scoped to api-server)', () => {
      expect(composeViolations(compose('api-server', '    cap_add: [CHOWN]\n    cap_drop: [ALL]\n'))).toEqual([]);
      expect(composeViolations(compose('neo4j', '    cap_add: [NET_RAW, NET_ADMIN]\n    privileged: true\n'))).toEqual([]);
    });

    const workload = (kind: string, name: string, containers: string) =>
      parse(`kind: ${kind}\nmetadata:\n  name: ${name}\nspec:\n  template:\n    spec:\n      containers:\n${containers}`);
    const container = (name: string, image: string, security: string) =>
      `        - name: ${name}\n          image: ${image}\n          securityContext:\n${security}`;

    it('reports caps and privileged on an api-server Deployment container', () => {
      const doc = workload('Deployment', 'api-server', container('api-server', 'happycmdb/api-server:latest',
        '            capabilities:\n              add: [NET_RAW, CAP_NET_ADMIN]\n            privileged: true\n'));
      expect(k8sViolations(doc)).toEqual([
        'api-server: capabilities.add NET_RAW', 'api-server: capabilities.add NET_ADMIN', 'api-server: privileged: true',
      ]);
    });

    it('reports an api-server image under a differently named container, and a CronJob template', () => {
      const sidecar = workload('Deployment', 'web', container('scanner', 'registry.example/happycmdb/api-server@sha256:abc',
        '            capabilities:\n              add: [NET_RAW]\n'));
      expect(k8sViolations(sidecar)).toEqual(['scanner: capabilities.add NET_RAW']);
      const cron = parse(
        'kind: CronJob\nmetadata:\n  name: api-server\nspec:\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          containers:\n' +
        '            - name: api-server\n              securityContext:\n                capabilities:\n                  add: [NET_ADMIN]\n');
      expect(k8sViolations(cron)).toEqual(['api-server: capabilities.add NET_ADMIN']);
    });

    it('ignores capabilities.drop and the same caps on other workloads', () => {
      const dropped = workload('Deployment', 'api-server', container('api-server', 'happycmdb/api-server:latest',
        '            capabilities:\n              drop: [ALL]\n'));
      expect(k8sViolations(dropped)).toEqual([]);
      const other = workload('StatefulSet', 'neo4j', container('neo4j', 'neo4j:5',
        '            capabilities:\n              add: [NET_RAW, NET_ADMIN]\n            privileged: true\n'));
      expect(k8sViolations(other)).toEqual([]);
    });
  });
});
