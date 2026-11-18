// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-2030: `ReconciliationJournal.run` stamps the observer type of a plan's evidence receipt from the write's explicit
 * `actorType` (a plan without an audit has no other source), and ignores whatever actor type the plan itself carries. The
 * plan is read back from the statement that stores it for T2 and for recovery: that stored plan is what T2 writes the
 * receipt from, on the first attempt and on every sweep replay.
 */
import { JournalActorType, ReconciliationJournal, type StoredPlan } from '../journal';

const stored: unknown[] = [];
class StoredPlanCaptured extends Error {}

jest.mock('../../postgres/audit.service', () => ({ auditChainReady: () => true, appendAuditEntry: jest.fn() }));
jest.mock('../../postgres/client', () => {
  // Answers just enough of the schema gate and T1 for `run` to reach the statement that stores the plan, and stops there.
  const answer = (text: string): { rows: Array<Record<string, unknown>> } => {
    if (text.includes('to_regclass')) return { rows: [{ ready: true }] };
    if (text.includes('RETURNING epoch')) return { rows: [{ epoch: 1 }] };
    if (text.includes('count(*)::int AS n')) return { rows: [{ n: 0 }] };
    return { rows: [] };
  };
  const pool = {
    query: async (text: string, params: unknown[] = []) => {
      if (text.includes('SET plan = $2::jsonb')) {
        stored.push(JSON.parse(params[1] as string));
        throw new StoredPlanCaptured();
      }
      return answer(text);
    },
  };
  const client = { query: async (text: string) => answer(text) };
  return { getPostgresClient: () => ({ pool, transaction: async (work: (c: typeof client) => Promise<unknown>) => work(client) }) };
});

const receipt = (extra: object = {}): NonNullable<StoredPlan['receipt']> => ({
  from: 'ci-a', to: 'ci-b', fromIncarnationId: '11111111-1111-4111-8111-111111111111',
  toIncarnationId: '22222222-2222-4222-8222-222222222222', type: 'USES', evidenceClass: 'static_observed', polarity: 'supports',
  sourceName: 'ai_sync', sourceId: 'c4_releases', sourceVersion: null, method: 'ai_sync', rationaleCode: 'reobserved', ...extra });

async function storedReceipt(actorType: JournalActorType | undefined, plan: StoredPlan): Promise<StoredPlan['receipt']> {
  stored.length = 0;
  const journal = new ReconciliationJournal(async () => [{ present: 1 }]);
  await expect(journal.run({ organizationId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', actor: 'sync:c4_releases',
    ...(actorType ? { actorType } : {}), operation: 'relationship_write', ciIds: ['ci-a', 'ci-b'], plan: async () => plan,
    result: async () => true })).rejects.toBeInstanceOf(StoredPlanCaptured);
  expect(stored).toHaveLength(1);
  return (stored[0] as StoredPlan).receipt;
}

it("a receipt plan without an audit is stored with the write's actor type as its observer type", async () => {
  expect((await storedReceipt('system', { graph: null, receipt: receipt() }))?.observerType).toBe('system');
  expect((await storedReceipt('user', { graph: null, receipt: receipt() }))?.observerType).toBe('user');
});

it('a write that names no actor type is a user: the receipt observer type defaults to user', async () => {
  expect((await storedReceipt(undefined, { graph: null, receipt: receipt() }))?.observerType).toBe('user');
});

it('an actor type the plan itself carries on its receipt or its audit never decides the observer type', async () => {
  const forged = receipt({ observerType: 'system' });
  expect((await storedReceipt('user', { graph: null, receipt: forged }))?.observerType).toBe('user');
  expect((await storedReceipt('system', { graph: null, receipt: receipt({ observerType: 'user' }) }))?.observerType).toBe('system');
  expect((await storedReceipt('user', { graph: null, receipt: receipt(), audit: { action: 'RELATIONSHIP_ADD', actorType: 'system' } }))
    ?.observerType).toBe('user');
});
