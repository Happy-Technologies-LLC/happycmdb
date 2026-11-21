// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * A negative `limit` on the three analytics list resolvers is a client error
 * (BAD_USER_INPUT) raised before the service runs, not a negative LIMIT handed
 * to PostgreSQL or Neo4j. Omitted, null and 0 keep the default; an oversized
 * value keeps the silent clamp.
 */

import { GraphQLError } from 'graphql';
import type { TokenPayload } from '../../../auth/types';

const mockGetDiscoveryTimeline = jest.fn();
const mockGetTopConnectedCIs = jest.fn();
const mockGetChangeHistory = jest.fn();
const mockGetCI = jest.fn();

// jest.config.unit.js sets resetMocks, which strips implementations set inside a factory,
// so the service is a plain class forwarding to the named mocks above.
jest.mock('../../../services/analytics.service', () => ({
  AnalyticsService: class {
    getDiscoveryTimeline(...args: unknown[]) { return mockGetDiscoveryTimeline(...args); }
    getTopConnectedCIs(...args: unknown[]) { return mockGetTopConnectedCIs(...args); }
    getChangeHistory(...args: unknown[]) { return mockGetChangeHistory(...args); }
  },
  DependencyDepthLimitError: class DependencyDepthLimitError extends Error {},
}));
jest.mock('../../../read-admission', () => ({
  assertNoCIGap: async () => undefined,
  CIGapError: class CIGapError extends Error {},
  CIListUnavailableError: class CIListUnavailableError extends Error {},
  readSingleCI: (_org: string, _id: string, read: () => Promise<unknown>) => read(),
}));
jest.mock('../../../middleware/analysis-admission', () => ({ reserveAnalysisSlots: async () => undefined }));
jest.mock('@cmdb/common', () => ({
  logger: { info: () => undefined, error: () => undefined, warn: () => undefined, debug: () => undefined },
  CIAnalyticsLimitError: class CIAnalyticsLimitError extends Error {},
}));

import { analyticsResolvers } from '../analytics.resolver';

const ORG = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const CI_ID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const user: TokenPayload = { _userId: 'u-1', _username: 'alice', _role: 'viewer', _type: 'access', _organizationId: ORG };
const context = { user, _neo4jClient: { getCI: mockGetCI }, _loaders: {} };

const { getDiscoveryTimeline, getTopConnectedCIs, getChangeHistory } = analyticsResolvers.AnalyticsQuery as any;

type Case = { name: string; run: (limit?: number | null, ctx?: any) => Promise<unknown>; service: jest.Mock;
  limitOf: (call: unknown[]) => unknown; fallback: number; max: number };
const cases: Case[] = [
  { name: 'getDiscoveryTimeline', service: mockGetDiscoveryTimeline, fallback: 30, max: 365,
    run: (limit, ctx = context) => getDiscoveryTimeline(null, { interval: 'DAY', limit }, ctx),
    limitOf: call => call[2] },
  { name: 'getTopConnectedCIs', service: mockGetTopConnectedCIs, fallback: 10, max: 100,
    run: (limit, ctx = context) => getTopConnectedCIs(null, { limit }, ctx),
    limitOf: call => call[1] },
  { name: 'getChangeHistory', service: mockGetChangeHistory, fallback: 50, max: 1000,
    run: (limit, ctx = context) => getChangeHistory(null, { ciId: CI_ID, limit }, ctx),
    limitOf: call => call[2] },
];

beforeEach(() => {
  mockGetDiscoveryTimeline.mockResolvedValue([]);
  mockGetTopConnectedCIs.mockResolvedValue([]);
  mockGetChangeHistory.mockResolvedValue([]);
  mockGetCI.mockResolvedValue({ id: CI_ID, _incarnation_id: null });
});

describe.each(cases)('$name limit', ({ run, service, limitOf, fallback, max }) => {
  it.each([-1, -365])('refuses %i as BAD_USER_INPUT without calling the service', async value => {
    const error = await run(value).then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT');
    expect((error as GraphQLError).message).toBe('limit must be an integer of at least 1');
    expect(service).not.toHaveBeenCalled();
    expect(mockGetCI).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 0])('keeps the default %p', async value => {
    await run(value);
    expect(limitOf(service.mock.calls[0])).toBe(fallback);
  });

  it('passes a valid limit through and clamps one above the maximum', async () => {
    await run(7);
    await run(max + 1);
    await run(max);
    expect(service.mock.calls.map(limitOf)).toEqual([7, max, max]);
  });

  it('authorizes first: an anonymous caller with a bad limit gets UNAUTHENTICATED', async () => {
    const error = await run(-1, { ...context, user: undefined }).then(() => null, (thrown: unknown) => thrown);
    expect((error as GraphQLError).extensions['code']).toBe('UNAUTHENTICATED');
    expect(service).not.toHaveBeenCalled();
  });
});
