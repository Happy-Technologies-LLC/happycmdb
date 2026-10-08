// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Dedicated platform administrator (P-6, design v16 §1.1).
 *
 * Platform administration is a separate flag (`platformAdmin` on the :User
 * node), set only by the reviewed operator grant (scripts/identity-window.ts).
 * It is independent of role and organization: role `admin` in any org,
 * including the internal org, grants nothing. A seeded account never
 * qualifies, whatever its flag, id shape, overrides or later rotation.
 */

import type { User } from './types';

export const SEEDED_ADMIN_ID = 'user-admin-001';
export const SEEDED_ADMIN_USERNAME = 'admin';
export const SEEDED_ADMIN_EMAIL = 'admin@happycmdb.local';

/** Any account created by a seed writer or still holding a default password. */
export function isSeededAccount(user: Pick<User, '_id' | '_username' | '_email' | '_seedProvenance' | '_defaultPasswordSuspect'>): boolean {
  return (user._seedProvenance !== undefined && user._seedProvenance !== null)
    || user._id === SEEDED_ADMIN_ID
    || (typeof user._username === 'string' && user._username.toLowerCase() === SEEDED_ADMIN_USERNAME)
    || (typeof user._email === 'string' && user._email.toLowerCase() === SEEDED_ADMIN_EMAIL)
    || user._defaultPasswordSuspect === true;
}

/** Effective platform-administrator status of a freshly loaded user. */
export function isPlatformAdmin(user: User): boolean {
  return user._platformAdmin === true && !isSeededAccount(user);
}
