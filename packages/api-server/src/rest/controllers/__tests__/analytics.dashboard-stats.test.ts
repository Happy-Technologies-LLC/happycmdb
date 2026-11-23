// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * GET /analytics/dashboard payload honesty (BW4): `health_score` is null, never 0 (there is no CI health state,
 * and 0 reads as "everything is down"), including for an organization with no CIs.
 *
 * `critical_relationships` (relationships with at least one tier_1/tier_2 endpoint, both ends in the caller's
 * organization) is NOT evaluated here: a fake cannot prove a Cypher boolean predicate. It is proven against real
 * Neo4j in tests/integration/analytics-tenancy.test.ts, with a graph where OR, AND, source-only, target-only and
 * unscoped predicates each give a different count.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import neo4j from 'neo4j-driver';

jest.mock('@cmdb/common', () => ({
  logger: { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));
jest.mock('@cmdb/database', () => ({ getNeo4jClient: jest.fn(), getPostgresClient: jest.fn() }));
// The auth middleware imported by the controller pulls in bcrypt's native binding, unused here.
jest.mock('bcrypt', () => ({}));

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { AnalyticsController } from '../analytics.controller';

const ORG = '11111111-1111-4111-8111-111111111111';

// An organization with no CIs: every statement answers with no groups, and the count statement with zero.
const rec = (row: Record<string, unknown>) => ({ get: (key: string) => row[key] });
const run = async (cypher: string) => ({
  records: cypher.includes('COUNT(ci) as total_cis') ? [rec({ total_cis: neo4j.int(0) })] : [],
});

describe('getDashboardStats: health_score', () => {
  it('is null (unavailable), not 0, for an organization with no CIs', async () => {
    (getPostgresClient as jest.Mock).mockReturnValue({ query: jest.fn() });
    (getNeo4jClient as jest.Mock).mockReturnValue({ getSession: () => ({ run, close: async () => undefined }) });
    const out = { status: jest.fn().mockReturnThis(), json: jest.fn(), body: undefined as unknown };
    out.json.mockImplementation((body: unknown) => { out.body = body; return out; });
    await new AnalyticsController().getDashboardStats(
      { user: { _organizationId: ORG } } as unknown as Request, out as unknown as Response);
    expect(out.status).not.toHaveBeenCalled();
    const body = out.body as Record<string, unknown>;
    expect(body['health_score']).toBeNull();
  });
});
