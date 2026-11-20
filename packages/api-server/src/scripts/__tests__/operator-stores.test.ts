// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * `openOperatorStores` (rotate-user-password, identity-window) accepts only a plain `bolt://` or `neo4j://` URI.
 * A `+ssc` scheme would make the driver trust any certificate; TLS is selected only by
 * CMDB_ROTATE_NEO4J_ENCRYPTED=true (system-CA verification).
 */
import neo4j from 'neo4j-driver';
import { logger } from '@cmdb/common';
import { PostgresClient } from '../../../../database/src/postgres/client';
import { openOperatorStores } from '../operator-stores';

jest.mock('neo4j-driver', () => ({
  __esModule: true,
  default: {
    driver: jest.fn(),
    auth: { basic: () => ({}) },
  },
}));
jest.mock('../../../../database/src/postgres/client', () => ({
  PostgresClient: jest.fn(),
}));

const driverMock = neo4j.driver as unknown as jest.Mock;
const postgresMock = PostgresClient as unknown as jest.Mock;
const FIXED_MESSAGE =
  'CMDB_ROTATE_NEO4J_URI must be bolt://<host>[:port] or neo4j://<host>[:port] (use CMDB_ROTATE_NEO4J_ENCRYPTED=true for TLS)';

function envWith(uri: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CMDB_ROTATE_POSTGRES_HOST: 'pg',
    CMDB_ROTATE_POSTGRES_PORT: '5432',
    CMDB_ROTATE_POSTGRES_DB: 'cmdb',
    CMDB_ROTATE_POSTGRES_USER: 'u',
    CMDB_ROTATE_POSTGRES_PASSWORD: 'p',
    CMDB_ROTATE_NEO4J_URI: uri,
    CMDB_ROTATE_NEO4J_USERNAME: 'neo4j',
    CMDB_ROTATE_NEO4J_PASSWORD: 'p',
    ...extra,
  };
}

beforeEach(() => {
  driverMock.mockReset();
  driverMock.mockReturnValue({});
  postgresMock.mockReset();
  postgresMock.mockReturnValue({});
  jest.spyOn(logger, 'info').mockImplementation(() => logger);
  jest.spyOn(logger, 'warn').mockImplementation(() => logger);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('openOperatorStores CMDB_ROTATE_NEO4J_URI', () => {
  it.each([
    'bolt+s://h',
    'bolt+ssc://h',
    'neo4j+s://h',
    'neo4j+ssc://h:7687',
    'BOLT://h',
    'bolt://user:secret@h',
    'bolt://h/db',
    'bolt://h?x=1',
    'bolt://h#f',
    'bolt://',
  ])('refuses %s with the fixed message, before any client is built', (uri) => {
    let message = '';
    try {
      openOperatorStores(envWith(uri, { CMDB_ROTATE_NEO4J_ENCRYPTED: 'true' }));
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe(FIXED_MESSAGE);
    expect(message).not.toContain('secret');
    expect(postgresMock).not.toHaveBeenCalled();
    expect(driverMock).not.toHaveBeenCalled();
  });

  it.each(['bolt://h:7687', 'neo4j://h'])('accepts %s', (uri) => {
    openOperatorStores(envWith(uri));

    expect(postgresMock).toHaveBeenCalledTimes(1);
    expect(driverMock).toHaveBeenCalledTimes(1);
    expect(driverMock.mock.calls[0][0]).toBe(uri);
    expect(driverMock.mock.calls[0][2].encrypted).toBe('ENCRYPTION_OFF');
  });

  it('gives CMDB_ROTATE_NEO4J_ENCRYPTED=true encryption with system-CA trust, not trust-all', () => {
    openOperatorStores(envWith('neo4j://h', { CMDB_ROTATE_NEO4J_ENCRYPTED: 'true' }));

    const config = driverMock.mock.calls[0][2];
    expect(config.encrypted).toBe('ENCRYPTION_ON');
    expect(config.trust).toBe('TRUST_SYSTEM_CA_SIGNED_CERTIFICATES');
  });
});
