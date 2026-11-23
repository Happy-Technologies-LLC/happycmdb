// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The real neo4j-driver, not the call-capture mock of client-encryption.test.ts: a scheme the driver does not know is
 * refused by the driver, and `Neo4jClient` must neither swallow nor rewrite that error. Upper-case TLS schemes are one
 * such case (neo4j-driver 5.x matches schemes case-sensitively).
 */
import { logger } from '@cmdb/common';
import { Neo4jClient } from '../client';

beforeEach(() => {
  jest.spyOn(logger, 'info').mockImplementation(() => logger);
  jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  jest.spyOn(logger, 'error').mockImplementation(() => logger);
});

afterEach(() => jest.restoreAllMocks());

describe('upper-case TLS scheme with the real driver', () => {
  it.each(['BOLT+S://h', 'Neo4j+SSC://h'])('%s is refused with the driver Unknown scheme error', uri => {
    expect(() => new Neo4jClient(uri, 'u', 'p')).toThrow(/Unknown scheme/);
  });

  it('a lower-case TLS scheme is accepted by the same driver', () => {
    expect(() => new Neo4jClient('bolt+s://h', 'u', 'p')).not.toThrow();
  });
});
