// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-1608 C: the ITIL library writer reads and changes only a CI of the caller's organization.
const mockNodes = new Map<string, Record<string, unknown>>();
jest.mock('@cmdb/database', () => {
  // Matches the stored nodes against the MATCH inline property map ({key: $param, ...}), then applies the itil SET.
  const run = async (query: string, params: Record<string, unknown>) => {
    const pairs = [...(/MATCH \(ci:CI \{([^}]*)\}\)/.exec(query)?.[1] ?? '').matchAll(/(\w+):\s*\$(\w+)/g)];
    const hits = [...mockNodes.values()].filter(node => pairs.every(([, key, param]) => node[key!] === params[param!]));
    if (/SET ci\.itil_attributes = \$itilAttributes/.test(query)) for (const node of hits) node['itil_attributes'] = params['itilAttributes'];
    return { records: hits.map(node => ({ get: () => ({ properties: { ...node } }) })) };
  };
  return { getNeo4jClient: () => ({ getSession: () => ({ run, close: async () => undefined }) }), getPostgresClient: () => ({}) };
});
import { CIRepository } from '../ci-repository';

it('updateITILAttributes leaves a CI of another organization untouched and updates its own', async () => {
  const stage = (lifecycle_stage: string) => JSON.stringify({ lifecycle_stage });
  mockNodes.set('ci-b', { id: 'ci-b', organization_id: 'org-b', name: 'b', itil_attributes: stage('design') });
  mockNodes.set('ci-a', { id: 'ci-a', organization_id: 'org-a', name: 'a', itil_attributes: stage('design') });
  const repository = new CIRepository();
  await expect(repository.updateITILAttributes('ci-b', 'org-a', { lifecycle_stage: 'build' })).rejects.toThrow('CI not found: ci-b');
  expect(mockNodes.get('ci-b')!['itil_attributes']).toBe(stage('design'));
  expect((await repository.updateITILAttributes('ci-a', 'org-a', { lifecycle_stage: 'build' })).itil_attributes)
    .toEqual({ lifecycle_stage: 'build' });
});
