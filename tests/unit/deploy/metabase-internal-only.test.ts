/**
 * cm-fu-bi-tenant-scope (cmdb#318 review, operator decision): Metabase is an INTERNAL staff and operator tool. Its BI
 * views contain every organization's rows and Metabase cannot restrict a user to one tenant, so no shipped manifest
 * may publish it: no Ingress / HTTPRoute routes to it, its Service is ClusterIP, and every compose file that publishes
 * its port binds loopback only.
 *
 * Every tracked YAML file is parsed (not grepped). The detectors also run against inline fixtures that DO publish
 * Metabase, so a detector that stopped seeing them (renamed key, new spelling) fails here instead of passing vacuously.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { parse, parseAllDocuments } from 'yaml';

const REPO = resolve(__dirname, '../../..');

type Node = Record<string, unknown>;
const isMap = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const isMetabase = (value: unknown): boolean => typeof value === 'string' && /metabase/i.test(value);

/** A Kubernetes backend reference: Ingress `backend.service.name`, HTTPRoute `backendRefs[].name`. */
const backendNames = (backend: unknown): unknown[] =>
  isMap(backend) ? [isMap(backend.service) ? backend.service.name : undefined, backend.name] : [];

/** A Service or pod label set that targets Metabase: `app: metabase` (or `app.kubernetes.io/name: metabase`). */
const targetsMetabase = (labels: unknown): boolean =>
  isMap(labels) && [labels.app, labels['app.kubernetes.io/name']].some(isMetabase);

const nameOf = (doc: Node): unknown => (isMap(doc.metadata) ? doc.metadata.name : undefined);

/** Names of the Services whose selector targets Metabase pods, whatever the Service is called. */
function metabaseServiceNames(docs: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const doc of docs) {
    if (isMap(doc) && doc.kind === 'Service' && isMap(doc.spec) && targetsMetabase(doc.spec.selector)) names.add(String(nameOf(doc)));
  }
  return names;
}

const WORKLOAD_KINDS = ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'ReplicationController', 'Job', 'CronJob'];

/** The pod template (`{ metadata, spec }`) of a workload document; a bare Pod is its own template. */
function podTemplate(doc: Node): Node | undefined {
  const spec = isMap(doc.spec) ? doc.spec : {};
  if (doc.kind === 'Pod') return { metadata: doc.metadata, spec };
  const template = doc.kind === 'CronJob' ? (isMap(spec.jobTemplate) && isMap(spec.jobTemplate.spec) ? spec.jobTemplate.spec.template : undefined) : spec.template;
  return isMap(template) ? template : undefined;
}

/** Reasons one parsed Kubernetes document exposes Metabase beyond the cluster. `services` = Services that select Metabase pods. */
function k8sExposure(doc: unknown, services: ReadonlySet<string>): string[] {
  if (!isMap(doc) || typeof doc.kind !== 'string') return [];
  const spec = isMap(doc.spec) ? doc.spec : {};
  const name = nameOf(doc);
  const out: string[] = [];
  const isMetabaseBackend = (backend: unknown): boolean => typeof backend === 'string' && (services.has(backend) || isMetabase(backend));

  if (doc.kind === 'Ingress') {
    const hosts = [
      ...list(spec.rules).map((rule) => (isMap(rule) ? rule.host : undefined)),
      ...list(spec.tls).flatMap((tls) => (isMap(tls) ? list(tls.hosts) : [])),
    ];
    const backends = [
      ...backendNames(spec.defaultBackend),
      ...list(spec.rules).flatMap((rule) =>
        isMap(rule) && isMap(rule.http) ? list(rule.http.paths).flatMap((path) => (isMap(path) ? backendNames(path.backend) : [])) : []),
    ];
    if (isMetabase(name) || hosts.some(isMetabase) || backends.some(isMetabaseBackend)) out.push(`Ingress ${String(name)}`);
  }

  if (doc.kind === 'HTTPRoute') {
    const refs = list(spec.rules).flatMap((rule) => (isMap(rule) ? list(rule.backendRefs).flatMap(backendNames) : []));
    if (isMetabase(name) || refs.some(isMetabaseBackend) || list(spec.hostnames).some(isMetabase)) out.push(`HTTPRoute ${String(name)}`);
  }

  // A Service is Metabase's by its selector, not by its name: a Service called "bi" that selects app: metabase counts.
  if (doc.kind === 'Service' && targetsMetabase(spec.selector)) {
    const type = spec.type ?? 'ClusterIP';
    if (type !== 'ClusterIP') out.push(`Service ${String(name)} is ${String(type)}`);
    if (list(spec.externalIPs).length > 0) out.push(`Service ${String(name)} sets externalIPs`);
  }

  if (WORKLOAD_KINDS.includes(doc.kind)) {
    const template = podTemplate(doc);
    const podSpec = template && isMap(template.spec) ? template.spec : {};
    const containers = [...list(podSpec.containers), ...list(podSpec.initContainers)].filter(isMap);
    const labels = template && isMap(template.metadata) ? template.metadata.labels : undefined;
    if (template && (isMetabase(name) || targetsMetabase(labels) || containers.some((c) => isMetabase(c.image)))) {
      const who = `${doc.kind} ${String(name)}`;
      if (podSpec.hostNetwork === true) out.push(`${who} sets hostNetwork`);
      for (const container of containers) {
        for (const port of list(container.ports)) {
          if (isMap(port) && Number(port.hostPort) > 0) out.push(`${who} publishes hostPort ${String(port.hostPort)}`);
        }
      }
      if (list(podSpec.externalIPs).length > 0) out.push(`${who} sets externalIPs`);
    }
  }
  return out;
}

const LOOPBACK = /^(127(\.\d{1,3}){3}|localhost|\[::1\])$/;

/**
 * Reasons a Metabase service of one parsed compose document is reachable beyond loopback: `network_mode: host`, or a
 * published port with no loopback host address. A service is Metabase's by name or by image, not by name alone.
 */
function composeExposure(doc: unknown): string[] {
  if (!isMap(doc) || !isMap(doc.services)) return [];
  const out: string[] = [];
  for (const [id, service] of Object.entries(doc.services)) {
    if (!isMap(service) || !(isMetabase(id) || isMetabase(service.image))) continue;
    if (String(service.network_mode ?? '').trim() === 'host') out.push(`${id}: network_mode host`);
    for (const port of list(service.ports)) {
      if (isMap(port)) {
        if (port.published !== undefined && !LOOPBACK.test(String(port.host_ip ?? ''))) out.push(`${id}: ports ${JSON.stringify(port)}`);
        continue;
      }
      // "[ip:]host:container[/proto]"; ${VAR:-default} interpolation holds colons, so flatten it first.
      const spec = String(port).replace(/\$\{[^}]*\}/g, 'VAR');
      const parts = spec.split(/:(?![^[]*\])/);
      if (parts.length === 1) continue; // container port only: not published
      if (parts.length === 2 || !LOOPBACK.test(parts[0])) out.push(`${id}: ports ${String(port)}`);
    }
  }
  return out;
}

const tracked = (...globs: string[]): string[] =>
  execFileSync('git', ['ls-files', '-z', '--', ...globs], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);
// Templated or otherwise unparsable files (Helm `{{ }}`) yield no documents rather than failing the scan.
const docsOf = (file: string): unknown[] =>
  parseAllDocuments(readFileSync(join(REPO, file), 'utf8')).filter((doc) => doc.errors.length === 0).map((doc) => doc.toJS());

const YAML_FILES = tracked(':(glob)**/*.yml', ':(glob)**/*.yaml').filter((file) => !file.startsWith('node_modules/'));
const COMPOSE_FILES = YAML_FILES.filter((file) => /compose/i.test(file));
const METABASE_MANIFEST = 'infrastructure/kubernetes/deployments/metabase-deployment.yaml';

const K8S_DOCS = YAML_FILES.flatMap((file) => docsOf(file).map((doc) => ({ file, doc })));
const METABASE_SERVICES = metabaseServiceNames(K8S_DOCS.map(({ doc }) => doc));

describe('Metabase is internal-only (staff and operator tool)', () => {
  it('finds the Metabase manifest, its Service and the shipped compose file, so the checks cannot go vacuous', () => {
    expect(YAML_FILES).toEqual(expect.arrayContaining([METABASE_MANIFEST, 'infrastructure/docker/docker-compose.yml']));
    const kinds = docsOf(METABASE_MANIFEST).filter(isMap).map((doc) => doc.kind);
    expect(kinds).toEqual(expect.arrayContaining(['Deployment', 'Service']));
    expect(METABASE_SERVICES.has('metabase')).toBe(true); // matched by its selector
    const workloads = docsOf(METABASE_MANIFEST).filter((doc) => isMap(doc) && WORKLOAD_KINDS.includes(String(doc.kind)));
    expect(workloads.length).toBeGreaterThan(0);
    const compose = parse(readFileSync(join(REPO, 'infrastructure/docker/docker-compose.yml'), 'utf8'));
    expect(list((compose.services.metabase as Node).ports)).not.toHaveLength(0);
  });

  it('no tracked Kubernetes manifest routes to Metabase, publishes it on the host, or exposes its Service beyond ClusterIP', () => {
    const exposure = K8S_DOCS.flatMap(({ file, doc }) => k8sExposure(doc, METABASE_SERVICES).map((reason) => `${file}: ${reason}`));
    expect(exposure).toEqual([]);
  });

  it('no tracked compose file publishes Metabase on a non-loopback interface or on the host network', () => {
    const exposure = COMPOSE_FILES.flatMap((file) =>
      composeExposure(parse(readFileSync(join(REPO, file), 'utf8'))).map((reason) => `${file}: ${reason}`));
    expect(exposure).toEqual([]);
  });

  describe('detectors', () => {
    const k8s = (text: string, services: string[] = []) => k8sExposure(parse(text), new Set(services));
    const composeOf = (body: string) => composeExposure(parse(`services:\n${body}`));
    const compose = (ports: string) => composeOf(`  metabase:\n    image: x\n    ports:\n${ports}`);
    const podSpec = (body: string) => `containers:\n  - name: app\n    image: metabase/metabase:v0.50\n${body}`;
    const deployment = (spec: string, labels = 'app: metabase') =>
      `kind: Deployment\nmetadata:\n  name: bi\nspec:\n  template:\n    metadata:\n      labels:\n        ${labels}\n    spec:\n${spec.replace(/^/gm, '      ')}\n`;

    it('flag an Ingress by host, backend service, tls host or name, and an HTTPRoute', () => {
      const ingress = (body: string) => `kind: Ingress\nmetadata:\n  name: edge\nspec:\n${body}`;
      expect(k8s(ingress('  rules:\n    - host: metabase.example.io\n'))).toEqual(['Ingress edge']);
      expect(k8s(ingress('  tls:\n    - hosts: [bi.example.io, metabase.example.io]\n'))).toEqual(['Ingress edge']);
      expect(k8s(ingress('  rules:\n    - host: bi.example.io\n      http:\n        paths:\n          - path: /\n            backend:\n              service:\n                name: metabase\n')))
        .toEqual(['Ingress edge']);
      expect(k8s(ingress('  defaultBackend:\n    service:\n      name: metabase\n'))).toEqual(['Ingress edge']);
      expect(k8s('kind: Ingress\nmetadata:\n  name: metabase\nspec: {}\n')).toEqual(['Ingress metabase']);
      expect(k8s('kind: HTTPRoute\nmetadata:\n  name: r\nspec:\n  rules:\n    - backendRefs:\n        - name: metabase\n')).toEqual(['HTTPRoute r']);
    });

    it('flag an Ingress or HTTPRoute backend that is a differently named Service selecting Metabase, and not one that is not', () => {
      const ingress = 'kind: Ingress\nmetadata:\n  name: edge\nspec:\n  defaultBackend:\n    service:\n      name: bi\n';
      const route = 'kind: HTTPRoute\nmetadata:\n  name: r\nspec:\n  rules:\n    - backendRefs:\n        - name: bi\n';
      expect(k8s(ingress, ['bi'])).toEqual(['Ingress edge']);
      expect(k8s(route, ['bi'])).toEqual(['HTTPRoute r']);
      expect(k8s(ingress, ['other'])).toEqual([]);
      expect(k8s(route)).toEqual([]);
      const services = metabaseServiceNames([
        parse('kind: Service\nmetadata:\n  name: bi\nspec:\n  selector:\n    app: metabase\n'),
        parse('kind: Service\nmetadata:\n  name: metabase-docs\nspec:\n  selector:\n    app: docs\n'),
      ]);
      expect([...services]).toEqual(['bi']);
    });

    it('match a Service by its selector, not its name: flag one that is not ClusterIP or sets externalIPs', () => {
      const service = (name: string, selector: string, spec: string) =>
        `kind: Service\nmetadata:\n  name: ${name}\nspec:\n  selector:\n    ${selector}\n${spec}`;
      expect(k8s(service('bi', 'app: metabase', '  type: LoadBalancer\n'))).toEqual(['Service bi is LoadBalancer']);
      expect(k8s(service('bi', 'app: metabase', '  type: NodePort\n'))).toEqual(['Service bi is NodePort']);
      expect(k8s(service('bi', 'app.kubernetes.io/name: metabase', '  externalIPs: [203.0.113.5]\n'))).toEqual(['Service bi sets externalIPs']);
      expect(k8s(service('bi', 'app: metabase', '  type: ClusterIP\n'))).toEqual([]);
      expect(k8s(service('bi', 'app: metabase', ''))).toEqual([]);
      // not Metabase's by selector, whatever it is called
      expect(k8s(service('metabase', 'app: docs', '  type: LoadBalancer\n'))).toEqual([]);
      expect(k8s(service('api', 'app: api', '  type: LoadBalancer\n  externalIPs: [203.0.113.5]\n'))).toEqual([]);
      expect(k8s('kind: Service\nmetadata:\n  name: metabase\nspec:\n  type: LoadBalancer\n')).toEqual([]); // no selector
    });

    it('ignore an Ingress that does not name Metabase', () => {
      expect(k8s('kind: Ingress\nmetadata:\n  name: api\nspec:\n  rules:\n    - host: api.example.io\n')).toEqual([]);
    });

    it('flag a Metabase workload that sets hostNetwork', () => {
      expect(k8s(deployment(podSpec('') + 'hostNetwork: true'))).toEqual(['Deployment bi sets hostNetwork']);
      expect(k8s(deployment(podSpec('') + 'hostNetwork: false'))).toEqual([]);
      expect(k8s(deployment(podSpec('')))).toEqual([]);
      // matched by label alone, and by image alone
      expect(k8s(deployment('hostNetwork: true\ncontainers:\n  - name: app\n    image: nginx\n'))).toEqual(['Deployment bi sets hostNetwork']);
      expect(k8s(deployment('hostNetwork: true\ncontainers:\n  - name: app\n    image: metabase/metabase\n', 'app: other'))).toEqual(['Deployment bi sets hostNetwork']);
      // another workload may use the host network
      expect(k8s(deployment('hostNetwork: true\ncontainers:\n  - name: app\n    image: nginx\n', 'app: other'))).toEqual([]);
      expect(k8s(`kind: Pod\nmetadata:\n  name: metabase\nspec:\n  hostNetwork: true\n  containers: []\n`)).toEqual(['Pod metabase sets hostNetwork']);
      expect(k8s(`kind: DaemonSet\nmetadata:\n  name: metabase\nspec:\n  template:\n    spec:\n      hostNetwork: true\n`)).toEqual(['DaemonSet metabase sets hostNetwork']);
      expect(k8s(`kind: CronJob\nmetadata:\n  name: metabase-job\nspec:\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          hostNetwork: true\n`))
        .toEqual(['CronJob metabase-job sets hostNetwork']);
    });

    it('flag a Metabase container port that sets hostPort, and accept a containerPort alone', () => {
      expect(k8s(deployment(podSpec('    ports:\n      - containerPort: 3000\n        hostPort: 3002\n'))))
        .toEqual(['Deployment bi publishes hostPort 3002']);
      expect(k8s(deployment('initContainers:\n  - name: init\n    image: metabase/metabase\n    ports:\n      - containerPort: 1\n        hostPort: 8080\n')))
        .toEqual(['Deployment bi publishes hostPort 8080']);
      expect(k8s(deployment(podSpec('    ports:\n      - containerPort: 3000\n'))) ).toEqual([]);
      expect(k8s(deployment(podSpec('    ports:\n      - containerPort: 3000\n        hostPort: 0\n')))).toEqual([]);
      expect(k8s(deployment('containers:\n  - name: app\n    image: nginx\n    ports:\n      - containerPort: 80\n        hostPort: 80\n', 'app: other'))).toEqual([]);
    });

    it('flag externalIPs set on a Metabase pod spec', () => {
      expect(k8s(deployment(podSpec('') + 'externalIPs: [203.0.113.5]'))).toEqual(['Deployment bi sets externalIPs']);
      expect(k8s(deployment(podSpec('')))).toEqual([]);
    });

    it('flag a compose port published on all interfaces or a non-loopback address, and accept loopback', () => {
      expect(compose('      - "${METABASE_PORT:-3002}:3000"\n')).toHaveLength(1);
      expect(compose('      - "3002:3000"\n')).toHaveLength(1);
      expect(compose('      - "0.0.0.0:3002:3000"\n')).toHaveLength(1);
      expect(compose('      - "10.0.0.5:${METABASE_PORT:-3002}:3000"\n')).toHaveLength(1);
      expect(compose('      - "3002:3000/tcp"\n')).toHaveLength(1);
      expect(compose('      - target: 3000\n        published: 3002\n')).toHaveLength(1);
      expect(compose('      - target: 3000\n        published: 3002\n        host_ip: 0.0.0.0\n')).toHaveLength(1);
      expect(compose('      - "127.0.0.1:${METABASE_PORT:-3002}:3000"\n')).toEqual([]);
      expect(compose('      - "[::1]:3002:3000"\n')).toEqual([]);
      expect(compose('      - target: 3000\n        published: 3002\n        host_ip: 127.0.0.1\n')).toEqual([]);
      expect(compose('      - "3000"\n')).toEqual([]);
    });

    it('flag compose network_mode: host on a Metabase service, however the service is named', () => {
      expect(composeOf('  metabase:\n    image: x\n    network_mode: host\n')).toEqual(['metabase: network_mode host']);
      expect(composeOf('  bi:\n    image: metabase/metabase:v0.50\n    network_mode: "host"\n')).toEqual(['bi: network_mode host']);
      expect(composeOf('  metabase:\n    image: x\n    network_mode: bridge\n')).toEqual([]);
      expect(composeOf('  metabase:\n    image: x\n')).toEqual([]);
      expect(composeOf('  api:\n    image: node\n    network_mode: host\n    ports:\n      - "3000:3000"\n')).toEqual([]);
    });

    it('flag a non-loopback port on a compose service that runs the Metabase image under another name', () => {
      expect(composeOf('  bi:\n    image: metabase/metabase:v0.50\n    ports:\n      - "3002:3000"\n')).toEqual(['bi: ports 3002:3000']);
      expect(composeOf('  bi:\n    image: metabase/metabase:v0.50\n    ports:\n      - "127.0.0.1:3002:3000"\n')).toEqual([]);
      expect(composeOf('  api:\n    image: node\n    ports:\n      - "3000:3000"\n')).toEqual([]);
    });
  });
});
