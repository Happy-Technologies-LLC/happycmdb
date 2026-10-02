// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Auth and tenant coverage for reconciliation.resolvers.ts:
 * - mergeCI fails closed (FORBIDDEN) after the 'write' check, before any
 *   engine or database access;
 * - findMatches and resolveConflict act on the caller's organization only;
 * - createRule and updateSourceAuthority (global configuration) need 'admin';
 * - unauthenticated requests get UNAUTHENTICATED, viewers FORBIDDEN.
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
const mockFindExistingCI = jest.fn();
const mockOrganizationCIIds = jest.fn();
const mockGetIdentityReconciliationEngine = jest.fn();

jest.mock('@cmdb/database', () => ({
  getPostgresClient: (...args: unknown[]) => mockGetPostgresClient(...args),
}));

jest.mock('@cmdb/identity-resolution', () => ({
  getIdentityReconciliationEngine: (...args: unknown[]) => mockGetIdentityReconciliationEngine(...args),
}));

// reconciliation.resolvers.ts calls getPostgresClient()/getIdentityReconciliationEngine()
// once at its own module-load time, so the return values must be armed before
// the `import` below. services/reconciliation-scope.ts calls them per request,
// so beforeEach re-arms them after jest's resetMocks.
function armClients(): void {
  mockGetPostgresClient.mockReturnValue({ query: mockQuery });
  mockGetIdentityReconciliationEngine.mockReturnValue({
    reconcileCI: mockReconcileCI,
    findExistingCI: mockFindExistingCI,
    organizationCIIds: mockOrganizationCIIds,
  });
}
armClients();

import { reconciliationResolvers } from '../reconciliation.resolvers';
import type { GraphQLContext } from '../index';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONFLICT_ID = 'aaaaaaaa-1111-4111-8111-000000000001';

const adminUser: TokenPayload = {
  _userId: 'admin-1',
  _username: 'admin-ann',
  _role: 'admin',
  _type: 'access',
  _organizationId: ORG,
};

const operatorUser: TokenPayload = {
  _userId: 'op-1',
  _username: 'op-bob',
  _role: 'operator',
  _type: 'access',
  _organizationId: ORG,
};

const noOrgOperator: TokenPayload = {
  _userId: 'op-2',
  _username: 'op-dan',
  _role: 'operator',
  _type: 'access',
};

const viewerUser: TokenPayload = {
  _userId: 'viewer-1',
  _username: 'viewer-carol',
  _role: 'viewer',
  _type: 'access',
  _organizationId: ORG,
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
const { findMatches, listConflicts, getCILineage, getCIFieldSources, getRules, getSourceAuthorities } =
  reconciliationResolvers.ReconciliationQuery;

const noOrgAdmin: TokenPayload = { ...adminUser, _userId: 'admin-2', _organizationId: undefined };

beforeEach(() => {
  armClients();
});

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

  it('mergeCI is FORBIDDEN for an operator, with zero engine calls', async () => {
    await expectGraphQLErrorCode(mergeCI(null, args, contextWith(operatorUser)), 'FORBIDDEN');
    await expectGraphQLErrorCode(mergeCI(null, args, contextWith(adminUser)), 'FORBIDDEN');
    expect(mockGetIdentityReconciliationEngine).not.toHaveBeenCalled();
    expect(mockReconcileCI).not.toHaveBeenCalled();
    expect(mockFindExistingCI).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('findMatches', () => {
  const args = { _identifiers: { _serialNumber: 'SN-1' }, _source: 'aws' };

  it('passes the context org to the engine', async () => {
    mockFindExistingCI.mockResolvedValue({
      ci_id: 'ci-1',
      confidence: 95,
      match_strategy: 'serial_number',
      matched_attributes: ['serial_number'],
    });

    const result = await findMatches(null, args, contextWith(operatorUser));

    expect(mockFindExistingCI).toHaveBeenCalledTimes(1);
    expect(mockFindExistingCI.mock.calls[0]![2]).toBe(ORG);
    expect(result?._ciId).toBe('ci-1');
  });

  it('is FORBIDDEN without an organization claim, with zero engine calls', async () => {
    await expectGraphQLErrorCode(findMatches(null, args, contextWith(noOrgOperator)), 'FORBIDDEN');
    expect(mockFindExistingCI).not.toHaveBeenCalled();
  });
});

describe('read resolvers', () => {
  it.each([
    ['getCILineage', getCILineage],
    ['getCIFieldSources', getCIFieldSources],
  ])("%s is NOT_FOUND for another org's CI, with zero SQL", async (_name, resolver) => {
    mockOrganizationCIIds.mockResolvedValue([]);

    await expectGraphQLErrorCode(resolver(null, { _ciId: 'ci-b' }, contextWith(operatorUser)), 'NOT_FOUND');
    expect(mockOrganizationCIIds).toHaveBeenCalledWith(['ci-b'], ORG);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("listConflicts pages only conflicts of the org's CIs", async () => {
    const ownRow = {
      id: CONFLICT_ID, ci_id: 'ci-a', conflict_type: 'field_mismatch', source_data: {}, target_data: {},
      conflicting_fields: [], status: 'pending', created_at: new Date(),
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ci_id: 'ci-a' }, { ci_id: 'ci-b' }] }) // conflict CIs of every org
      .mockResolvedValueOnce({ rows: [ownRow] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });
    mockOrganizationCIIds.mockResolvedValue(['ci-a']);

    const result = await listConflicts(null, {}, contextWith(viewerUser));

    expect(mockOrganizationCIIds).toHaveBeenCalledWith(['ci-a', 'ci-b'], ORG);
    // The page and count queries are restricted to the owned CI ids.
    expect(mockQuery.mock.calls[1]![1]).toEqual(['pending', ['ci-a'], 100, 0]);
    expect(mockQuery.mock.calls[2]![1]).toEqual(['pending', ['ci-a']]);
    expect(result.map(c => c._id)).toEqual([CONFLICT_ID]);
  });

  it.each([
    ['getRules', getRules],
    ['getSourceAuthorities', getSourceAuthorities],
  ])('%s is FORBIDDEN for an operator and for an admin without an org claim', async (_name, resolver) => {
    await expectGraphQLErrorCode(resolver(null, {}, contextWith(operatorUser)), 'FORBIDDEN');
    await expectGraphQLErrorCode(resolver(null, {}, contextWith(noOrgAdmin)), 'FORBIDDEN');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('resolveConflict', () => {
  const args = { _id: CONFLICT_ID, _resolution: 'accept_source' };
  const conflictRow = {
    id: CONFLICT_ID,
    ci_id: 'ci-1',
    conflict_type: 'field_mismatch',
    source_data: {},
    target_data: {},
    conflicting_fields: ['name'],
    created_at: new Date(),
  };

  it('rejects unauthenticated requests with UNAUTHENTICATED', async () => {
    await expectGraphQLErrorCode(resolveConflict(null, args, contextWith(undefined)), 'UNAUTHENTICATED');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects viewers with FORBIDDEN', async () => {
    await expectGraphQLErrorCode(resolveConflict(null, args, contextWith(viewerUser)), 'FORBIDDEN');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("succeeds for an operator on a conflict of the org's CI and updates the conflict row", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [conflictRow] }).mockResolvedValueOnce({ rows: [] });
    mockOrganizationCIIds.mockResolvedValue(['ci-1']);

    const result = await resolveConflict(null, args, contextWith(operatorUser));

    expect(mockOrganizationCIIds).toHaveBeenCalledWith(['ci-1'], ORG);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(result._status).toBe('RESOLVED');
  });

  it("is NOT_FOUND for another org's conflict and updates nothing", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [conflictRow] });
    mockOrganizationCIIds.mockResolvedValue([]);

    await expectGraphQLErrorCode(resolveConflict(null, args, contextWith(operatorUser)), 'NOT_FOUND');
    expect(mockQuery).toHaveBeenCalledTimes(1);
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

  it('rejects operators with FORBIDDEN (global configuration is admin-only)', async () => {
    await expectGraphQLErrorCode(createRule(null, args, contextWith(operatorUser)), 'FORBIDDEN');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('succeeds for an admin and inserts the rule', async () => {
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

    const result = await createRule(null, args, contextWith(adminUser));

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

  it('rejects operators with FORBIDDEN (global configuration is admin-only)', async () => {
    await expectGraphQLErrorCode(updateSourceAuthority(null, args, contextWith(operatorUser)), 'FORBIDDEN');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('succeeds for an admin and upserts the source authority row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await updateSourceAuthority(null, args, contextWith(adminUser));

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(result._authorityScore).toBe(8);
  });
});
