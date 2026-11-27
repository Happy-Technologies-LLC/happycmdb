// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Credential affinity and match-context bounds hold at the service entry points
 * (not only in the REST Joi schemas), and a bad match-context ip is never logged.
 */
import type { Pool } from 'pg';
import type { CredentialMatchContext } from '@cmdb/common';

jest.mock('@cmdb/common', () => ({
  ...jest.requireActual('@cmdb/common'),
  getEncryptionService: () => ({ decrypt: (value: string) => value, encrypt: (value: string) => value }),
}));

import {
  logger,
  CredentialInputBoundsError,
  MAX_AFFINITY_ITEMS,
  MAX_HOSTNAME_LENGTH,
  MAX_NETWORK_LENGTH,
  assertAffinityBounds,
} from '@cmdb/common';
import { CredentialAffinityService } from '../credential-services/affinity.service';
import { CredentialCRUDService } from '../credential-services/crud.service';
import { CredentialSetService } from '../credential-set.service';
import * as utils from '../credential-services/utils';

const OWNER = 'user-1';
const ORG = 'org-1';

function poolWith(rows: unknown[] = []) {
  const query = jest.fn(async () => ({ rows }));
  const connect = jest.fn(async () => ({ query, release: jest.fn() }));
  return { pool: { connect } as unknown as Pool, connect };
}

const credentialInput = (affinity: object) => ({
  name: 'n', protocol: 'ssh_password' as const, scope: 'ssh' as const, credentials: { username: 'svc', password: 'p' }, affinity,
});
const items = (n: number, len = 10) => Array.from({ length: n }, () => 'a'.repeat(len));

describe('credential write entry points refuse an oversize affinity before touching the database', () => {
  it.each([
    ['a hostname pattern over the cap', { hostname_patterns: ['a'.repeat(MAX_HOSTNAME_LENGTH + 1)] }],
    ['more hostname patterns than the cap', { hostname_patterns: items(MAX_AFFINITY_ITEMS + 1) }],
    ['a network over the cap', { networks: ['1'.repeat(MAX_NETWORK_LENGTH + 1)] }],
    ['more networks than the cap', { networks: items(MAX_AFFINITY_ITEMS + 1) }],
  ])('create and update reject %s', async (_label, affinity) => {
    const { pool, connect } = poolWith();
    const service = new CredentialCRUDService(pool);

    await expect(service.create(credentialInput(affinity), OWNER, ORG, false)).rejects.toBeInstanceOf(CredentialInputBoundsError);
    await expect(service.update('id-1', { affinity }, OWNER, ORG, false)).rejects.toBeInstanceOf(CredentialInputBoundsError);
    expect(connect).not.toHaveBeenCalled();
  });

  it('the caps are inclusive: exactly at the limit passes', () => {
    expect(() =>
      assertAffinityBounds({
        hostname_patterns: [...items(MAX_AFFINITY_ITEMS - 1), 'a'.repeat(MAX_HOSTNAME_LENGTH)],
        networks: [...items(MAX_AFFINITY_ITEMS - 1), '1'.repeat(MAX_NETWORK_LENGTH)],
      })
    ).not.toThrow();
  });
});

describe('match entry points refuse an oversize context before scoring', () => {
  const oversize: [string, CredentialMatchContext][] = [
    ['a 10 KB ip', { ip: '1'.repeat(10 * 1024) }],
    ['a 16 character ip', { ip: '1'.repeat(16) }],
    ['a hostname over the cap', { hostname: 'a'.repeat(MAX_HOSTNAME_LENGTH + 1) }],
  ];

  it.each(oversize)('rankCredentials and findBestMatch reject %s without a query', async (_label, context) => {
    const { pool, connect } = poolWith();
    const service = new CredentialAffinityService(pool);

    await expect(service.rankCredentials(context, OWNER, ORG)).rejects.toBeInstanceOf(CredentialInputBoundsError);
    await expect(service.findBestMatch(context, OWNER, ORG)).rejects.toBeInstanceOf(CredentialInputBoundsError);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(oversize)('selectCredentials rejects %s without a query', async (_label, context) => {
    const { pool, connect } = poolWith();

    await expect(new CredentialSetService(pool).selectCredentials('set-1', context, undefined, OWNER, ORG)).rejects.toBeInstanceOf(
      CredentialInputBoundsError
    );
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('an invalid match-context ip', () => {
  const row = (id: string, networks: string[]) => ({
    id, name: id, protocol: 'ssh_password', scope: 'ssh', credentials: '{}', affinity: { networks }, tags: [], created_by: OWNER,
  });
  const levels = ['error', 'warn', 'info', 'debug'] as const;

  it('is scored as no network match and appears in no log line', async () => {
    const spies = levels.map((level) => jest.spyOn(logger, level).mockImplementation(() => logger));
    try {
      const { pool } = poolWith([row('c1', ['10.0.0.0/8', '192.168.0.0/16']), row('c2', ['172.16.0.0/12'])]);
      const bad = 'a.b.c.SENTINEL'; // 14 characters: past the length guard, so the parse itself runs

      const ranked = await new CredentialAffinityService(pool).rankCredentials({ ip: bad }, OWNER, ORG);

      expect(ranked.map((r) => r.score)).toEqual([1, 1]);
      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      expect(logged).not.toContain('SENTINEL');
      expect(logged).not.toContain('10.0.0.0/8');
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it('is parsed once per request, not once per network of every credential', async () => {
    const parse = jest.spyOn(utils, 'ipToInt');
    try {
      const nets = ['10.0.0.0/8', '11.0.0.0/8', '12.0.0.0/8'];
      const { pool } = poolWith([row('c1', nets), row('c2', nets), row('c3', nets)]);

      const ranked = await new CredentialAffinityService(pool).rankCredentials({ ip: '12.1.2.3' }, OWNER, ORG);

      expect(ranked.map((r) => r.score)).toEqual([30, 30, 30]);
      expect(parse.mock.calls.filter(([arg]) => arg === '12.1.2.3')).toHaveLength(1);
    } finally {
      parse.mockRestore();
    }
  });
});
