// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Password Service
 * Handles password hashing and verification using bcrypt
 */

import * as bcrypt from 'bcrypt';
import { BCRYPT_ROUNDS_DEFAULT, BCRYPT_ROUNDS_MAX, BCRYPT_ROUNDS_MIN, type ConfigSchema } from '@cmdb/common';

/**
 * A stored hash bcrypt compares at its own cost (HAP-1090). Measured against the installed bcrypt 5.1.1: `$2a$` and
 * `$2b$` with cost 04-30 run the full key schedule; `$2y$`, `$2x$`, cost 00-03 and cost 31+ are rejected in
 * microseconds with no CPU. Legacy `$2$` is outside the shape and fails closed. Only the full-cost kind may be
 * compared as stored; every other shape takes the dummy-hash compare so each attempt costs one full-cost compare.
 */
export const BCRYPT_HASH = /^\$2[ab]\$(0[4-9]|[12]\d|30)\$[./A-Za-z0-9]{53}$/;

/**
 * The cost the API is configured with, for processes that do not load the API config (operator scripts): the
 * `BCRYPT_ROUNDS` variable as ConfigurationLoader reads it, else the schema default, held to the schema bounds.
 */
export function configuredBcryptRounds(env: NodeJS.ProcessEnv): number {
  const raw = env['BCRYPT_ROUNDS'];
  const rounds = raw ? parseInt(raw, 10) : BCRYPT_ROUNDS_DEFAULT;
  if (!Number.isInteger(rounds) || rounds < BCRYPT_ROUNDS_MIN || rounds > BCRYPT_ROUNDS_MAX) {
    throw new Error(`BCRYPT_ROUNDS must be ${BCRYPT_ROUNDS_MIN}-${BCRYPT_ROUNDS_MAX}`);
  }
  return rounds;
}

export class PasswordService {
  private rounds: number;

  constructor(config: ConfigSchema['auth']['bcrypt']) {
    this.rounds = config.rounds;
  }

  /**
   * Hash a password
   */
  async hash(password: string): Promise<string> {
    return bcrypt.hash(password, this.rounds);
  }

  /**
   * Verify a password against a hash
   */
  async verify(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  /**
   * Check if a hash needs to be rehashed (rounds changed)
   */
  needsRehash(hash: string): boolean {
    const currentRounds = bcrypt.getRounds(hash);
    return currentRounds !== this.rounds;
  }
}
