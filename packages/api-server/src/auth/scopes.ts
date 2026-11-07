// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Dedicated scopes (HAP-1615, Suite Contracts v2 C1): grants independent of role and organization, stored as the
 * `scopes` list on the :User node and set only by a reviewed operator grant (HAP-1632), never through the API. Role
 * `admin` and platform administration grant none. A seeded account never holds one, whatever its stored list.
 */

import { isSeededAccount } from './platform-admin';
import type { User } from './types';

/** The one-way HappyHive portfolio import (POST /api/v1/portfolio/imports): the migration principal only. */
export const PORTFOLIO_IMPORT_SCOPE = 'portfolio:import';

export type Scope = typeof PORTFOLIO_IMPORT_SCOPE;

/** Whether a freshly loaded user holds `scope`: its stored `scopes` is a list naming it exactly, and it is not seeded. */
export function holdsScope(user: User, scope: Scope): boolean {
  return Array.isArray(user._scopes) && user._scopes.includes(scope) && !isSeededAccount(user);
}
