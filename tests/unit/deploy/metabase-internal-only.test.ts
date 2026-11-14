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

/** Reasons one parsed Kubernetes document exposes Metabase beyond the cluster. */
function k8sExposure(doc: unknown): string[] {
  if (!isMap(doc) || typeof doc.kind !== 'string') return [];
  const spec = isMap(doc.spec) ? doc.spec : {};
  const name = isMap(doc.metadata) ? doc.metadata.name : undefined;
  const out: string[] = [];

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
    if (isMetabase(name) || hosts.some(isMetabase) || backends.some(isMetabase)) out.push(`Ingress ${String(name)}`);
  }

  if (doc.kind === 'HTTPRoute') {
    const refs = list(spec.rules).flatMap((rule) => (isMap(rule) ? list(rule.backendRefs).flatMap(backendNames) : []));
    if (isMetabase(name) || refs.some(isMetabase) || list(spec.hostnames).some(isMetabase)) out.push(`HTTPRoute ${String(name)}`);
  }

  if (doc.kind === 'Service' && isMetabase(name)) {
    const type = spec.type ?? 'ClusterIP';
    if (type !== 'ClusterIP') out.push(`Service ${String(name)} is ${String(type)}`);
    if (list(spec.externalIPs).length > 0) out.push(`Service ${String(name)} sets externalIPs`);
  }
  return out;
}

const LOOPBACK = /^(127(\.\d{1,3}){3}|localhost|\[::1\])$/;

/** Reasons the `metabase` service of one parsed compose document publishes a port beyond loopback. */
function composeExposure(doc: unknown): string[] {
  const service = isMap(doc) && isMap(doc.services) ? doc.services.metabase : undefined;
  if (!isMap(service)) return [];
  const out: string[] = [];
  for (const port of list(service.ports)) {
    if (isMap(port)) {
      if (port.published !== undefined && !LOOPBACK.test(String(port.host_ip ?? ''))) out.push(`ports ${JSON.stringify(port)}`);
      continue;
    }
    // "[ip:]host:container[/proto]"; ${VAR:-default} interpolation holds colons, so flatten it first.
    const spec = String(port).replace(/\$\{[^}]*\}/g, 'VAR');
    const parts = spec.split(/:(?![^[]*\])/);
    if (parts.length === 1) continue; // container port only: not published
    if (parts.length === 2 || !LOOPBACK.test(parts[0])) out.push(`ports ${String(port)}`);
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

describe('Metabase is internal-only (staff and operator tool)', () => {
  it('finds the Metabase manifest, its Service and the shipped compose file, so the checks cannot go vacuous', () => {
    expect(YAML_FILES).toEqual(expect.arrayContaining([METABASE_MANIFEST, 'infrastructure/docker/docker-compose.yml']));
    const kinds = docsOf(METABASE_MANIFEST).filter(isMap).map((doc) => doc.kind);
    expect(kinds).toEqual(expect.arrayContaining(['Deployment', 'Service']));
    const compose = parse(readFileSync(join(REPO, 'infrastructure/docker/docker-compose.yml'), 'utf8'));
    expect(list((compose.services.metabase as Node).ports)).not.toHaveLength(0);
  });

  it('no tracked Kubernetes manifest routes to Metabase through an Ingress or HTTPRoute, and its Service is ClusterIP', () => {
    const exposure = YAML_FILES.flatMap((file) => docsOf(file).flatMap(k8sExposure).map((reason) => `${file}: ${reason}`));
    expect(exposure).toEqual([]);
  });

  it('no tracked compose file publishes Metabase on a non-loopback interface', () => {
    const exposure = COMPOSE_FILES.flatMap((file) =>
      composeExposure(parse(readFileSync(join(REPO, file), 'utf8'))).map((reason) => `${file}: ${reason}`));
    expect(exposure).toEqual([]);
  });

  describe('detectors', () => {
    const k8s = (text: string) => k8sExposure(parse(text));
    const compose = (ports: string) => composeExposure(parse(`services:\n  metabase:\n    image: x\n    ports:\n${ports}`));

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

    it('flag a Metabase Service that is not ClusterIP, and ignore other Ingresses and Services', () => {
      expect(k8s('kind: Service\nmetadata:\n  name: metabase\nspec:\n  type: LoadBalancer\n')).toEqual(['Service metabase is LoadBalancer']);
      expect(k8s('kind: Service\nmetadata:\n  name: metabase\nspec:\n  externalIPs: [203.0.113.5]\n')).toEqual(['Service metabase sets externalIPs']);
      expect(k8s('kind: Service\nmetadata:\n  name: metabase\nspec:\n  type: ClusterIP\n')).toEqual([]);
      expect(k8s('kind: Service\nmetadata:\n  name: api\nspec:\n  type: LoadBalancer\n')).toEqual([]);
      expect(k8s('kind: Ingress\nmetadata:\n  name: api\nspec:\n  rules:\n    - host: api.example.io\n')).toEqual([]);
    });

    it('flag a compose port published on all interfaces or a non-loopback address, and accept loopback', () => {
      expect(compose('      - "${METABASE_PORT:-3002}:3000"\n')).toHaveLength(1);
      expect(compose('      - "3002:3000"\n')).toHaveLength(1);
      expect(compose('      - "0.0.0.0:3002:3000"\n')).toHaveLength(1);
      expect(compose('      - "10.0.0.5:${METABASE_PORT:-3002}:3000"\n')).toHaveLength(1);
      expect(compose('      - target: 3000\n        published: 3002\n')).toHaveLength(1);
      expect(compose('      - "127.0.0.1:${METABASE_PORT:-3002}:3000"\n')).toEqual([]);
      expect(compose('      - "[::1]:3002:3000"\n')).toEqual([]);
      expect(compose('      - target: 3000\n        published: 3002\n        host_ip: 127.0.0.1\n')).toEqual([]);
      expect(compose('      - "3000"\n')).toEqual([]);
    });
  });
});
