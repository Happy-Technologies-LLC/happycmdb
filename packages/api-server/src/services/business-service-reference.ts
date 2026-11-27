// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Suite Contracts v2 C1 (service reference) fields of a dim_business_services
 * row (HAP-1408 read, HAP-1423 stored record). The projection is additive:
 * the stored columns keep their names and meanings.
 *
 * - lifecycle: the stored C1 vocabulary (migration 043), separate from
 *   operational_status.
 * - owner: principal_id is owner_principal_id, the identity-provider subject
 *   of one accountable human (F14; HIVE's D15 tier-change approver);
 *   display_name is owned_by.
 * - owner_group, version: stored as is.
 * - owner_valid: whether owner.principal_id resolves, at read time, to an enabled user of the service's
 *   organization (the check an owner write applies). false for no principal, an unknown, disabled or other-tenant
 *   one, and when the identity store cannot answer (the read never fails for it). HIVE's D15 approver routing
 *   refuses an owner that is not valid.
 */

import { boundedStatementTimeoutMs } from '../rest/statement-timeout';

export type C1Lifecycle = 'planned' | 'live' | 'retiring' | 'retired';

/** C1 lifecycle in pipeline order: a move to an earlier state is backward. */
export const C1_LIFECYCLES: readonly C1Lifecycle[] = ['planned', 'live', 'retiring', 'retired'];

/** States in which the service needs an accountable owner principal (D15 approver). */
export function lifecycleNeedsOwner(lifecycle: C1Lifecycle): boolean {
  return lifecycle === 'live' || lifecycle === 'retiring';
}

/** Forward or unchanged; `retired` is terminal. */
export function lifecycleMoveAllowed(from: C1Lifecycle, to: C1Lifecycle): boolean {
  return from === to || (from !== 'retired' && C1_LIFECYCLES.indexOf(to) > C1_LIFECYCLES.indexOf(from));
}

/** A service row as dim_business_services stores it (the columns C1 reads). */
export interface StoredServiceRow {
  service_id: string;
  name: string;
  business_criticality: string;
  lifecycle: C1Lifecycle;
}

/** A dependency target with the dependency's type, as the reads select it. */
export interface StoredDependencyRow extends StoredServiceRow {
  dependency_type: string;
}

export interface C1ServiceDependency {
  service_id: string;
  name: string;
  criticality: string;
  lifecycle: C1Lifecycle;
  dependency_type: string;
}

export interface C1ServiceReference {
  tenant_id: string;
  owner: { principal_id: string | null; display_name: string | null };
  owner_valid: boolean;
  owner_group: string | null;
  criticality: string;
  lifecycle: C1Lifecycle;
  version: number;
  dependencies: C1ServiceDependency[];
}

/** The part of an identity-store user record the owner check reads (the stored organization). */
export interface OwnerUser {
  _organizationId?: string | null;
}

/**
 * The organization comparison of an owner check, shared by the owner writes and the C1 read: `user` is what the
 * identity store's findEnabledUser returned (null when missing or disabled). A stored node without an organization
 * never matches.
 */
export function ownerInOrganization(user: OwnerUser | null, organizationId: string): boolean {
  return user !== null && user._organizationId === organizationId;
}

/** Time bound of one owner-validity lookup, in milliseconds (`OWNER_VALIDITY_TIMEOUT_MS`). */
export const OWNER_VALIDITY_TIMEOUT_MS = 3000;

/** Positive integer up to the int4 ceiling, else the default (`boundedStatementTimeoutMs`). */
export const ownerValidityTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number =>
  boundedStatementTimeoutMs(env['OWNER_VALIDITY_TIMEOUT_MS'], OWNER_VALIDITY_TIMEOUT_MS);

/** The owner-validity lookup outlasted its time bound. The message is fixed: it never carries an id. */
export class OwnerValidityTimeoutError extends Error {
  constructor() {
    super('Owner validity lookup timed out');
    this.name = 'OwnerValidityTimeoutError';
  }
}

/** What the identity store answers a batched owner lookup with: the enabled users, and the ids with two user nodes. */
export interface OwnerLookup {
  users: ReadonlyMap<string, OwnerUser>;
  ambiguous: readonly string[];
}

export interface OwnerValidity {
  /** principal -> whether it resolves to an enabled user of the organization; a failed or timed-out lookup is false. */
  valid: ReadonlyMap<string, boolean>;
  /** The lookup's failure (the identity store's error, or OwnerValidityTimeoutError), at most one; every owner is then not valid. */
  failures: unknown[];
  /** The principals the identity store holds two user nodes for (an integrity alarm); each reads as not valid. */
  ambiguous: string[];
}

/**
 * Owner validity of every distinct non-null principal in `principals`, in one batched identity-store lookup
 * (`findEnabledUsers`: the enabled users among the ids, by id; a page repeats owners). A principal absent from the
 * result is not valid; the lookup's `ambiguous` ids are passed on in `ambiguous`. The lookup is bounded by `timeoutMs` (handed to it too, so the store can cancel); when it fails
 * or times out the error is recorded in `failures` and every owner reads as not valid. It never rejects.
 */
export async function readOwnerValidity(
  organizationId: string, principals: ReadonlyArray<string | null>,
  findEnabledUsers: (ids: string[], timeoutMs: number) => Promise<OwnerLookup>,
  timeoutMs: number = ownerValidityTimeoutMs()
): Promise<OwnerValidity> {
  const ids = [...new Set(principals.filter((principal): principal is string => principal !== null))];
  const valid = new Map<string, boolean>();
  if (ids.length === 0) {
    return { valid, failures: [], ambiguous: [] };
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const lookup = findEnabledUsers(ids, timeoutMs);
    // A lookup that loses the race may still reject later: that must not become an unhandled rejection.
    lookup.catch(() => undefined);
    const { users, ambiguous } = await Promise.race([
      lookup,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new OwnerValidityTimeoutError()), timeoutMs);
      }),
    ]);
    for (const id of ids) {
      valid.set(id, ownerInOrganization(users.get(id) ?? null, organizationId));
    }
    return { valid, failures: [], ambiguous: [...ambiguous] };
  } catch (error) {
    for (const id of ids) {
      valid.set(id, false);
    }
    return { valid, failures: [error], ambiguous: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** The C1 fields for `row`, added next to the stored columns of the service read. */
export function serviceReference(
  row: StoredServiceRow & {
    organization_id: string; owned_by: string | null; owner_principal_id: string | null;
    owner_group: string | null; version: number;
  },
  dependencies: StoredDependencyRow[],
  ownerValid: boolean
): C1ServiceReference {
  return {
    tenant_id: row.organization_id,
    owner: { principal_id: row.owner_principal_id, display_name: row.owned_by },
    owner_valid: ownerValid,
    owner_group: row.owner_group,
    criticality: row.business_criticality,
    lifecycle: row.lifecycle,
    version: row.version,
    dependencies: dependencies.map(dependency => ({
      service_id: dependency.service_id,
      name: dependency.name,
      criticality: dependency.business_criticality,
      lifecycle: dependency.lifecycle,
      dependency_type: dependency.dependency_type,
    })),
  };
}
