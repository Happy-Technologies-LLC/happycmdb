// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { IdentityReconciliationEngine } from '../../src/engine/identity-reconciliation-engine';
import { startMLEngines } from '../../../ai-ml-engine/src/index';

const query = jest.fn();
const run = jest.fn();
const close = jest.fn();
const emit = jest.fn();
const listeners = new Map<string, (event: Record<string, unknown>) => Promise<void>>();
const createBaseline = jest.fn();
const detectDrift = jest.fn();
jest.mock('@cmdb/common', () => ({ logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }, sanitizeCITypeForLabel: (s: string) => s }));
jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => ({
    getSession: () => ({ run, close }),
    // The journaled merge update (journal internals run in tests/integration) replays its graph write.
    updateCIProperties: async (ciId: string, properties: Record<string, unknown>, organizationId: string) => {
      const result = await run(`MATCH (ci:CI {id: $ciId}) WHERE ci.organization_id = $organizationId
        SET ci += $properties RETURN ci.incarnation_id AS incarnation_id`, { ciId, organizationId, properties });
      return result.records.length ? { incarnation_id: result.records[0].get('incarnation_id') } : null;
    },
  }),
  getPostgresClient: () => ({ query }),
}));
jest.mock('@cmdb/event-processor', () => ({
  getEventProducer: () => ({ emit }),
  createEventConsumer: () => ({
    connect: async () => undefined, subscribe: async () => undefined, run: async () => undefined,
    on: (type: string, handler: (event: Record<string, unknown>) => Promise<void>) => listeners.set(type, handler),
  }),
  EventType: { CI_UPDATED: 'ci.updated', CI_DISCOVERED: 'ci.discovered' },
  KAFKA_TOPICS: { CI_EVENTS: 'ci-events', CI_CHANGES: 'ci-changes' },
  CONSUMER_GROUPS: { ANALYTICS_PROCESSOR: 'analytics' },
}));
jest.mock('../../../ai-ml-engine/src/engines/anomaly-detection-engine', () => ({
  getAnomalyDetectionEngine: () => ({ loadConfiguration: async () => undefined }),
}));
jest.mock('../../../ai-ml-engine/src/engines/configuration-drift-detector', () => ({
  getConfigurationDriftDetector: () => ({ createBaseline, detectDrift }),
}));

const OWN = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const ci = (identifiers: Record<string, unknown>) => ({
  name: 'host', ci_type: 'server', source: 'test', source_id: 'source', identifiers,
  attributes: { status: 'reconciled' }, relationships: [], confidence_score: 100,
});

// The fake database applies the ownership predicate before LIMIT and refuses
// writes unless the stored node still belongs to the caller's organization.
type Node = { id: string; organization_id: string | null; incarnation_id?: string; source_id?: string; last_seen_at?: string; serial_number?: string; uuid?: string; fqdn?: string; mac_addresses?: string[]; hostname?: string; ip_addresses?: string[]; status?: string };
let nodes: Node[];
beforeEach(() => {
  jest.clearAllMocks();
  nodes = [];
  query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('SELECT ci_id FROM ci_source_lineage')) {
      return { rows: nodes.filter(n => n.source_id === params[1])
        .sort((a, b) => (b.last_seen_at ?? '').localeCompare(a.last_seen_at ?? ''))
        .map(n => ({ ci_id: n.id })) };
    }
    return { rows: [] };
  });
  run.mockImplementation(async (cypher: string, params: Record<string, unknown>) => {
    if ('ciIds' in params) {
      const ciIds = params.ciIds as string[];
      // Cypher's unordered MATCH visits insertion order; explicit lineage rank
      // must override it when multiple nodes belong to the same caller.
      const candidates = cypher.includes('ORDER BY rank')
        ? ciIds.map(id => nodes.find(n => n.id === id))
        : nodes;
      const found = candidates.find(n => n && ciIds.includes(n.id) && n.organization_id === params.organizationId);
      return { records: found ? [{ get: () => found.id }] : [] };
    }
    const owned = nodes.filter(n => n.organization_id === params.organizationId);
    let found: Node[] = [];
    if (cypher.includes('ci.serial_number')) found = owned.filter(n => n.serial_number === params.value);
    else if (cypher.includes('ci.uuid')) found = owned.filter(n => n.uuid === params.value);
    else if (cypher.includes('ci.fqdn')) found = owned.filter(n => n.fqdn === params.value);
    else if (cypher.includes('ANY(mac IN ci.mac_addresses')) found = owned.filter(n => n.mac_addresses?.some(m => (params.macs as string[]).includes(m)));
    else if (cypher.includes('ci.hostname CONTAINS')) found = owned.filter(n => n.hostname?.includes(params.hostname as string) || n.ip_addresses?.some(ip => (params.ips as string[]).includes(ip)));
    else if (cypher.includes('id: $ciId')) found = owned.filter(n => n.id === params.ciId);
    if (cypher.includes('SET ci += $properties')) found.forEach(n => {
      Object.assign(n, params.properties);
      n.incarnation_id ??= 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    });
    return { records: found.map(n => ({ get: (key: string) => ({
      ci_id: n.id, incarnation_id: n.incarnation_id, hostname: n.hostname, ips: n.ip_addresses, ci: n,
    }[key as 'ci_id' | 'incarnation_id' | 'hostname' | 'ips' | 'ci']) })) };
  });
});

const cases = [
  ['external ID', { external_id: 'same' }, { source_id: 'same' }],
  ['serial', { serial_number: 'same' }, { serial_number: 'same' }],
  ['UUID', { uuid: 'same' }, { uuid: 'same' }],
  ['MAC', { mac_address: ['same'] }, { mac_addresses: ['same'] }],
  ['FQDN', { fqdn: 'same' }, { fqdn: 'same' }],
  ['composite', { hostname: 'host', ip_address: ['10.0.0.1'] }, { hostname: 'host', ip_addresses: ['10.0.0.1'] }],
] as const;

describe.each(cases)('%s collision', (_name, identifiers, fields) => {
  it.each([OTHER, null])('does not match a %s-owned target', async organization_id => {
    nodes = [{ id: 'target', organization_id, ...fields }];
    const engine = IdentityReconciliationEngine.getInstance();
    expect(await engine.findExistingCI(identifiers, ci(identifiers), OWN)).toBeNull();
    await expect(engine.reconcileCI(ci(identifiers), OWN, false)).resolves.toBeNull();
    expect(run.mock.calls.some(([cypher]) => String(cypher).includes('SET ci += $properties'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO ci_'))).toBe(false);
    expect(nodes[0].status).toBeUndefined();
  });
  it('matches the caller-owned target', async () => {
    nodes = [{ id: 'target', organization_id: OWN, ...fields }];
    const engine = IdentityReconciliationEngine.getInstance();
    expect((await engine.findExistingCI(identifiers, ci(identifiers), OWN))?.ci_id).toBe('target');
  });
});

it('external lineage ignores a newer foreign collision before an owned candidate', async () => {
  nodes = [
    { id: 'foreign', organization_id: OTHER, source_id: 'same' },
    { id: 'owned', organization_id: OWN, source_id: 'same' },
  ];
  const engine = IdentityReconciliationEngine.getInstance();
  expect((await engine.findExistingCI({ external_id: 'same' }, ci({ external_id: 'same' }), OWN))?.ci_id).toBe('owned');
});

it('merges the newest caller-owned external-ID lineage when Neo4j visits the older CI first', async () => {
  nodes = [
    { id: 'older', organization_id: OWN, source_id: 'same', last_seen_at: '2026-10-01T12:00:00Z' },
    { id: 'newer', organization_id: OWN, source_id: 'same', last_seen_at: '2026-10-08T12:00:00Z' },
  ];
  const engine = IdentityReconciliationEngine.getInstance();
  expect(await engine.reconcileCI(ci({ external_id: 'same' }), OWN, false)).toBe('newer');
  expect(nodes[0].status).toBeUndefined();
  expect(nodes[1].status).toBe('reconciled');
});

it('final SET refuses a target that changes owner after identification', async () => {
  nodes = [{ id: 'target', organization_id: OWN, serial_number: 'same' }];
  const engine = IdentityReconciliationEngine.getInstance();
  const originalRun = run.getMockImplementation()!;
  run.mockImplementation(async (cypher: string, params: Record<string, unknown>) => {
    if (cypher.includes('SET ci += $properties')) nodes[0].organization_id = OTHER;
    return originalRun(cypher, params);
  });
  await expect(engine.reconcileCI(ci({ serial_number: 'same' }), OWN, false)).resolves.toBeNull();
  expect(nodes[0].status).toBeUndefined();
  expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO ci_'))).toBe(false);
  expect(emit).not.toHaveBeenCalled();
});

it('publishes the reconciled organization for both updated and discovered CIs', async () => {
  nodes = [{ id: 'target', organization_id: OWN, serial_number: 'same' }];
  const engine = IdentityReconciliationEngine.getInstance();
  await engine.reconcileCI(ci({ serial_number: 'same' }), OWN, false);
  expect(emit).toHaveBeenCalledWith('ci.updated', 'identity-reconciliation-engine',
    expect.objectContaining({ ci_id: 'target', organization_id: OWN }));

  emit.mockClear();
  nodes = [];
  run.mockImplementation(async (cypher: string, params: Record<string, unknown>) => {
    if (cypher.includes('CREATE (ci:CI:')) {
      const properties = params.properties as { id: string; organization_id: string };
      expect(properties.organization_id).toBe(OTHER);
      return { records: [{ get: () => properties.id }] };
    }
    return { records: [] };
  });
  const createdId = await engine.reconcileCI(ci({ serial_number: 'new' }), OTHER);
  expect(emit).toHaveBeenCalledWith('ci.discovered', 'identity-reconciliation-engine',
    expect.objectContaining({ ci_id: createdId, organization_id: OTHER }));
});

it('delivers reconciled tenant provenance to the ML baseline and drift consumers', async () => {
  const interval = jest.spyOn(global, 'setInterval').mockImplementation(() => ({}) as NodeJS.Timeout);
  const sigterm = process.listeners('SIGTERM');
  const sigint = process.listeners('SIGINT');
  try {
    await startMLEngines();
    emit.mockImplementation(async (type: string, _source: string, payload: Record<string, unknown>) => {
      await listeners.get(type)?.(payload);
    });
    createBaseline.mockResolvedValue({});
    detectDrift.mockResolvedValue({ has_drift: false, drift_score: 0 });
    nodes = [{ id: 'target', organization_id: OWN, serial_number: 'same' }];
    const engine = IdentityReconciliationEngine.getInstance();
    await engine.reconcileCI(ci({ serial_number: 'same' }), OWN, false);
    expect(detectDrift).toHaveBeenCalledWith('target', OWN);
    nodes = [];
    run.mockImplementation(async (cypher: string, params: Record<string, unknown>) => {
      if (cypher.includes('CREATE (ci:CI:')) {
        const properties = params.properties as { id: string; organization_id: string };
        return { records: [{ get: () => properties.id }] };
      }
      return { records: [] };
    });
    const id = await engine.reconcileCI(ci({ serial_number: 'new' }), OTHER);
    expect(createBaseline).toHaveBeenCalledWith(id, 'configuration', 'auto-baseline', OTHER);
    await listeners.get('ci.discovered')?.({ ci_id: 'legacy-without-tenant' });
    expect(createBaseline).toHaveBeenCalledTimes(1);
  } finally {
    interval.mockRestore();
    for (const listener of process.listeners('SIGTERM')) if (!sigterm.includes(listener)) process.removeListener('SIGTERM', listener);
    for (const listener of process.listeners('SIGINT')) if (!sigint.includes(listener)) process.removeListener('SIGINT', listener);
    listeners.clear();
  }
});
