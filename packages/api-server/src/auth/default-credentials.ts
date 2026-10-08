// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Default-credential policy (HP1-S6, design v16 §1.1, P-6 / SEC11-02).
 *
 * The repository's only documented default password is the seeded admin's
 * 'Admin123!' (deploy.sh, init-neo4j.cypher). Outside development it is
 * refused, together with every string bcrypt treats as the same key.
 */

import { timingSafeEqual } from 'crypto';

export const DEFAULT_PLAINTEXTS: readonly string[] = ['Admin123!'];

/** bcrypt ($2b$) uses at most 72 key bytes. */
export const BCRYPT_MAX_KEY_BYTES = 72;

/** Minimum length of an operator-rotated password. */
export const ROTATION_MIN_LENGTH = 12;

/**
 * Every environment except development refuses default credentials (an
 * unset NODE_ENV counts as non-development).
 */
export function defaultCredentialsRefused(env: string | undefined = process.env['NODE_ENV']): boolean {
  return env !== 'development';
}

/**
 * The 72-byte key bcrypt derives from a password: utf8(p) ‖ 0x00, cycled to
 * and truncated at 72 bytes. Two passwords with equal keys verify against the
 * same hash, so 'Admin123!\0' repeated past 59 bytes is the default too.
 */
export function bcryptKey(password: string): Buffer {
  const source = Buffer.concat([Buffer.from(password, 'utf8'), Buffer.from([0])]);
  const key = Buffer.alloc(BCRYPT_MAX_KEY_BYTES);
  for (let i = 0; i < BCRYPT_MAX_KEY_BYTES; i++) {
    key[i] = source[i % source.length]!;
  }
  return key;
}

const DEFAULT_KEYS = DEFAULT_PLAINTEXTS.map(bcryptKey);

/** True when bcrypt would accept `password` for a hash of any default plaintext. */
export function isDefaultEquivalent(password: string): boolean {
  const key = bcryptKey(password);
  let match = false;
  for (const defaultKey of DEFAULT_KEYS) {
    // Constant time per comparison; every default is always compared.
    match = timingSafeEqual(key, defaultKey) || match;
  }
  return match;
}

export function containsNul(password: string): boolean {
  return password.includes('\u0000');
}

/**
 * A new password (self-service change or operator rotation) is refused when
 * it contains U+0000, exceeds bcrypt's 72-byte key, or is default-equivalent.
 * Enforced in every environment.
 */
export function newPasswordAllowed(password: string): boolean {
  return !containsNul(password)
    && Buffer.byteLength(password, 'utf8') <= BCRYPT_MAX_KEY_BYTES
    && !isDefaultEquivalent(password);
}
