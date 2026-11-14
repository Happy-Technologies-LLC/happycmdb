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

// YAML 1.2 ignores `<<` merge keys unless asked: compose files and manifests use them to share a service body.
const YAML_OPTIONS = { merge: true } as const;
const parseYaml = (text: string): unknown => parse(text, YAML_OPTIONS);

/** Every document of a YAML text, with the messages of those that fail to parse (never silently dropped). */
function parseDocs(text: string): { docs: unknown[]; errors: string[] } {
  const docs: unknown[] = [];
  const errors: string[] = [];
  for (const doc of parseAllDocuments(text, YAML_OPTIONS)) {
    if (doc.errors.length > 0) errors.push(...doc.errors.map((error) => error.message));
    else docs.push(doc.toJS());
  }
  return { docs, errors };
}

/** A Kubernetes backend reference: Ingress `backend.service.name`, HTTPRoute `backendRefs[].name`. */
const backendNames = (backend: unknown): unknown[] =>
  isMap(backend) ? [isMap(backend.service) ? backend.service.name : undefined, backend.name] : [];

const nameOf = (doc: Node): unknown => (isMap(doc.metadata) ? doc.metadata.name : undefined);

const WORKLOAD_KINDS = ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'ReplicationController', 'Job', 'CronJob'];

/** The pod template (`{ metadata, spec }`) of a workload document; a bare Pod is its own template. */
function podTemplate(doc: Node): Node | undefined {
  const spec = isMap(doc.spec) ? doc.spec : {};
  if (doc.kind === 'Pod') return { metadata: doc.metadata, spec };
  const template = doc.kind === 'CronJob' ? (isMap(spec.jobTemplate) && isMap(spec.jobTemplate.spec) ? spec.jobTemplate.spec.template : undefined) : spec.template;
  return isMap(template) ? template : undefined;
}

const containersOf = (podSpec: Node): Node[] => [...list(podSpec.containers), ...list(podSpec.initContainers)].filter(isMap);

/** The pod template of a workload that runs Metabase: a Metabase container image, a Metabase name, or `app: metabase` labels. */
function metabaseTemplate(doc: Node): Node | undefined {
  if (!WORKLOAD_KINDS.includes(String(doc.kind))) return undefined;
  const template = podTemplate(doc);
  if (!template) return undefined;
  const podSpec = isMap(template.spec) ? template.spec : {};
  const labels = isMap(template.metadata) ? template.metadata.labels : undefined;
  const labelled = isMap(labels) && [labels.app, labels['app.kubernetes.io/name']].some(isMetabase);
  return isMetabase(nameOf(doc)) || labelled || containersOf(podSpec).some((c) => isMetabase(c.image)) ? template : undefined;
}

/** What the scan knows about Metabase across all manifests: its pods' label sets and the Services that reach them. */
interface MetabaseContext {
  podLabels: Node[];
  services: Set<string>;
}

/**
 * A Service selects pods when every selector entry appears in the pod's labels; an empty or absent selector selects none.
 * Matching is by label subset, so a Service on `component: analytics` counts however it (or the pods) are named.
 */
const selectsPods = (selector: unknown, podLabels: readonly Node[]): boolean =>
  isMap(selector) && Object.keys(selector).length > 0 &&
  podLabels.some((labels) => Object.entries(selector).every(([key, value]) => Object.hasOwn(labels, key) && String(labels[key]) === String(value)));

/** A Service is Metabase's if its selector is a subset of any Metabase pod's labels, or if it is named like Metabase. */
const isMetabaseService = (doc: Node, podLabels: readonly Node[]): boolean =>
  doc.kind === 'Service' && (isMetabase(nameOf(doc)) || selectsPods(isMap(doc.spec) ? doc.spec.selector : undefined, podLabels));

function metabaseContext(docs: unknown[]): MetabaseContext {
  const podLabels: Node[] = [];
  for (const doc of docs) {
    const template = isMap(doc) ? metabaseTemplate(doc) : undefined;
    if (template && isMap(template.metadata) && isMap(template.metadata.labels)) podLabels.push(template.metadata.labels);
  }
  const services = new Set<string>();
  for (const doc of docs) if (isMap(doc) && isMetabaseService(doc, podLabels)) services.add(String(nameOf(doc)));
  return { podLabels, services };
}

/** Reasons one parsed Kubernetes document exposes Metabase beyond the cluster. */
function k8sExposure(doc: unknown, context: MetabaseContext): string[] {
  if (!isMap(doc) || typeof doc.kind !== 'string') return [];
  const spec = isMap(doc.spec) ? doc.spec : {};
  const name = nameOf(doc);
  const out: string[] = [];
  const isMetabaseBackend = (backend: unknown): boolean => typeof backend === 'string' && (context.services.has(backend) || isMetabase(backend));

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

  // A Service is Metabase's by name or by selector: "bi" selecting the Metabase pods counts, and so does "metabase" selecting anything.
  if (isMetabaseService(doc, context.podLabels)) {
    const type = spec.type ?? 'ClusterIP';
    if (type !== 'ClusterIP') out.push(`Service ${String(name)} is ${String(type)}`);
    if (list(spec.externalIPs).length > 0) out.push(`Service ${String(name)} sets externalIPs`);
  }

  const template = metabaseTemplate(doc);
  if (template) {
    const podSpec = isMap(template.spec) ? template.spec : {};
    const who = `${doc.kind} ${String(name)}`;
    if (podSpec.hostNetwork === true) out.push(`${who} sets hostNetwork`);
    for (const container of containersOf(podSpec)) {
      for (const port of list(container.ports)) {
        if (isMap(port) && Number(port.hostPort) > 0) out.push(`${who} publishes hostPort ${String(port.hostPort)}`);
      }
    }
    if (list(podSpec.externalIPs).length > 0) out.push(`${who} sets externalIPs`);
  }
  return out;
}

const LOOPBACK = /^(127(\.\d{1,3}){3}|localhost|\[::1\])$/;

/** Published ports of one compose service that are bound beyond loopback ("[ip:]host:container[/proto]" or long form). */
function nonLoopbackPorts(service: Node): string[] {
  const out: string[] = [];
  for (const port of list(service.ports)) {
    if (isMap(port)) {
      if (port.published !== undefined && !LOOPBACK.test(String(port.host_ip ?? ''))) out.push(`ports ${JSON.stringify(port)}`);
      continue;
    }
    // ${VAR:-default} interpolation holds colons, so flatten it first.
    const spec = String(port).replace(/\$\{[^}]*\}/g, 'VAR');
    const parts = spec.split(/:(?![^[]*\])/);
    if (parts.length === 1) continue; // container port only: not published
    if (parts.length === 2 || !LOOPBACK.test(parts[0])) out.push(`ports ${String(port)}`);
  }
  return out;
}

/**
 * Reasons a Metabase service of one parsed compose document is reachable beyond loopback: `network_mode: host`, a
 * published port with no loopback host address, or a shared network namespace (`network_mode: service:X` / `container:X`)
 * whose owner or co-tenant publishes beyond loopback or cannot be resolved within the file. A service is Metabase's by
 * name, container name or image, not by name alone.
 */
function composeExposure(doc: unknown): string[] {
  if (!isMap(doc) || !isMap(doc.services)) return [];
  const services = Object.entries(doc.services).filter((entry): entry is [string, Node] => isMap(entry[1]));
  const sharedRef = (service: Node) => {
    const match = /^(service|container):(.+)$/.exec(String(service.network_mode ?? '').trim());
    return match ? { kind: match[1], target: match[2].trim() } : undefined;
  };
  const resolve = (ref: { kind: string; target: string }) =>
    services.find(([id, service]) => (ref.kind === 'service' ? id === ref.target : service.container_name === ref.target));
  /** The service whose network namespace `start` lives in (itself when it shares none), or the unresolved reference. */
  const namespaceOwner = (start: [string, Node]): { owner: [string, Node] } | { unresolved: string } => {
    const seen = new Set([start[0]]);
    let current = start;
    for (;;) {
      const ref = sharedRef(current[1]);
      if (!ref) return { owner: current };
      const next = resolve(ref);
      if (!next) return { unresolved: `${ref.kind}:${ref.target}` };
      if (seen.has(next[0])) return { owner: next };
      seen.add(next[0]);
      current = next;
    }
  };
  const keyOf = (entry: [string, Node]): string => {
    const ns = namespaceOwner(entry);
    return 'owner' in ns ? `owner:${ns.owner[0]}` : `unresolved:${ns.unresolved}`;
  };

  const out: string[] = [];
  for (const entry of services) {
    const [id, service] = entry;
    if (!(isMetabase(id) || isMetabase(service.image) || isMetabase(service.container_name))) continue;
    if (String(service.network_mode ?? '').trim() === 'host') out.push(`${id}: network_mode host`);
    for (const port of nonLoopbackPorts(service)) out.push(`${id}: ${port}`);

    if (!sharedRef(service)) continue;
    const ns = namespaceOwner(entry);
    if ('unresolved' in ns) {
      out.push(`${id}: network_mode ${ns.unresolved} targets a service or container outside this file`);
      continue;
    }
    if (String(ns.owner[1].network_mode ?? '').trim() === 'host') out.push(`${id}: shares the host network via ${ns.owner[0]}`);
    const key = keyOf(entry);
    for (const member of services) {
      if (member[0] === id || keyOf(member) !== key) continue;
      for (const port of nonLoopbackPorts(member[1])) out.push(`${id}: shares a network namespace with ${member[0]}: ${port}`);
    }
  }
  // A service that joins the namespace of Metabase publishes Metabase's listener too.
  for (const entry of services) {
    const [id, service] = entry;
    if (isMetabase(id) || isMetabase(service.image) || isMetabase(service.container_name) || !sharedRef(service)) continue;
    const ns = namespaceOwner(entry);
    if (!('owner' in ns)) continue;
    const [ownerId, owner] = ns.owner;
    if (!(isMetabase(ownerId) || isMetabase(owner.image) || isMetabase(owner.container_name))) continue;
    for (const port of nonLoopbackPorts(service)) out.push(`${id}: publishes Metabase's network namespace (${ownerId}): ${port}`);
  }
  return out;
}

const tracked = (...globs: string[]): string[] =>
  execFileSync('git', ['ls-files', '-z', '--', ...globs], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);

const PARSE_ERRORS: string[] = [];
const docsOf = (file: string): unknown[] => {
  const { docs, errors } = parseDocs(readFileSync(join(REPO, file), 'utf8'));
  PARSE_ERRORS.push(...errors.map((error) => `${file}: ${error}`));
  return docs;
};

const YAML_FILES = tracked(':(glob)**/*.yml', ':(glob)**/*.yaml').filter((file) => !file.startsWith('node_modules/'));
const COMPOSE_FILES = YAML_FILES.filter((file) => /compose/i.test(file));
const METABASE_MANIFEST = 'infrastructure/kubernetes/deployments/metabase-deployment.yaml';

const K8S_DOCS = YAML_FILES.flatMap((file) => docsOf(file).map((doc) => ({ file, doc })));
const METABASE_CONTEXT = metabaseContext(K8S_DOCS.map(({ doc }) => doc));

describe('Metabase is internal-only (staff and operator tool)', () => {
  it('parses every tracked YAML document: an unparsable one fails here instead of being skipped', () => {
    expect(PARSE_ERRORS).toEqual([]);
    expect(parseDocs('a: 1\n---\nb: [unclosed\n').errors).toHaveLength(1);
    expect(parseDocs('a: 1\n---\nb: 2\n')).toEqual({ docs: [{ a: 1 }, { b: 2 }], errors: [] });
  });

  it('finds the Metabase manifest, its Service and the shipped compose file, so the checks cannot go vacuous', () => {
    expect(YAML_FILES).toEqual(expect.arrayContaining([METABASE_MANIFEST, 'infrastructure/docker/docker-compose.yml']));
    const kinds = docsOf(METABASE_MANIFEST).filter(isMap).map((doc) => doc.kind);
    expect(kinds).toEqual(expect.arrayContaining(['Deployment', 'Service']));
    expect(METABASE_CONTEXT.services.has('metabase')).toBe(true);
    expect(METABASE_CONTEXT.podLabels.length).toBeGreaterThan(0);
    const workloads = docsOf(METABASE_MANIFEST).filter((doc) => isMap(doc) && WORKLOAD_KINDS.includes(String(doc.kind)));
    expect(workloads.length).toBeGreaterThan(0);
    const compose = parseYaml(readFileSync(join(REPO, 'infrastructure/docker/docker-compose.yml'), 'utf8')) as { services: Record<string, Node> };
    expect(list(compose.services.metabase.ports)).not.toHaveLength(0);
  });

  it('no tracked Kubernetes manifest routes to Metabase, publishes it on the host, or exposes its Service beyond ClusterIP', () => {
    const exposure = K8S_DOCS.flatMap(({ file, doc }) => k8sExposure(doc, METABASE_CONTEXT).map((reason) => `${file}: ${reason}`));
    expect(exposure).toEqual([]);
  });

  it('no tracked compose file publishes Metabase on a non-loopback interface or on the host network', () => {
    const exposure = COMPOSE_FILES.flatMap((file) =>
      docsOf(file).flatMap((doc) => composeExposure(doc)).map((reason) => `${file}: ${reason}`));
    expect(exposure).toEqual([]);
  });

  describe('detectors', () => {
    const composeOf = (body: string) => composeExposure(parseYaml(`services:\n${body}`));
    const compose = (ports: string) => composeOf(`  metabase:\n    image: x\n    ports:\n${ports}`);
    const podSpec = (body: string) => `containers:\n  - name: app\n    image: metabase/metabase:v0.50\n${body}`;
    const deployment = (spec: string, labels = 'app: metabase') =>
      `kind: Deployment\nmetadata:\n  name: bi\nspec:\n  template:\n    metadata:\n      labels:\n        ${labels.replace(/\n/g, '\n        ')}\n    spec:\n${spec.replace(/^/gm, '      ')}\n`;
    // The shipped manifest labels its pods both `app: metabase` and `component: analytics`.
    const METABASE_PODS = deployment(podSpec(''), 'app: metabase\ncomponent: analytics');
    const service = (name: string, selector: string, spec = '') =>
      `kind: Service\nmetadata:\n  name: ${name}\nspec:\n${selector ? `  selector:\n    ${selector}\n` : ''}${spec}`;
    /** Exposure of the first document, given the other manifests of the scan. */
    const k8s = (text: string, ...others: string[]) => {
      const docs = [text, ...others].map(parseYaml);
      return k8sExposure(docs[0], metabaseContext(docs));
    };

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
      const ingressTo = (backend: string) => `kind: Ingress\nmetadata:\n  name: edge\nspec:\n  defaultBackend:\n    service:\n      name: ${backend}\n`;
      const routeTo = (backend: string) => `kind: HTTPRoute\nmetadata:\n  name: r\nspec:\n  rules:\n    - backendRefs:\n        - name: ${backend}\n`;
      const bi = service('bi', 'component: analytics'); // selects the Metabase pods through a label that does not say "metabase"
      const docs = service('docs', 'app: docs');
      expect(k8s(ingressTo('bi'), METABASE_PODS, bi)).toEqual(['Ingress edge']);
      expect(k8s(routeTo('bi'), METABASE_PODS, bi)).toEqual(['HTTPRoute r']);
      // a Service of other pods, or a Service whose Metabase pods are not in the scan, is not Metabase's
      expect(k8s(ingressTo('docs'), METABASE_PODS, docs)).toEqual([]);
      expect(k8s(routeTo('docs'), METABASE_PODS, docs)).toEqual([]);
      expect(k8s(ingressTo('bi'), bi)).toEqual([]);
      expect(k8s(routeTo('bi'))).toEqual([]);
    });

    it('collect the Services that reach Metabase pods by label subset or by name', () => {
      const docs = [
        METABASE_PODS,
        service('analytics', 'component: analytics'),
        service('both', '{app: metabase, component: analytics}'),
        service('narrower', '{component: analytics, tier: web}'), // asks for a label the pods lack
        service('metabase-docs', 'app: docs'), // by name
        service('docs', 'app: docs'),
        service('headless', ''),
      ].map(parseYaml);
      expect([...metabaseContext(docs).services].sort()).toEqual(['analytics', 'both', 'metabase-docs']);
      // pod labels come from any workload on a Metabase image, whatever its own name and labels
      const byImage = deployment(podSpec(''), 'tier: bi').replace('name: bi', 'name: reports');
      expect(metabaseContext([parseYaml(byImage), parseYaml(service('reports', 'tier: bi'))]).services.has('reports')).toBe(true);
      expect(metabaseContext([parseYaml(deployment('containers:\n  - name: app\n    image: nginx\n', 'tier: web')), parseYaml(service('web', 'tier: web'))]).services.size).toBe(0);
    });

    it('flag a Service that selects Metabase pods, or is named like Metabase, when it is not ClusterIP or sets externalIPs', () => {
      // selector `app: metabase`, and `component: analytics` (the shipped pods carry both)
      expect(k8s(service('bi', 'app: metabase', '  type: LoadBalancer\n'), METABASE_PODS)).toEqual(['Service bi is LoadBalancer']);
      expect(k8s(service('bi', 'app: metabase', '  type: NodePort\n'), METABASE_PODS)).toEqual(['Service bi is NodePort']);
      expect(k8s(service('bi', 'component: analytics', '  type: LoadBalancer\n'), METABASE_PODS)).toEqual(['Service bi is LoadBalancer']);
      expect(k8s(service('metabase', 'component: analytics', '  type: LoadBalancer\n'), METABASE_PODS)).toEqual(['Service metabase is LoadBalancer']);
      expect(k8s(service('bi', 'component: analytics', '  externalIPs: [203.0.113.5]\n'), METABASE_PODS)).toEqual(['Service bi sets externalIPs']);
      expect(k8s(service('bi', 'app.kubernetes.io/name: metabase', '  externalIPs: [203.0.113.5]\n'), deployment(podSpec(''), 'app.kubernetes.io/name: metabase')))
        .toEqual(['Service bi sets externalIPs']);
      // by name, whatever the selector (or none)
      expect(k8s(service('metabase', 'app: docs', '  type: LoadBalancer\n'))).toEqual(['Service metabase is LoadBalancer']);
      expect(k8s(service('metabase', 'app: docs', '  type: NodePort\n'), METABASE_PODS)).toEqual(['Service metabase is NodePort']);
      expect(k8s(service('metabase', '', '  type: NodePort\n'))).toEqual(['Service metabase is NodePort']);
      expect(k8s(service('metabase', '', '  externalIPs: [203.0.113.5]\n'))).toEqual(['Service metabase sets externalIPs']);
      // ClusterIP is internal
      expect(k8s(service('bi', 'component: analytics', '  type: ClusterIP\n'), METABASE_PODS)).toEqual([]);
      expect(k8s(service('bi', 'component: analytics'), METABASE_PODS)).toEqual([]);
      expect(k8s(service('metabase', ''))).toEqual([]);
    });

    it('do not flag an unrelated Service, nor one that selects pods outside Metabase', () => {
      expect(k8s(service('api', 'app: api', '  type: LoadBalancer\n  externalIPs: [203.0.113.5]\n'), METABASE_PODS)).toEqual([]);
      expect(k8s(service('docs', 'app: docs', '  type: NodePort\n'), METABASE_PODS)).toEqual([]);
      expect(k8s(service('api', '{component: analytics, tier: web}', '  type: LoadBalancer\n'), METABASE_PODS)).toEqual([]);
      expect(k8s(service('headless', '', '  type: LoadBalancer\n'), METABASE_PODS)).toEqual([]);
      // no Metabase pod in the scan: `component: analytics` alone says nothing
      expect(k8s(service('bi', 'component: analytics', '  type: LoadBalancer\n'))).toEqual([]);
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

    it('flag a Metabase service that joins another container\'s network namespace when that one publishes beyond loopback', () => {
      const mb = (mode: string) => `  metabase:\n    image: metabase/metabase\n    network_mode: ${mode}\n`;
      const edge = (ports: string, extra = '') => `  edge:\n    image: nginx\n${extra}    ports:\n      - "${ports}"\n`;
      expect(composeOf(mb('"service:edge"') + edge('8080:3000'))).toEqual(['metabase: shares a network namespace with edge: ports 8080:3000']);
      expect(composeOf(mb('"container:edge-c"') + edge('0.0.0.0:8080:3000', '    container_name: edge-c\n')))
        .toEqual(['metabase: shares a network namespace with edge: ports 0.0.0.0:8080:3000']);
      expect(composeOf(mb('"service:edge"') + edge('127.0.0.1:8080:3000'))).toEqual([]);
      expect(composeOf(mb('"service:edge"') + '  edge:\n    image: nginx\n')).toEqual([]);
      // the owner itself on the host network, and a chain through an intermediate service
      expect(composeOf(mb('"service:edge"') + '  edge:\n    image: nginx\n    network_mode: host\n')).toEqual(['metabase: shares the host network via edge']);
      expect(composeOf(mb('"service:mid"') + '  mid:\n    image: x\n    network_mode: "service:edge"\n' + edge('8080:3000')))
        .toEqual(['metabase: shares a network namespace with edge: ports 8080:3000']);
      // a target outside this file cannot be shown loopback-only
      expect(composeOf(mb('"service:ghost"'))).toEqual(['metabase: network_mode service:ghost targets a service or container outside this file']);
      expect(composeOf(mb('"container:other-stack"'))).toEqual(['metabase: network_mode container:other-stack targets a service or container outside this file']);
    });

    it('flag a service that publishes beyond loopback from the network namespace of Metabase', () => {
      const metabase = '  metabase:\n    image: metabase/metabase\n    container_name: mb\n';
      const sidecar = (mode: string, ports: string) => `  proxy:\n    image: nginx\n    network_mode: ${mode}\n    ports:\n      - "${ports}"\n`;
      expect(composeOf(metabase + sidecar('"service:metabase"', '8080:3000'))).toEqual(['proxy: publishes Metabase\'s network namespace (metabase): ports 8080:3000']);
      expect(composeOf(metabase + sidecar('"container:mb"', '8080:3000'))).toEqual(['proxy: publishes Metabase\'s network namespace (metabase): ports 8080:3000']);
      expect(composeOf(metabase + sidecar('"service:metabase"', '127.0.0.1:8080:3000'))).toEqual([]);
      expect(composeOf('  other:\n    image: node\n' + sidecar('"service:other"', '8080:3000'))).toEqual([]);
    });

    it('read `<<` merge keys, so a Metabase service built from an anchor is still seen', () => {
      const text = 'x-bi: &bi\n  image: metabase/metabase\n  ports:\n    - "3002:3000"\nservices:\n  reports:\n    <<: *bi\n  safe:\n    <<: *bi\n    ports:\n      - "127.0.0.1:3002:3000"\n';
      expect(composeExposure(parseYaml(text))).toEqual(['reports: ports 3002:3000']);
      const manifest = 'kind: Service\nmetadata:\n  name: bi\nbase: &base\n  selector:\n    component: analytics\nspec:\n  <<: *base\n  type: LoadBalancer\n';
      expect(k8s(manifest, METABASE_PODS)).toEqual(['Service bi is LoadBalancer']);
    });
  });
});
