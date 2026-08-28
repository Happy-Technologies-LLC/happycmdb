// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Auth coverage for reconciliation.resolvers.ts's ReconciliationMutation:
 * mergeCI, resolveConflict, createRule, and updateSourceAuthority now call
 * checkGraphQLPermission(context, 'write') before touching the reconciliation
 * engine or Postgres -- unauthenticated requests get UNAUTHENTICATED, viewers
 * (read-only role) get FORBIDDEN, and an operator (which carries 'write')
 * succeeds.
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
const mockGetIdentityReconciliationEngine = jest.fn();

jest.mock('@cmdb/database', () => ({
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
mockGetIdentityReconciliationEngine.mockReturnValue({ reconcileCI: mockReconcileCI });

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

  it('succeeds for an operator and delegates to the reconciliation engine', async () => {
    mockReconcileCI.mockResolvedValue('ci-created-1');

    const result = await mergeCI(null, args, contextWith(operatorUser));

    expect(mockReconcileCI).toHaveBeenCalled();
    expect(result._success).toBe(true);
    expect(result._ciId).toBe('ci-created-1');
  });
});

describe('resolveConflict', () => {
  const args = { _id: 'conflict-1', _resolution: 'accept_source' };

  it('rejects unauthenticated requests with UNAUTHENTICATED', async () => {
    await expectGraphQLErrorCode(resolveConflict(null, args, contextWith(undefined)), 'UNAUTHENTICATED');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects viewers with FORBIDDEN', async () => {
    await expectGraphQLErrorCode(resolveConflict(null, args, contextWith(viewerUser)), 'FORBIDDEN');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('succeeds for an operator and updates the conflict row', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            ci_id: 'ci-1',
            conflict_type: 'field_mismatch',
            source_data: {},
            target_data: {},
            conflicting_fields: ['name'],
            created_at: new Date(),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await resolveConflict(null, args, contextWith(operatorUser));

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(result._status).toBe('RESOLVED');
  });
});

describe('createRule', () => {
  const args = {
    _input: {
      _name: 'hostname-match',
      _identificationRules: [
        {
          _attribute: 'hostname',
          _priority: 1,
          _matchType: 'EXACT',
          _matchConfidence: 100,
          _fuzzyThreshold: undefined,
        },
      ],
    },
  };

  it('rejects unauthenticated requests with UNAUTHENTICATED', async () => {
    await expectGraphQLErrorCode(createRule(null, args, contextWith(undefined)), 'UNAUTHENTICATED');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects viewers with FORBIDDEN', async () => {
    await expectGraphQLErrorCode(createRule(null, args, contextWith(viewerUser)), 'FORBIDDEN');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('succeeds for an operator and inserts the rule', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'rule-1',
          name: 'hostname-match',
          identification_rules: [
            { attribute: 'hostname', priority: 1, match_type: 'exact', match_confidence: 100, fuzzy_threshold: undefined },
          ],
          merge_strategies: [],
          enabled: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    });

    const result = await createRule(null, args, contextWith(operatorUser));

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(result._id).toBe('rule-1');
  });
});

describe('updateSourceAuthority', () => {
  const args = { _input: { _sourceName: 'aws', _authorityScore: 8 } };

  it('rejects unauthenticated requests with UNAUTHENTICATED', async () => {
    await expectGraphQLErrorCode(updateSourceAuthority(null, args, contextWith(undefined)), 'UNAUTHENTICATED');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects viewers with FORBIDDEN', async () => {
    await expectGraphQLErrorCode(updateSourceAuthority(null, args, contextWith(viewerUser)), 'FORBIDDEN');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('succeeds for an operator and upserts the source authority row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await updateSourceAuthority(null, args, contextWith(operatorUser));

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(result._authorityScore).toBe(8);
  });
});
