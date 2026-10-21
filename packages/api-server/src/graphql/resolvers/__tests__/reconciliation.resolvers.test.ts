// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant reconciliation mutations remain available; global policy operations
 * refuse every authenticated role before touching persistent state.
 */

import { GraphQLError } from 'graphql';
import type { TokenPayload } from '../../../auth/types';

// jest.config.unit.js sets resetMocks/restoreMocks: true, which strips mock
// implementations set inside a jest.mock() factory before every test runs.
// So the factories below only forward calls to named `mock*` functions, and
// a top-level beforeEach re-arms those functions' return values every test.
const mockQuery = jest.fn();
const mockGetPostgresClient = jest.fn();
const mockReconcileCI = jest.fn();
const mockResolveConflict = jest.fn();
const mockGetIdentityReconciliationEngine = jest.fn();

jest.mock('@cmdb/database', () => ({
  ...jest.requireActual<object>('@cmdb/database/journal/journal'),
  ...jest.requireActual<object>('@cmdb/database/journal/encoding'),
  getPostgresClient: (...args: unknown[]) => mockGetPostgresClient(...args),
}));

jest.mock('@cmdb/identity-resolution', () => ({
  getIdentityReconciliationEngine: (...args: unknown[]) => mockGetIdentityReconciliationEngine(...args),
}));

// reconciliation.resolvers.ts calls getPostgresClient()/getIdentityReconciliationEngine()
// exactly once, at its own module-load time, and every mutation closes over
// those single captured instances -- unlike connector.resolvers.ts, which
// calls getPostgresClient() fresh inside each resolver. So the return values
// must be armed here, before the `import` below triggers that module load,
// not in a beforeEach (which runs after every top-level import has already
// resolved). `mockQuery`/`mockReconcileCI` themselves are still safe to
// reconfigure per-test: the captured `{ query: mockQuery }` object keeps
// referencing the same mock function identity across jest's resetMocks.
mockGetPostgresClient.mockReturnValue({ query: mockQuery });
mockGetIdentityReconciliationEngine.mockReturnValue({ mergeCI: mockReconcileCI, resolveConflict: mockResolveConflict });

// Imported after the mocks above so the module picks up the mocked
// singletons at its own module-load time (`getPostgresClient()` and
// `getIdentityReconciliationEngine()` are both called once, at import).
import { reconciliationResolvers } from '../reconciliation.resolvers';
import type { GraphQLContext } from '../index';

const operatorUser: TokenPayload = {
  _userId: 'op-1',
  _username: 'op-bob',
  _role: 'operator',
  _type: 'access',
  _organizationId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
};

const viewerUser: TokenPayload = {
  _userId: 'viewer-1',
  _username: 'viewer-carol',
  _role: 'viewer',
  _type: 'access',
};

function contextWith(user?: TokenPayload): GraphQLContext {
  return {
    _neo4jClient: {} as any,
    _loaders: {} as any,
    user,
  };
}

async function expectGraphQLErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error('expected promise to reject, but it resolved');
  } catch (error) {
    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).extensions?.['code']).toBe(code);
  }
}

const { mergeCI, resolveConflict, createRule, updateSourceAuthority } = reconciliationResolvers.ReconciliationMutation;
const { getRules, getSourceAuthorities } = reconciliationResolvers.ReconciliationQuery;

describe('mergeCI', () => {
  const args = {
    _name: 'web-01',
    _ciType: 'server',
    _source: 'aws',
    _sourceId: 'i-123',
    _identifiers: {},
  };

  it('rejects unauthenticated requests with UNAUTHENTICATED', async () => {
    await expectGraphQLErrorCode(mergeCI(null, args, contextWith(undefined)), 'UNAUTHENTICATED');
    expect(mockReconcileCI).not.toHaveBeenCalled();
  });

  it('rejects viewers with FORBIDDEN', async () => {
    await expectGraphQLErrorCode(mergeCI(null, args, contextWith(viewerUser)), 'FORBIDDEN');
    expect(mockReconcileCI).not.toHaveBeenCalled();
  });

  it('rejects a writer without a verified organization before touching the engine', async () => {
    await expectGraphQLErrorCode(mergeCI(null, args, contextWith({
      ...operatorUser,
      _organizationId: undefined,
    })), 'FORBIDDEN');
    expect(mockReconcileCI).not.toHaveBeenCalled();
  });

  it('succeeds for an operator and delegates to the reconciliation engine', async () => {
    mockReconcileCI.mockResolvedValue({ ci_id: 'ci-created-1', action: 'updated', correlation_id: 'group-1', conflict_ids: [] });

    const result = await mergeCI(null, args, contextWith(operatorUser));

    expect(mockReconcileCI).toHaveBeenCalled();
    expect(result._success).toBe(true);
    expect(result._ciId).toBe('ci-created-1');
  });

  it('refuses a source the T2 history column cannot hold (256 chars) before the engine', async () => {
    await expectGraphQLErrorCode(mergeCI(null, { ...args, _source: 's'.repeat(256) }, contextWith(operatorUser)), 'BAD_USER_INPUT');
    expect(mockReconcileCI).not.toHaveBeenCalled();
  });
});

describe('resolveConflict', () => {
  const args = { _id: 'conflict-1', _resolution: 'accept_source', _expectedRevision: 'a'.repeat(64) };

  it('rejects unauthenticated requests with UNAUTHENTICATED', async () => {
    await expectGraphQLErrorCode(resolveConflict(null, args, contextWith(undefined)), 'UNAUTHENTICATED');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects viewers with FORBIDDEN', async () => {
    await expectGraphQLErrorCode(resolveConflict(null, args, contextWith(viewerUser)), 'FORBIDDEN');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('succeeds for an operator at the expected revision through the journaled engine resolve', async () => {
    mockResolveConflict.mockResolvedValue({ ci_id: 'ci-1', status: 'resolved', correlation_id: 'group-1' });

    const result = await resolveConflict(null, args, contextWith(operatorUser));

    expect(mockResolveConflict).toHaveBeenCalledWith(operatorUser._organizationId, 'op-1', 'conflict-1', 'accept_source',
      'a'.repeat(64), undefined);
    expect(result).toEqual({ _id: 'conflict-1', _ciId: 'ci-1', _status: 'RESOLVED', _correlationId: 'group-1' });
  });
});

describe('global reconciliation policy', () => {
  const rule = { _input: { _name: 'hostname-match', _identificationRules: [] } };
  const authority = { _input: { _sourceName: 'aws', _authorityScore: 8 } };
  const users = [
    { ...operatorUser, _role: 'viewer' as const },
    operatorUser,
    { ...operatorUser, _role: 'admin' as const, _organizationId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' },
  ];

  it('rejects anonymous policy queries and mutations without DB access', async () => {
    for (const invoke of [
      () => getRules(null, {}, contextWith()),
      () => getSourceAuthorities(null, {}, contextWith()),
      () => createRule(null, rule, contextWith()),
      () => updateSourceAuthority(null, authority, contextWith()),
    ]) await expectGraphQLErrorCode(invoke(), 'UNAUTHENTICATED');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('refuses policy reads and mutations identically for both verified orgs and all roles', async () => {
    for (const user of users) {
      for (const invoke of [
        () => getRules(null, {}, contextWith(user)),
        () => getSourceAuthorities(null, {}, contextWith(user)),
        () => createRule(null, rule, contextWith(user)),
        () => updateSourceAuthority(null, authority, contextWith(user)),
      ]) {
        await expect(invoke()).rejects.toMatchObject({
          message: 'Global reconciliation policy unavailable',
          extensions: { code: 'FORBIDDEN' },
        });
      }
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
