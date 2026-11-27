// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { performance } from 'perf_hooks';
import type { Pool } from 'pg';
import type { CredentialMatchContext, CredentialSetStrategy } from '@cmdb/common';

jest.mock('@cmdb/common', () => ({
  ...jest.requireActual('@cmdb/common'),
  getEncryptionService: () => ({ decrypt: (value: string) => value }),
}));

import { CredentialSetService } from '../credential-set.service';

const OWNER = 'user-1';
const ORG = 'org-1';
const SET_ID = 'set-1';

type Affinity = Record<string, unknown>;

/** Fake pool: the set row and the credential rows are served by SQL text. */
function build(affinities: Affinity[], strategy: CredentialSetStrategy = 'adaptive') {
  const ids = affinities.map((_, i) => `cred-${i}`);
  const release = jest.fn();
  const query = jest.fn(async (text: string) => {
    if (text.includes('FROM credential_sets')) {
      return { rows: [{ id: SET_ID, name: 's', credential_ids: ids, strategy, stop_on_success: true, tags: [], created_by: OWNER }] };
    }
    if (text.includes('FROM credentials')) {
      return {
        rows: affinities.map((affinity, i) => ({
          id: ids[i], name: `c${i}`, protocol: 'ssh_password', scope: 'ssh', credentials: '{}', affinity, tags: [], created_by: OWNER,
        })),
      };
    }
    throw new Error(`unexpected query: ${text}`);
  });
  const pool = { connect: jest.fn(async () => ({ query, release })) } as unknown as Pool;
  const select = async (context: CredentialMatchContext) =>
    (await new CredentialSetService(pool).selectCredentials(SET_ID, context, undefined, OWNER, ORG)).map((c) => c.id);
  return { select, release };
}

describe('CredentialSetService adaptive affinity', () => {
  it.each([26, 40])('a (a+)+ hostname pattern returns promptly and earns no hostname score (n=%i)', async (n) => {
    // cred-0 has the lower priority, so it only leads if the hostile pattern is (wrongly) scored.
    const { select, release } = build([
      { hostname_patterns: ['(a+)+'], priority: 5 },
      { priority: 7 },
    ]);

    const started = performance.now();
    const order = await select({ hostname: 'a'.repeat(n) + '!' });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(100);
    expect(order).toEqual(['cred-1', 'cred-0']);
    expect(release).toHaveBeenCalledTimes(2);
  }, 5000);

  it('a pattern with regex alternation no longer over-matches', async () => {
    const { select } = build([
      { hostname_patterns: ['good.net|evil.com'], priority: 5 },
      { hostname_patterns: ['x|y'], priority: 5 },
      { priority: 7 },
    ]);

    expect(await select({ hostname: 'evil.com' })).toEqual(['cred-2', 'cred-0', 'cred-1']);
    expect(await select({ hostname: 'x.y' })).toEqual(['cred-2', 'cred-0', 'cred-1']);
  });

  it('a literal pattern containing + still matches exactly that hostname', async () => {
    const { select } = build([
      { hostname_patterns: ['a+b.example.com'], priority: 5 },
      { priority: 7 },
    ]);

    expect(await select({ hostname: 'a+b.example.com' })).toEqual(['cred-0', 'cred-1']);
    expect(await select({ hostname: 'aab.example.com' })).toEqual(['cred-1', 'cred-0']);
  });

  it('a glob pattern boosts a credential case-insensitively', async () => {
    const { select } = build([
      { hostname_patterns: ['*.example.com'], priority: 5 },
      { priority: 7 },
    ]);

    expect(await select({ hostname: 'DB1.EXAMPLE.COM' })).toEqual(['cred-0', 'cred-1']);
    expect(await select({ hostname: 'example.com' })).toEqual(['cred-1', 'cred-0']);
  });

  it('a /0 network matches every address, a prefix outside 0-32 matches none', async () => {
    const { select } = build([
      { networks: ['0.0.0.0/0'], priority: 5 },
      { networks: ['10.1.2.3/33'], priority: 5 },
      { priority: 7 },
    ]);

    expect(await select({ ip: '10.1.2.3' })).toEqual(['cred-0', 'cred-2', 'cred-1']);
  });

  it('a bare IP network matches only that exact address', async () => {
    const { select } = build([
      { networks: ['10.1.2.3'], priority: 5 },
      { priority: 7 },
    ]);

    expect(await select({ ip: '10.1.2.3' })).toEqual(['cred-0', 'cred-1']);
    expect(await select({ ip: '10.1.2.4' })).toEqual(['cred-1', 'cred-0']);
  });
});
