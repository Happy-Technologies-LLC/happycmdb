// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1733: an INTERNAL_SERVER_ERROR response carries no error text. Every
 * resolver runs against dependencies that throw an Error quoting SECRET; the
 * GraphQLError it raises must not carry SECRET or an originalError. A raw
 * throw is not asserted here: format-error.test.ts covers what the server
 * makes of it.
 */

import { GraphQLError } from 'graphql';
import { SECRET, throwing } from '../../../__tests__/support/throwing-deps';

jest.mock('@cmdb/database', () => require('../../../__tests__/support/throwing-deps').databaseModule());
jest.mock('@cmdb/common', () => require('../../../__tests__/support/throwing-deps').commonModule());

import { resolvers } from '../index';
import { analyticsResolvers } from '../analytics.resolver';

const ORG = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const ID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

const context = {
  user: { _userId: ID, _username: 'alice', _role: 'admin', _type: 'access', _organizationId: ORG },
  credentialType: 'jwt',
  _neo4jClient: throwing(),
  _loaders: { _ciLoader: throwing(), _relationshipLoader: throwing(), _dependentLoader: throwing() },
};
const args = new Proxy({}, { get: (_t, key) => (typeof key === 'string' ? ID : undefined) });

type Resolver = (parent: unknown, args: unknown, context: unknown, info: unknown) => Promise<unknown>;
const groups: Array<[string, Record<string, Resolver>]> = [
  ['Query', resolvers.Query as unknown as Record<string, Resolver>],
  ['Mutation', resolvers.Mutation as unknown as Record<string, Resolver>],
  ['AnalyticsQuery', analyticsResolvers.AnalyticsQuery as unknown as Record<string, Resolver>],
];
const table = groups.flatMap(([group, fields]) =>
  Object.entries(fields).filter(([, fn]) => typeof fn === 'function').map(([field, fn]) => [`${group}.${field}`, fn] as const));
const internal: string[] = [];

describe('resolvers', () => {
  it.each(table)('%s', async (name, resolver) => {
    const error = await (async () => resolver({}, args, context, {}))().then(() => undefined, (thrown: unknown) => thrown);
    if (!(error instanceof GraphQLError)) return;
    if (error.extensions['code'] === 'INTERNAL_SERVER_ERROR') internal.push(name);
    expect(JSON.stringify({ message: error.message, extensions: error.extensions })).not.toContain(SECRET);
    expect(error.extensions).not.toHaveProperty('originalError');
  });

  // Guards the table: the resolvers that carried originalError must still reach their internal-error path.
  it('the resolvers that set originalError are exercised', () => {
    expect(internal).toEqual(expect.arrayContaining([
      'Query.getCIRelationships', 'Query.ciHistory',
      ...['getCICountsByType', 'getCICountsByStatus', 'getCICountsByEnvironment', 'getRelationshipCounts', 'getDiscoveryStats',
        'getDiscoveryTimeline', 'getDashboardStats', 'getInventoryReport'].map(field => `AnalyticsQuery.${field}`),
    ]));
  });
});
