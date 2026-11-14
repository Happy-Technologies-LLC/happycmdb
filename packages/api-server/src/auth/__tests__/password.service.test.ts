// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1090: the stored-hash shape bcrypt compares at full cost, and the one configured cost every hash writer uses
 * (the API through PasswordService, the operator scripts through BCRYPT_ROUNDS).
 */

import { describe, expect, it } from '@jest/globals';
import * as bcrypt from 'bcrypt';
import { BCRYPT_ROUNDS_DEFAULT } from '@cmdb/common';
import { configSchema } from '@cmdb/common/config/config.schema';
import { BCRYPT_HASH, configuredBcryptRounds, PasswordService } from '../password.service';
import { rotationHasher } from '../../scripts/rotate-user-password';
import { seedHasher } from '../../scripts/seed-tenant-fixture';

/** 53 characters of salt and digest in the bcrypt alphabet. */
const BODY = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ./01234'.slice(0, 53);
const shaped = (prefix: string, cost: string, body = BODY): string => `$${prefix}$${cost}$${body}`;
const COSTS = Array.from({ length: 27 }, (_, i) => String(i + 4).padStart(2, '0'));

describe('BCRYPT_HASH: only what bcrypt compares at full cost is compared as stored', () => {
  it.each(['2a', '2b'].flatMap(prefix => COSTS.map(cost => [prefix, cost] as const)))('accepts $%s$%s$', (prefix, cost) => {
    expect(BCRYPT_HASH.test(shaped(prefix, cost))).toBe(true);
  });

  it('accepts what the installed bcrypt produces', async () => {
    expect(BCRYPT_HASH.test(await bcrypt.hash('pw', 4))).toBe(true);
    expect(BCRYPT_HASH.test(await bcrypt.hash('pw', 5))).toBe(true);
  });

  it.each([
    ['$2y$ (the installed bcrypt rejects it without work)', shaped('2y', '10')],
    ['$2x$', shaped('2x', '10')],
    ['$2c$', shaped('2c', '10')],
    ['legacy $2$', `$2$10$${BODY}`],
    ['an upper-case prefix', shaped('2B', '10')],
    ['cost 00', shaped('2b', '00')],
    ['cost 03', shaped('2b', '03')],
    ['cost 31 (the installed bcrypt rejects it without work)', shaped('2b', '31')],
    ['cost 32', shaped('2b', '32')],
    ['cost 99', shaped('2b', '99')],
    ['a one-digit cost', shaped('2b', '4')],
    ['a three-digit cost', shaped('2b', '100')],
    ['a body of 52 characters', shaped('2b', '10', BODY.slice(1))],
    ['a body of 54 characters', shaped('2b', '10', `${BODY}a`)],
    ['a body character outside the alphabet', shaped('2b', '10', `${BODY.slice(1)}+`)],
    ['a trailing newline', `${shaped('2b', '10')}\n`],
    ['a leading space', ` ${shaped('2b', '10')}`],
    ['an empty string', ''],
    ['a plaintext password', 'Admin123!'],
    ['an argon2 hash', '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG'],
    ['a truncated bcrypt prefix', '$2b$04'],
  ])('rejects %s', (_label, value) => {
    expect(BCRYPT_HASH.test(value)).toBe(false);
  });
});

describe('the configured bcrypt cost', () => {
  const schemaAccepts = (raw: string): boolean => configSchema.extract('auth.bcrypt.rounds').validate(parseInt(raw, 10)).error === undefined;

  it('defaults to the schema default', () => {
    expect(configuredBcryptRounds({})).toBe(BCRYPT_ROUNDS_DEFAULT);
    expect(configuredBcryptRounds({ BCRYPT_ROUNDS: '' })).toBe(BCRYPT_ROUNDS_DEFAULT);
    expect(configSchema.extract('auth.bcrypt').validate(undefined).value).toEqual({ rounds: BCRYPT_ROUNDS_DEFAULT });
  });

  it.each(['0', '9', '10', '11', '12', '15', '16', '31', '-1', 'abc', '1e1'])('%s is accepted exactly when the config schema accepts it', raw => {
    const accepted = schemaAccepts(raw);

    if (accepted) expect(configuredBcryptRounds({ BCRYPT_ROUNDS: raw })).toBe(parseInt(raw, 10));
    else expect(() => configuredBcryptRounds({ BCRYPT_ROUNDS: raw })).toThrow('BCRYPT_ROUNDS must be 10-15');
  });

  it('is the cost of a PasswordService hash and of both operator script hashers', async () => {
    const env = { BCRYPT_ROUNDS: '10' };
    const hashes = await Promise.all([
      new PasswordService({ rounds: configuredBcryptRounds(env) }).hash('pw'),
      rotationHasher(env)('pw'),
      seedHasher(env)('pw'),
    ]);

    expect(hashes.map(hash => bcrypt.getRounds(hash))).toEqual([10, 10, 10]);
  });

  it('is the schema default for both operator script hashers when BCRYPT_ROUNDS is unset', async () => {
    const hashes = await Promise.all([rotationHasher({})('pw'), seedHasher({})('pw')]);

    expect(hashes.map(hash => bcrypt.getRounds(hash))).toEqual([BCRYPT_ROUNDS_DEFAULT, BCRYPT_ROUNDS_DEFAULT]);
  });

  it('is refused by the scripts when out of range, and the former rotation variable is no longer read', () => {
    expect(() => rotationHasher({ BCRYPT_ROUNDS: '9' })).toThrow('BCRYPT_ROUNDS must be 10-15');
    expect(() => seedHasher({ BCRYPT_ROUNDS: '16' })).toThrow('BCRYPT_ROUNDS must be 10-15');
    expect(() => rotationHasher({ CMDB_ROTATE_BCRYPT_ROUNDS: '11' })).toThrow('CMDB_ROTATE_BCRYPT_ROUNDS is no longer read');
  });
});
