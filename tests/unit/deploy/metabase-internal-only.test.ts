/**
 * cm-fu-bi-tenant-scope (cmdb#318 review, operator decision): Metabase is an INTERNAL staff and operator tool. Its BI
 * views contain every organization's rows and Metabase cannot restrict a user to one tenant, so no shipped manifest
 * may publish it: no Ingress / HTTPRoute routes to it, its Service is ClusterIP, and every compose file that publishes
 * its port binds loopback only. Compose files are scanned alone and as merged sets (a sibling `*.override.yml`, every
 * `-f` chain named in tracked scripts and docs), and `include:` fails closed unless it resolves to a tracked file.
 *
 * Every tracked YAML file is parsed (not grepped). The detectors also run against inline fixtures that DO publish
 * Metabase, so a detector that stopped seeing them (renamed key, new spelling) fails here instead of passing vacuously.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, posix, resolve } from 'path';
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

/** YAML 1.1 booleans: Kubernetes decodes `yes`, `on` and `y` as true for a bool field, as does `True`. */
const isYamlTrue = (value: unknown): boolean => value === true || (typeof value === 'string' && /^(true|yes|on|y)$/i.test(value.trim()));

/** The `items` of a `kind: List` (or typed list such as `ServiceList`), or undefined for any other document. */
const listItems = (doc: Node): unknown[] | undefined =>
  typeof doc.kind === 'string' && doc.kind.endsWith('List') && Array.isArray(doc.items) ? doc.items : undefined;

/** The documents with every List replaced by its items, however deeply nested. */
const flattenLists = (docs: readonly unknown[]): unknown[] =>
  docs.flatMap((doc) => (isMap(doc) && listItems(doc) ? flattenLists(listItems(doc) as unknown[]) : [doc]));

const ROUTE_KINDS = ['HTTPRoute', 'GRPCRoute', 'TCPRoute', 'TLSRoute', 'UDPRoute'];

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

/**
 * An ExternalName Service whose `externalName` is the cluster DNS name of a Service in `services`:
 * `<svc>`, `<svc>.<ns>`, `<svc>.<ns>.svc` or `<svc>.<ns>.svc.<cluster domain>`.
 */
function aliasesMetabase(doc: Node, services: ReadonlySet<string>): boolean {
  const spec = isMap(doc.spec) ? doc.spec : {};
  if (doc.kind !== 'Service' || spec.type !== 'ExternalName' || typeof spec.externalName !== 'string') return false;
  const labels = spec.externalName.trim().toLowerCase().replace(/\.$/, '').split('.');
  return services.has(labels[0]) && (labels.length <= 2 || labels[2] === 'svc');
}

/**
 * The Service names that reach Metabase: by label subset or by name, plus every ExternalName Service whose target is
 * one of them (an alias of an alias included), since a route to the alias reaches Metabase.
 */
function metabaseContext(rawDocs: unknown[]): MetabaseContext {
  const docs = flattenLists(rawDocs);
  const podLabels: Node[] = [];
  for (const doc of docs) {
    const template = isMap(doc) ? metabaseTemplate(doc) : undefined;
    if (template && isMap(template.metadata) && isMap(template.metadata.labels)) podLabels.push(template.metadata.labels);
  }
  const services = new Set<string>();
  for (const doc of docs) if (isMap(doc) && isMetabaseService(doc, podLabels)) services.add(String(nameOf(doc)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const doc of docs) {
      if (isMap(doc) && aliasesMetabase(doc, services) && !services.has(String(nameOf(doc)))) {
        services.add(String(nameOf(doc)));
        grew = true;
      }
    }
  }
  return { podLabels, services };
}

/** Reasons one parsed Kubernetes document exposes Metabase beyond the cluster; the items of a List are scanned one by one. */
function k8sExposure(doc: unknown, context: MetabaseContext): string[] {
  if (isMap(doc) && listItems(doc)) return flattenLists([doc]).flatMap((item) => k8sExposure(item, context));
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

  if (ROUTE_KINDS.includes(doc.kind)) {
    const refs = list(spec.rules).flatMap((rule) => (isMap(rule) ? list(rule.backendRefs).flatMap(backendNames) : []));
    if (isMetabase(name) || refs.some(isMetabaseBackend) || list(spec.hostnames).some(isMetabase)) out.push(`${doc.kind} ${String(name)}`);
  }

  // OpenShift Route: `to` and `alternateBackends` are Service references, `host` is the public name.
  if (doc.kind === 'Route') {
    const refs = [...backendNames(spec.to), ...list(spec.alternateBackends).flatMap(backendNames)];
    if (isMetabase(name) || isMetabase(spec.host) || refs.some(isMetabaseBackend)) out.push(`Route ${String(name)}`);
  }

  // A Service is Metabase's by name or by selector: "bi" selecting the Metabase pods counts, and so does "metabase" selecting anything.
  if (isMetabaseService(doc, context.podLabels)) {
    const type = spec.type ?? 'ClusterIP';
    if (type !== 'ClusterIP') out.push(`Service ${String(name)} is ${String(type)}`);
    if (list(spec.externalIPs).length > 0) out.push(`Service ${String(name)} sets externalIPs`);
  } else if (aliasesMetabase(doc, context.services)) {
    out.push(`Service ${String(name)} is an ExternalName alias of Metabase (${String(spec.externalName)})`);
  }

  const template = metabaseTemplate(doc);
  if (template) {
    const podSpec = isMap(template.spec) ? template.spec : {};
    const who = `${doc.kind} ${String(name)}`;
    if (isYamlTrue(podSpec.hostNetwork)) out.push(`${who} sets hostNetwork`);
    for (const container of containersOf(podSpec)) {
      for (const port of list(container.ports)) {
        if (isMap(port) && Number(port.hostPort) > 0) out.push(`${who} publishes hostPort ${String(port.hostPort)}`);
      }
    }
    if (list(podSpec.externalIPs).length > 0) out.push(`${who} sets externalIPs`);
  }
  return out;
}

const LOOPBACK = /^(127(\.\d{1,3}){3}|localhost|\[?::1\]?)$/;

/**
 * Published ports of one compose service that are bound beyond loopback. Short form is "[ip:][host:]container[/proto]":
 * a port with no host part ("3000", 3000, "3000/tcp") is published on a random host port on every interface, so only
 * "ip::container" with a loopback ip is internal. Long form is `{ target, published?, host_ip? }`: with no `host_ip`
 * the port is on every interface, whether or not `published` is set.
 */
function nonLoopbackPorts(service: Node): string[] {
  const out: string[] = [];
  for (const port of list(service.ports)) {
    if (isMap(port)) {
      if (!LOOPBACK.test(String(port.host_ip ?? ''))) out.push(`ports ${JSON.stringify(port)}`);
      continue;
    }
    // ${VAR:-default} interpolation holds colons, so flatten it first.
    const spec = String(port).replace(/\$\{[^}]*\}/g, 'VAR');
    const parts = spec.split(/:(?![^[]*\])/);
    if (parts.length <= 2 || !LOOPBACK.test(parts[0])) out.push(`ports ${String(port)}`);
  }
  return out;
}

/** Compose `extends` merge: sequences concatenate, mappings merge key by key, scalars override. */
function mergeService(base: Node, own: Node): Node {
  const out: Node = { ...base };
  for (const [key, value] of Object.entries(own)) {
    const inherited = out[key];
    if (Array.isArray(inherited) && Array.isArray(value)) out[key] = [...inherited, ...value];
    else if (isMap(inherited) && isMap(value)) out[key] = { ...inherited, ...value };
    else out[key] = value;
  }
  return out;
}

/**
 * Each service with its same-file `extends` chain merged in (`extends: base` or `extends: { service }`). One that names
 * another file, a service this file lacks, or a cycle is left unmerged and reported: its real shape is unknown.
 */
function resolveExtends(entries: [string, Node][]): { services: [string, Node][]; problems: string[] } {
  const byId = new Map(entries);
  const resolved = new Map<string, Node>();
  const problems: string[] = [];
  const resolveOne = (id: string, trail: readonly string[]): Node => {
    const cached = resolved.get(id);
    if (cached) return cached;
    const own = byId.get(id) as Node;
    let effective = own;
    if (own.extends !== undefined) {
      const target = typeof own.extends === 'string' ? { service: own.extends } : isMap(own.extends) ? own.extends : {};
      const targetId = typeof target.service === 'string' ? target.service : undefined;
      if (target.file !== undefined) problems.push(`${id}: extends ${String(targetId)} from ${String(target.file)}, which this scan does not read`);
      else if (targetId === undefined || !byId.has(targetId)) problems.push(`${id}: extends ${String(targetId)}, which is not a service of this file`);
      else if (targetId === id || trail.includes(targetId)) problems.push(`${id}: extends ${targetId}, which is a cycle`);
      else effective = mergeService(resolveOne(targetId, [...trail, id]), own);
    }
    resolved.set(id, effective);
    return effective;
  };
  return { services: entries.map(([id]) => [id, resolveOne(id, [])]), problems };
}

/**
 * Reasons a Metabase service of one parsed compose document is reachable beyond loopback: `network_mode: host`, an
 * attached network that is the external network named `host` (Compose v2 host networking; a service with no `networks`
 * is on `default`), a published port with no loopback host address, or a shared network namespace
 * (`network_mode: service:X` / `container:X`) whose owner or co-tenant publishes beyond loopback or cannot be resolved
 * within the file. A service is Metabase's by name, container name or image, not by name alone, after `extends` is
 * resolved within the file; an `extends` that names another file, a missing service or a cycle cannot be resolved and
 * is reported for the service that carries it. A document is one file or a merged set of files (`composeSetExposure`).
 */
function composeExposure(doc: unknown): string[] {
  if (!isMap(doc) || !isMap(doc.services)) return [];
  const { services, problems: extendsProblems } = resolveExtends(Object.entries(doc.services).filter((entry): entry is [string, Node] => isMap(entry[1])));
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
  const networks = isMap(doc.networks) ? doc.networks : {};
  /** Compose v2 host networking: a network that is external and named `host` (its name defaults to its key). */
  const isHostNetwork = (key: string): boolean => {
    const def = networks[key];
    if (!isMap(def)) return false;
    const legacy = isMap(def.external) ? def.external : undefined;
    if (!(legacy || isYamlTrue(def.external))) return false;
    const name = typeof def.name === 'string' ? def.name : typeof legacy?.name === 'string' ? legacy.name : key;
    return name.trim() === 'host';
  };
  /** The key of an attached network that is the host network: any one, as `priority` can promote a later one to primary. */
  const hostNetwork = (service: Node): string | undefined => {
    if (service.network_mode !== undefined) return undefined;
    const declared = Array.isArray(service.networks) ? service.networks.filter((key): key is string => typeof key === 'string') : isMap(service.networks) ? Object.keys(service.networks) : [];
    return (declared.length > 0 ? declared : ['default']).find(isHostNetwork);
  };

  const out: string[] = [];
  for (const entry of services) {
    const [id, service] = entry;
    if (!(isMetabase(id) || isMetabase(service.image) || isMetabase(service.container_name))) continue;
    const viaNetwork = hostNetwork(service);
    if (String(service.network_mode ?? '').trim() === 'host') out.push(`${id}: network_mode host`);
    if (viaNetwork) out.push(`${id}: network ${viaNetwork} is the external host network`);
    for (const port of nonLoopbackPorts(service)) out.push(`${id}: ${port}`);

    if (!sharedRef(service)) continue;
    const ns = namespaceOwner(entry);
    if ('unresolved' in ns) {
      out.push(`${id}: network_mode ${ns.unresolved} targets a service or container outside this file`);
      continue;
    }
    if (hostNetwork(ns.owner[1]) || String(ns.owner[1].network_mode ?? '').trim() === 'host') out.push(`${id}: shares the host network via ${ns.owner[0]}`);
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
  return [...extendsProblems, ...out];
}

/** Compose multi-file merge of top-level elements: same-named entries merge like `extends` (see `mergeService`), anything else is replaced. */
function mergeCompose(docs: readonly Node[]): Node {
  const out: Node = {};
  for (const doc of docs) {
    for (const [key, value] of Object.entries(doc)) {
      const inherited = out[key];
      if (!(isMap(inherited) && isMap(value))) {
        out[key] = value;
        continue;
      }
      const entries: Node = { ...inherited };
      for (const [name, entry] of Object.entries(value)) entries[name] = isMap(entries[name]) && isMap(entry) ? mergeService(entries[name] as Node, entry) : entry;
      out[key] = entries;
    }
  }
  return out;
}

/** Reads one repo-relative (posix) compose file: its first mapping document, or undefined when it is not an in-repo file. */
type ComposeLoader = (file: string) => Node | undefined;

const REMOTE_INCLUDE = /^([a-z][a-z0-9+.-]*:|git@)/i;

/** The paths of one `include:` entry: `path`, `{ path }` or `{ path: [..] }` (a list is one merged project). */
function includePaths(entry: unknown): string[] | undefined {
  const raw = isMap(entry) ? entry.path : entry;
  const paths = Array.isArray(raw) ? raw : [raw];
  return paths.length > 0 && paths.every((path) => typeof path === 'string' && path.trim() !== '') ? (paths as string[]).map((path) => path.trim()) : undefined;
}

/**
 * One compose file with its `include:` entries merged in beneath it. `include:` is fail-closed: an entry is read only
 * when it is a literal path to a file the loader has in the repo; an interpolated, remote, out-of-repo or missing path
 * cannot be scanned, so it is reported rather than assumed harmless.
 */
function loadComposeFile(file: string, load: ComposeLoader, trail: readonly string[]): { doc: Node; problems: string[] } {
  const own = load(file);
  if (!own) return { doc: {}, problems: [`${file}: not a readable in-repo compose file`] };
  const problems: string[] = [];
  const included: Node[] = [];
  for (const entry of list(own.include)) {
    const paths = includePaths(entry);
    if (!paths) {
      problems.push(`${file}: include entry ${JSON.stringify(entry)} names no path`);
      continue;
    }
    for (const path of paths) {
      const target = posix.normalize(posix.join(posix.dirname(file), path));
      if (/\$/.test(path) || REMOTE_INCLUDE.test(path) || posix.isAbsolute(path) || target === '..' || target.startsWith('../')) {
        problems.push(`${file}: include ${path} is interpolated, remote or outside the repo, so this scan cannot read it`);
      } else if (trail.includes(target)) {
        problems.push(`${file}: include ${path} is a cycle`);
      } else {
        const nested = loadComposeFile(target, load, [...trail, target]);
        included.push(nested.doc);
        problems.push(...nested.problems.map((problem) => (problem.startsWith(`${target}: not a readable`) ? `${file}: include ${path} is not an in-repo compose file` : problem)));
      }
    }
  }
  const { include: _include, ...rest } = own;
  return { doc: mergeCompose([...included, rest]), problems };
}

/** Exposure of a set of compose files merged in `-f` order (an override can add a port or image to a service of the base). */
function composeSetExposure(files: readonly string[], load: ComposeLoader): string[] {
  const loaded = files.map((file) => loadComposeFile(file, load, [file]));
  return [...new Set([...loaded.flatMap(({ problems }) => problems), ...composeExposure(mergeCompose(loaded.map(({ doc }) => doc)))])];
}

const COMPOSE_NAME = /^(.*\/)?([^/]*compose[^/]*?)\.(ya?ml)$/i;

/** The compose files named by `-f` / `--file` in each compose command of a script or doc, per command, in order. */
function composeChains(text: string): string[][] {
  return text
    .replace(/\\\r?\n\s*/g, ' ')
    .split(/\r?\n/)
    .flatMap((line) => line.split(/&&|\|\||[;|]/))
    .filter((command) => /\bcompose\b/i.test(command))
    .map((command) => [...command.matchAll(/(?:^|\s)(?:-f|--file)(?:\s+|=)["']?([^\s"'<>|;&`$]+\.ya?ml)/g)].map((match) => posix.normalize(match[1])))
    .filter((chain) => chain.length > 0);
}

/**
 * The merged sets to scan: every compose file alone; each compose file with its sibling `<name>.override.<ext>` (what
 * `docker compose` loads on its own for `docker-compose.yml`); and every `-f` chain of `chains` whose files are all tracked.
 */
function composeSets(files: readonly string[], chains: readonly (readonly string[])[]): string[][] {
  const known = new Set(files);
  const sets = new Map<string, string[]>();
  const add = (set: string[]) => sets.set(set.join('\0'), set);
  for (const file of files) {
    if (!/compose/i.test(file)) continue;
    add([file]);
    const match = COMPOSE_NAME.exec(file);
    const override = match && `${match[1] ?? ''}${match[2]}.override.${match[3]}`;
    if (override && known.has(override)) add([file, override]);
  }
  for (const chain of chains) if (chain.every((file) => known.has(file))) add([...chain]);
  return [...sets.values()];
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

/** The first mapping document of a tracked YAML file; anything else is not an in-repo compose file for `include:`. */
const loadTracked: ComposeLoader = (file) => (YAML_FILES.includes(file) ? docsOf(file).find(isMap) : undefined);

// Compose files named by `-f` in tracked scripts and docs (this test's own fixtures excluded).
const SELF = 'tests/unit/deploy/metabase-internal-only.test.ts';
const CHAIN_FILES = execFileSync('git', ['grep', '-lIz', '-E', '(-f|--file)[ =]+["\']?[^ ]+\\.ya?ml', '--', '.', `:(exclude)${SELF}`], { cwd: REPO, encoding: 'utf8' })
  .split('\0').filter(Boolean);
const SCRIPT_CHAINS = CHAIN_FILES.flatMap((file) => composeChains(readFileSync(join(REPO, file), 'utf8')));
const COMPOSE_SETS = composeSets(YAML_FILES, SCRIPT_CHAINS);

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

  it('no tracked compose file, merged set of files or include chain publishes Metabase on a non-loopback interface or on the host network', () => {
    const exposure = COMPOSE_SETS.flatMap((set) => composeSetExposure(set, loadTracked).map((reason) => `${set.join(' + ')}: ${reason}`));
    expect(exposure).toEqual([]);
  });

  it('scans every tracked compose file alone and each -f chain or sibling override as a merged set, so the set scan cannot go vacuous', () => {
    expect(COMPOSE_SETS).toEqual(expect.arrayContaining(COMPOSE_FILES.map((file) => [file])));
    expect(SCRIPT_CHAINS).toContainEqual(['infrastructure/docker/docker-compose.yml']);
    expect(composeExposure(parseYaml(readFileSync(join(REPO, 'infrastructure/docker/docker-compose.yml'), 'utf8')))).toEqual([]);
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
      expect(compose('      - "3000"\n')).toHaveLength(1);
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

    it('flag a compose port with no host part: Compose publishes it on a random host port on every interface', () => {
      for (const port of ['"3000"', '3000', '"3000/tcp"', '"3000-3002"', '"${METABASE_PORT:-3000}"']) {
        expect(compose(`      - ${port}\n`)).toHaveLength(1);
      }
      expect(composeOf('  bi:\n    image: metabase/metabase\n    ports:\n      - 3000\n')).toEqual(['bi: ports 3000']);
      // a bare container port pinned to loopback (random host port on 127.0.0.1) stays internal
      expect(compose('      - "127.0.0.1::3000"\n')).toEqual([]);
      expect(compose('      - "[::1]::3000/tcp"\n')).toEqual([]);
      expect(compose('      - "0.0.0.0::3000"\n')).toHaveLength(1);
    });

    it('flag a long-form compose port unless host_ip pins it to loopback, whether or not it names a published port', () => {
      expect(compose('      - target: 3000\n')).toHaveLength(1);
      expect(compose('      - target: 3000\n        protocol: tcp\n')).toHaveLength(1);
      expect(compose('      - target: 3000\n        published: "3002"\n')).toHaveLength(1);
      expect(compose('      - target: 3000\n        host_ip: 0.0.0.0\n')).toHaveLength(1);
      expect(compose('      - target: 3000\n        host_ip: 10.0.0.5\n')).toHaveLength(1);
      expect(compose('      - target: 3000\n        host_ip: 127.0.0.1\n')).toEqual([]);
      expect(compose('      - target: 3000\n        host_ip: "::1"\n')).toEqual([]);
      expect(compose('      - target: 3000\n        published: 3002\n        host_ip: "::1"\n')).toEqual([]);
    });

    it('treat a bare container port on a service that shares a namespace with Metabase as published', () => {
      const mb = '  metabase:\n    image: metabase/metabase\n    network_mode: "service:edge"\n';
      expect(composeOf(mb + '  edge:\n    image: nginx\n    ports:\n      - 3000\n')).toEqual(['metabase: shares a network namespace with edge: ports 3000']);
    });

    it('read every YAML 1.1 truthy spelling of hostNetwork, and no falsy one', () => {
      for (const value of ['true', 'True', 'TRUE', 'yes', 'Yes', 'YES', 'on', 'On', 'ON', 'y', '"yes"', '"true"']) {
        expect(k8s(deployment(podSpec('') + `hostNetwork: ${value}`))).toEqual(['Deployment bi sets hostNetwork']);
      }
      for (const value of ['false', 'False', 'no', 'off', 'n', '"false"', 'null']) {
        expect(k8s(deployment(podSpec('') + `hostNetwork: ${value}`))).toEqual([]);
      }
      expect(k8s(`kind: Pod\nmetadata:\n  name: metabase\nspec:\n  hostNetwork: yes\n  containers: []\n`)).toEqual(['Pod metabase sets hostNetwork']);
    });

    describe('kind: List', () => {
      const listOf = (...items: string[]) =>
        `kind: List\nitems:\n${items.map((item) => item.trimEnd().replace(/^/gm, '    ').replace(/^ {4}/, '  - ')).join('\n')}\n`;

      it('scan the items of a List, and of Lists nested in it', () => {
        const bi = service('bi', 'component: analytics', '  type: LoadBalancer\n');
        expect(k8s(listOf(METABASE_PODS, bi))).toEqual(['Service bi is LoadBalancer']);
        expect(k8s(listOf(listOf(METABASE_PODS, bi)))).toEqual(['Service bi is LoadBalancer']);
        expect(k8s(listOf(deployment(podSpec('') + 'hostNetwork: yes')))).toEqual(['Deployment bi sets hostNetwork']);
        expect(k8s('kind: ServiceList\nitems:\n  - kind: Service\n    metadata:\n      name: metabase\n    spec:\n      type: NodePort\n')).toEqual(['Service metabase is NodePort']);
      });

      it('resolve a Service defined in a List for a route outside it, and a route inside a List', () => {
        const edge = 'kind: Ingress\nmetadata:\n  name: edge\nspec:\n  defaultBackend:\n    service:\n      name: bi\n';
        expect(k8s(edge, listOf(METABASE_PODS, service('bi', 'component: analytics')))).toEqual(['Ingress edge']);
        expect(k8s(listOf(edge), METABASE_PODS, service('bi', 'component: analytics'))).toEqual(['Ingress edge']);
      });

      it('flag nothing for a List of unrelated resources', () => {
        expect(k8s(listOf(service('api', 'app: api', '  type: LoadBalancer\n'), service('docs', 'app: docs')), METABASE_PODS)).toEqual([]);
        expect(k8s('kind: List\nitems: []\n')).toEqual([]);
      });
    });

    describe('ExternalName Services', () => {
      const external = (name: string, target: string) => service(name, '', `  type: ExternalName\n  externalName: ${target}\n`);
      const metabaseSvc = service('metabase', 'app: metabase');
      const flagged = (name: string, target: string) => [`Service ${name} is an ExternalName alias of Metabase (${target})`];

      it('flag one whose externalName is the DNS name of a Metabase Service', () => {
        for (const target of ['metabase', 'metabase.data', 'metabase.data.svc', 'metabase.data.svc.cluster.local', 'metabase.data.svc.cluster.local.', 'Metabase.data.svc']) {
          expect(k8s(external('reports', target), METABASE_PODS, metabaseSvc)).toEqual(flagged('reports', target));
        }
        // a Metabase Service reached through a label selector, whatever its name
        expect(k8s(external('reports', 'bi.data.svc.cluster.local'), METABASE_PODS, service('bi', 'component: analytics'))).toEqual(flagged('reports', 'bi.data.svc.cluster.local'));
      });

      it('flag an alias of an alias, and the Ingress or route that backs onto it', () => {
        const first = external('reports', 'metabase.data.svc');
        const second = external('dash', 'reports.data.svc');
        expect(k8s(second, first, metabaseSvc)).toEqual(flagged('dash', 'reports.data.svc'));
        const ingress = 'kind: Ingress\nmetadata:\n  name: edge\nspec:\n  defaultBackend:\n    service:\n      name: dash\n';
        expect(k8s(ingress, second, first, metabaseSvc)).toEqual(['Ingress edge']);
        expect(k8s('kind: TCPRoute\nmetadata:\n  name: r\nspec:\n  rules:\n    - backendRefs:\n        - name: reports\n', first, metabaseSvc)).toEqual(['TCPRoute r']);
      });

      it('do not flag one that targets another Service or an external host, and flag a Metabase-named one however it points', () => {
        for (const target of ['docs.data.svc.cluster.local', 'metabase.example.com', 'api.example.com', 'docs']) {
          expect(k8s(external('reports', target), METABASE_PODS, metabaseSvc)).toEqual([]);
        }
        expect(k8s(external('reports', 'metabase.data.svc'), METABASE_PODS)).toEqual([]); // no Metabase Service in the scan
        expect(k8s(external('metabase', 'api.example.com'))).toEqual(['Service metabase is ExternalName']);
        const ingress = 'kind: Ingress\nmetadata:\n  name: edge\nspec:\n  defaultBackend:\n    service:\n      name: reports\n';
        expect(k8s(ingress, external('reports', 'docs.data.svc'), METABASE_PODS, metabaseSvc)).toEqual([]);
      });
    });

    it('flag an OpenShift Route to Metabase by host, name, `to` or `alternateBackends`, and not one to another Service', () => {
      const route = (spec: string, name = 'r') => `kind: Route\nmetadata:\n  name: ${name}\nspec:\n${spec}`;
      const bi = service('bi', 'component: analytics');
      const docs = service('docs', 'app: docs');
      expect(k8s(route('  to:\n    kind: Service\n    name: bi\n'), METABASE_PODS, bi)).toEqual(['Route r']);
      expect(k8s(route('  to:\n    kind: Service\n    name: metabase\n'))).toEqual(['Route r']);
      expect(k8s(route('  to:\n    name: docs\n  alternateBackends:\n    - name: bi\n      weight: 10\n'), METABASE_PODS, bi, docs)).toEqual(['Route r']);
      expect(k8s(route('  host: metabase.apps.example.io\n  to:\n    name: docs\n'), docs)).toEqual(['Route r']);
      expect(k8s(route('  to:\n    name: docs\n', 'metabase'), docs)).toEqual(['Route metabase']);
      expect(k8s(route('  host: api.apps.example.io\n  to:\n    name: docs\n'), METABASE_PODS, bi, docs)).toEqual([]);
      expect(k8s(route('  to:\n    name: bi\n'), bi)).toEqual([]); // `bi` selects pods that are not Metabase's in this scan
    });

    it('flag Gateway API TCPRoute, TLSRoute, GRPCRoute and UDPRoute backends like an HTTPRoute', () => {
      const route = (kind: string, backend: string, extra = '') => `kind: ${kind}\nmetadata:\n  name: r\nspec:\n${extra}  rules:\n    - backendRefs:\n        - name: ${backend}\n`;
      const bi = service('bi', 'component: analytics');
      const docs = service('docs', 'app: docs');
      for (const kind of ['HTTPRoute', 'TCPRoute', 'TLSRoute', 'GRPCRoute', 'UDPRoute']) {
        expect(k8s(route(kind, 'bi'), METABASE_PODS, bi)).toEqual([`${kind} r`]);
        expect(k8s(route(kind, 'metabase'))).toEqual([`${kind} r`]);
        expect(k8s(route(kind, 'docs'), METABASE_PODS, bi, docs)).toEqual([]);
      }
      expect(k8s(route('TLSRoute', 'docs', '  hostnames: [metabase.example.io]\n'), docs)).toEqual(['TLSRoute r']);
      expect(k8s('kind: GRPCRoute\nmetadata:\n  name: metabase\nspec: {}\n')).toEqual(['GRPCRoute metabase']);
    });

    describe('compose extends', () => {
      const base = '  base:\n    image: metabase/metabase\n    ports:\n      - "127.0.0.1:3000:3000"\n';
      const extending = (name: string, extend: string, rest = '') => `  ${name}:\n    extends:\n${extend}${rest}`;

      it('merge the base service under the extending one, so an inherited image, port or host network is seen', () => {
        // inherits the Metabase image and adds a public port
        expect(composeOf(base + extending('reports', '      service: base\n', '    ports:\n      - "3002:3000"\n'))).toEqual(['reports: ports 3002:3000']);
        // short form, and a chain through an intermediate service
        expect(composeOf(base + extending('mid', '      service: base\n') + extending('reports', '      service: mid\n', '    ports:\n      - "3002:3000"\n')))
          .toEqual(['reports: ports 3002:3000']);
        expect(composeOf(base + '  reports:\n    extends: base\n    ports:\n      - 3002\n')).toEqual(['reports: ports 3002']);
        // inherits the public port of the base
        expect(composeOf('  base:\n    image: metabase/metabase\n    ports:\n      - "3002:3000"\n' + extending('reports', '      service: base\n')))
          .toEqual(['base: ports 3002:3000', 'reports: ports 3002:3000']);
        // a Metabase service that extends a non-Metabase base with a public port
        expect(composeOf('  edge:\n    image: nginx\n    ports:\n      - "3002:3000"\n' + extending('reports', '      service: edge\n', '    image: metabase/metabase\n')))
          .toEqual(['reports: ports 3002:3000']);
        // host network inherited, and overridden by the extending service
        expect(composeOf('  base:\n    image: metabase/metabase\n    network_mode: host\n' + extending('reports', '      service: base\n')))
          .toEqual(['base: network_mode host', 'reports: network_mode host']);
        expect(composeOf('  base:\n    image: metabase/metabase\n    network_mode: host\n' + extending('reports', '      service: base\n', '    network_mode: bridge\n')))
          .toEqual(['base: network_mode host']);
      });

      it('flag nothing for services that extend a non-Metabase base, or a Metabase base that is loopback-only', () => {
        expect(composeOf('  edge:\n    image: nginx\n    ports:\n      - "3002:3000"\n' + extending('web', '      service: edge\n'))).toEqual([]);
        expect(composeOf(base + extending('reports', '      service: base\n', '    ports:\n      - "127.0.0.1:3002:3000"\n'))).toEqual([]);
      });

      it('fail closed on an extends that names another file, a missing service, or a cycle', () => {
        expect(composeOf(extending('reports', '      file: common.yml\n      service: metabase\n')))
          .toEqual(['reports: extends metabase from common.yml, which this scan does not read']);
        expect(composeOf(extending('reports', '      service: ghost\n'))).toEqual(['reports: extends ghost, which is not a service of this file']);
        expect(composeOf('  reports:\n    extends: ghost\n')).toEqual(['reports: extends ghost, which is not a service of this file']);
        expect(composeOf(extending('a', '      service: b\n') + extending('b', '      service: a\n'))).toEqual(['b: extends a, which is a cycle']);
        expect(composeOf(extending('a', '      service: a\n'))).toEqual(['a: extends a, which is a cycle']);
      });
    });

    describe('compose host networking through an external network named host', () => {
      const hostNet = (extra = '') => `networks:\n  hostnet:\n    external: true\n    name: host\n${extra}`;
      const exposure = (text: string) => composeExposure(parseYaml(text));

      it('flag a Metabase service whose networks list or map attaches an external network named host', () => {
        const listForm = `services:\n  bi:\n    image: metabase/metabase\n    networks:\n      - hostnet\n${hostNet()}`;
        const mapForm = `services:\n  bi:\n    image: metabase/metabase\n    networks:\n      hostnet:\n        priority: 5\n${hostNet()}`;
        expect(exposure(listForm)).toEqual(['bi: network hostnet is the external host network']);
        expect(exposure(mapForm)).toEqual(['bi: network hostnet is the external host network']);
        // the name defaults to the key; the legacy `external: { name }` spelling; any attached network, not only the first
        expect(exposure('services:\n  metabase:\n    image: x\n    networks: [host]\nnetworks:\n  host:\n    external: true\n')).toEqual(['metabase: network host is the external host network']);
        expect(exposure('services:\n  metabase:\n    image: x\n    networks: [hostnet]\nnetworks:\n  hostnet:\n    external:\n      name: host\n')).toHaveLength(1);
        expect(exposure(`services:\n  bi:\n    image: metabase/metabase\n    networks: [back, hostnet]\nnetworks:\n  back: {}\n${hostNet().replace('networks:\n', '')}`)).toHaveLength(1);
      });

      it('flag a Metabase service with no networks when the top-level default network is the external host network', () => {
        const withDefault = (service: string) => `services:\n  bi:\n    image: metabase/metabase\n${service}networks:\n  default:\n    external: true\n    name: host\n`;
        expect(exposure(withDefault(''))).toEqual(['bi: network default is the external host network']);
        // an explicit network list replaces the default, and network_mode wins over networks altogether
        expect(exposure(withDefault('    networks: [back]\n'))).toEqual([]);
        expect(exposure(withDefault('    network_mode: bridge\n'))).toEqual([]);
      });

      it('flag a Metabase service in the namespace of a host-network service, and nothing for other networks', () => {
        expect(exposure(`services:\n  edge:\n    image: nginx\n    networks: [hostnet]\n  metabase:\n    image: metabase/metabase\n    network_mode: service:edge\n${hostNet()}`))
          .toEqual(['metabase: shares the host network via edge']);
        expect(exposure(`services:\n  metabase:\n    image: metabase/metabase\n    network_mode: service:edge\n  edge:\n    image: nginx\n    networks: [hostnet]\n${hostNet()}`))
          .toEqual(['metabase: shares the host network via edge']);
        // not external, a different external name, and a host-named network that is not external
        expect(exposure('services:\n  metabase:\n    image: x\n    networks: [hostnet]\nnetworks:\n  hostnet:\n    external: true\n    name: shared\n')).toEqual([]);
        expect(exposure('services:\n  metabase:\n    image: x\n    networks: [host]\nnetworks:\n  host:\n    driver: bridge\n')).toEqual([]);
        expect(exposure('services:\n  metabase:\n    image: x\n    networks: [back]\nnetworks:\n  back: {}\n')).toEqual([]);
        // a non-Metabase service on the host network is out of scope
        expect(exposure(`services:\n  api:\n    image: node\n    networks: [hostnet]\n${hostNet()}`)).toEqual([]);
      });
    });

    describe('compose files scanned as merged sets', () => {
      /** A set of in-memory files: the loader serves the first mapping document of each. */
      const setOf = (files: Record<string, string>, ...order: string[]) =>
        composeSetExposure(order, (file) => (file in files ? (parseYaml(files[file]) as Node) : undefined));
      const base = 'services:\n  bi:\n    image: metabase/metabase:v0.50\n    ports:\n      - "127.0.0.1:3002:3000"\n';

      it('flag an override that adds a public port to a service that runs the Metabase image under another name', () => {
        const files = { 'docker-compose.yml': base, 'docker-compose.override.yml': 'services:\n  bi:\n    ports:\n      - "3002:3000"\n' };
        expect(setOf(files, 'docker-compose.yml')).toEqual([]);
        // alone the override names no image and no Metabase-like name: only the merge identifies the service
        expect(setOf(files, 'docker-compose.override.yml')).toEqual([]);
        expect(setOf(files, 'docker-compose.yml', 'docker-compose.override.yml')).toEqual(['bi: ports 3002:3000']);
      });

      it('flag an override that switches a Metabase-image service to host networking, or attaches the external host network', () => {
        const files = {
          'a.yml': base,
          'host.yml': 'services:\n  bi:\n    network_mode: host\n',
          'net.yml': 'services:\n  bi:\n    networks: [hostnet]\nnetworks:\n  hostnet:\n    external: true\n    name: host\n',
        };
        expect(setOf(files, 'a.yml', 'host.yml')).toEqual(['bi: network_mode host']);
        expect(setOf(files, 'a.yml', 'net.yml')).toEqual(['bi: network hostnet is the external host network']);
      });

      it('flag a base with a public port when an override only supplies the Metabase image, and honor the -f order', () => {
        const files = { 'a.yml': 'services:\n  bi:\n    image: nginx\n    ports:\n      - "8080:3000"\n', 'b.yml': 'services:\n  bi:\n    image: metabase/metabase\n' };
        expect(setOf(files, 'a.yml', 'b.yml')).toEqual(['bi: ports 8080:3000']);
        expect(setOf(files, 'a.yml')).toEqual([]);
        // the later file wins for a scalar: image goes back to nginx
        expect(setOf(files, 'b.yml', 'a.yml')).toEqual([]);
      });

      it('report a set file that cannot be read instead of skipping it', () => {
        expect(setOf({ 'a.yml': base }, 'a.yml', 'missing.yml')).toEqual(['missing.yml: not a readable in-repo compose file']);
      });

      it('pair each compose file with its sibling override and every -f chain that names tracked files', () => {
        const files = ['docker-compose.yml', 'docker-compose.override.yml', 'infra/compose.yaml', 'infra/compose.override.yaml', 'deploy/b.compose.yml', 'deploy/ci.yml', 'plain.yml'];
        const sets = composeSets(files, [['deploy/b.compose.yml', 'deploy/ci.yml'], ['docker-compose.prod.yml'], ['deploy/ci.yml', 'ghost.yml']]);
        expect(sets).toEqual([
          ['docker-compose.yml'],
          ['docker-compose.yml', 'docker-compose.override.yml'],
          ['docker-compose.override.yml'],
          ['infra/compose.yaml'],
          ['infra/compose.yaml', 'infra/compose.override.yaml'],
          ['infra/compose.override.yaml'],
          ['deploy/b.compose.yml'],
          ['deploy/b.compose.yml', 'deploy/ci.yml'],
        ]);
      });

      it('read the -f chains of a script or doc: continuations, quotes, --file, several commands per line, and not other tools', () => {
        const text = [
          'docker compose -f a.yml \\',
          '  -f "b.override.yml" up -d',
          'docker-compose --file=c.yml --file d.yml ps',
          '`docker compose -p <project> -f deploy/x.compose.yml -f <generation override> exec api`',
          'docker compose -f e.yml down && docker compose -f f.yml -f g.yml up',
          'kubectl apply -f manifest.yaml',
          'docker compose -f "$FILE" up',
        ].join('\n');
        expect(composeChains(text)).toEqual([['a.yml', 'b.override.yml'], ['c.yml', 'd.yml'], ['deploy/x.compose.yml'], ['e.yml'], ['f.yml', 'g.yml']]);
      });

      describe('include:', () => {
        const withInclude = (include: string) => `include:\n${include}services:\n  api:\n    image: node\n`;
        const exposed = 'services:\n  bi:\n    image: metabase/metabase\n    ports:\n      - "3002:3000"\n';

        it('fail closed on an include that is remote, interpolated, outside the repo, missing, or has no path', () => {
          const problems = (include: string) => setOf({ 'deploy/c.yml': withInclude(include) }, 'deploy/c.yml');
          expect(problems('  - oci://registry.example.io/stack:1\n')).toEqual(['deploy/c.yml: include oci://registry.example.io/stack:1 is interpolated, remote or outside the repo, so this scan cannot read it']);
          expect(problems('  - https://example.io/bi.yml\n')).toHaveLength(1);
          expect(problems('  - ${BI_STACK}/bi.yml\n')).toHaveLength(1);
          expect(problems('  - ../../../etc/bi.yml\n')).toHaveLength(1);
          expect(problems('  - /srv/bi.yml\n')).toHaveLength(1);
          expect(problems('  - ghost.yml\n')).toEqual(['deploy/c.yml: include ghost.yml is not an in-repo compose file']);
          expect(problems('  - env_file: x.env\n')).toHaveLength(1);
        });

        it('read an include that resolves in-repo, relative to the including file, and flag what it publishes', () => {
          const files = { 'deploy/c.yml': withInclude('  - path: ../shared/bi.yml\n'), 'shared/bi.yml': exposed };
          expect(setOf(files, 'deploy/c.yml')).toEqual(['bi: ports 3002:3000']);
          expect(setOf({ ...files, 'shared/bi.yml': base }, 'deploy/c.yml')).toEqual([]);
          // a path list is one project; an include of an include is followed
          expect(setOf({ 'deploy/c.yml': withInclude('  - path: [../shared/ok.yml, ../shared/bi.yml]\n'), 'shared/ok.yml': 'services: {}\n', 'shared/bi.yml': exposed }, 'deploy/c.yml'))
            .toEqual(['bi: ports 3002:3000']);
          expect(setOf({ ...files, 'shared/bi.yml': `include:\n  - ghost.yml\n${base}` }, 'deploy/c.yml')).toEqual(['shared/bi.yml: include ghost.yml is not an in-repo compose file']);
        });

        it('see a service of an included file that an override of the including file gives a public port', () => {
          const files = { 'c.yml': withInclude('  - bi.yml\n'), 'bi.yml': base, 'o.yml': 'services:\n  bi:\n    ports:\n      - "3002:3000"\n' };
          expect(setOf(files, 'c.yml')).toEqual([]);
          expect(setOf(files, 'c.yml', 'o.yml')).toEqual(['bi: ports 3002:3000']);
        });

        it('report an include cycle', () => {
          expect(setOf({ 'a.yml': 'include:\n  - b.yml\n', 'b.yml': 'include:\n  - a.yml\n' }, 'a.yml')).toEqual(['b.yml: include a.yml is a cycle']);
        });
      });
    });
  });
});
