// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** HAP-1731: a stored `metadata` that is not a JSON object never fails a CI read; a JSON object round-trips unchanged. */
import { Neo4jClient, UNSCOPED_CI_ACCESS } from '../client';

jest.mock('neo4j-driver', () => ({ __esModule: true, default: { driver: () => ({}), auth: { basic: () => ({}) } } }));

const readWith = (metadata: unknown) => {
  const client = new Neo4jClient('bolt://x', 'u', 'p');
  jest.spyOn(client, 'getSession').mockReturnValue({
    run: async () => ({ records: [{ get: () => ({ properties: { id: 'ci-1', metadata } }) }] }), close: async () => undefined,
  } as never);
  return client.getCI('ci-1', UNSCOPED_CI_ACCESS);
};

it.each(['x', '[1]', '5', 'null'])('a CI whose stored metadata is %p reads with empty metadata', async stored => {
  expect((await readWith(stored))?._metadata).toEqual({});
});

it('a stored JSON object metadata reads back unchanged', async () => {
  const metadata = { location: 'us-east-1', tags: { tier: 1 } };
  expect((await readWith(JSON.stringify(metadata)))?._metadata).toEqual(metadata);
});
