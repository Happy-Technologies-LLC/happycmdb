// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { IdentityReconciliationEngine } from '../../src/engine/identity-reconciliation-engine';

const query = jest.fn();
const run = jest.fn();
const close = jest.fn();
const emit = jest.fn();
jest.mock('@cmdb/common', () => ({ logger: { info: jest.fn(), warn: jest.fn() }, sanitizeCITypeForLabel: (s: string) => s }));
jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => ({ getSession: () => ({ run, close }) }),
  getPostgresClient: () => ({ query }),
}));
jest.mock('@cmdb/event-processor', () => ({ getEventProducer: () => ({ emit }), EventType: { CI_UPDATED: 'updated' } }));

const OWN = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const ci = (identifiers: Record<string, unknown>) => ({
  name: 'host', ci_type: 'server', source: 'test', source_id: 'source', identifiers,
  attributes: { status: 'reconciled' }, relationships: [], confidence_score: 100,
});

// The fake database applies the ownership predicate before LIMIT and refuses
// writes unless the stored node still belongs to the caller's organization.
type Node = { id: string; organization_id: string | null; source_id?: string; serial_number?: string; uuid?: string; fqdn?: string; mac_addresses?: string[]; hostname?: string; ip_addresses?: string[]; status?: string };
let nodes: Node[];
beforeEach(() => {
  jest.clearAllMocks();
  nodes = [];
  query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('SELECT ci_id FROM ci_source_lineage')) {
      return { rows: nodes.filter(n => n.source_id === params[1]).map(n => ({ ci_id: n.id })) };
    }
    return { rows: [] };
  });
  run.mockImplementation(async (cypher: string, params: Record<string, unknown>) => {
    if (cypher.includes('ci.id IN $ciIds')) {
      const found = nodes.find(n => (params.ciIds as string[]).includes(n.id) && n.organization_id === params.organizationId);
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
    if (cypher.includes('SET ci += $properties')) found.forEach(n => Object.assign(n, params.properties));
    return { records: found.map(n => ({ get: (key: string) => ({ ci_id: n.id, hostname: n.hostname, ips: n.ip_addresses, ci: n }[key as 'ci_id' | 'hostname' | 'ips' | 'ci']) })) };
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
