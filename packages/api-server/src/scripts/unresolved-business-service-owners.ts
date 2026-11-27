// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Report of the business services whose stored owner does not resolve, per organization. MANUAL OPERATOR ACTION,
 * READ ONLY: it writes nothing and fixes nothing.
 *
 * A service's owner_principal_id is the D15 approver of a tier change. The owner writes check it once, when it is
 * set; a user disabled, deleted or moved to another organization later leaves the service naming a principal an
 * approval cannot be routed to (the C1 read says so as owner_valid: false). This lists those services so an admin can
 * name a valid owner on each (PATCH owner_principal_id).
 *
 * An owner resolves under the API's own rule: exactly one User node carries the id (either property spelling), it is
 * enabled, and its organization is the service's. Reasons:
 *   unknown              no User node has the id
 *   disabled             the node is not enabled
 *   other_organization   the node belongs to another organization
 *   no_organization      the node has no organization
 *   ambiguous_identity   more than one distinct node has the id
 *   no_owner             a live or retiring service without owner_principal_id
 *
 * Read-only by construction: the PostgreSQL statement runs in a READ ONLY transaction (the server refuses a write),
 * and the graph statement is one MATCH ... RETURN on a session opened with defaultAccessMode READ (operator-stores.ts
 * graphOf().read: the server refuses a write Cypher); the report depends on neither store's writer.
 * If either store cannot be read, nothing is printed and the exit status is 1: a partial report would read as "the
 * rest is fine".
 *
 * Connections come only from the CMDB_ROTATE_* variables of the other operator scripts (a read-only login is enough).
 * Build with `npm run build:tenant-fixture --workspace=packages/api-server`, then:
 *   node dist/tenant-fixture/api-server/src/scripts/unresolved-business-service-owners.js
 * Prints one JSON object: { checked, unresolved, organizations: [{ organization_id, services: [...] }] }.
 *
 * OPERATOR-CONFIDENTIAL OUTPUT: stdout holds every organization's service names and owner principal ids. Never attach
 * it to a ticket or a pull request.
 */

import { lifecycleNeedsOwner, ownerInOrganization, type C1Lifecycle } from '../services/business-service-reference';

import { redactSecrets } from './identity-window';
import { openOperatorStores, type OperatorStores } from './operator-stores';
import { isolateOperatorEnvironment } from './operator-tls';
import type { RotationGraph, RotationSql } from './rotate-user-password';

export const OWNED_SERVICES_SQL =
  'SELECT organization_id, service_id, name, lifecycle, owner_principal_id FROM dim_business_services ORDER BY organization_id, service_id';

/** Every User node carrying one of the ids, by either property spelling (the API's FIND_USER_BY_ID_CYPHER, batched). */
export const OWNER_USERS_CYPHER = `
UNWIND $ids AS id
MATCH (u:User) WHERE u._id = id OR u.id = id
RETURN id, elementId(u) AS node, coalesce(u._enabled, u.enabled) AS enabled, coalesce(u._organizationId, u.organizationId) AS organization_id`;

const LOOKUP_BATCH = 500;

export type UnresolvedReason =
  | 'unknown' | 'disabled' | 'other_organization' | 'no_organization' | 'ambiguous_identity' | 'no_owner';

export interface UnresolvedService {
  service_id: string;
  name: string;
  lifecycle: C1Lifecycle;
  owner_principal_id: string | null;
  reason: UnresolvedReason;
}

export interface OwnerReport {
  /** Services read. */
  checked: number;
  /** Services listed. */
  unresolved: number;
  organizations: Array<{ organization_id: string; services: UnresolvedService[] }>;
}

interface StoredService {
  organization_id: string;
  service_id: string;
  name: string;
  lifecycle: C1Lifecycle;
  owner_principal_id: string | null;
}

interface FoundUser {
  node: string;
  enabled: unknown;
  organization_id: unknown;
}

/** Why `owner` does not resolve in `organizationId`, or null when it does. */
function unresolvedReason(found: FoundUser[] | undefined, organizationId: string): UnresolvedReason | null {
  if (found === undefined || found.length === 0) return 'unknown';
  if (new Set(found.map(user => user.node)).size > 1) return 'ambiguous_identity';
  const user = found[0]!;
  // The API's findEnabledUser: a falsy _enabled is a disabled user.
  if (!user.enabled) return 'disabled';
  const organization = typeof user.organization_id === 'string' ? user.organization_id : undefined;
  if (organization === undefined) return 'no_organization';
  return ownerInOrganization({ _organizationId: organization }, organizationId) ? null : 'other_organization';
}

/** Lists every service whose owner does not resolve. Takes only the read halves of the stores. */
export async function reportUnresolvedOwners(
  sql: Pick<RotationSql, 'transaction'>, graph: Pick<RotationGraph, 'read'>
): Promise<OwnerReport> {
  const services = await sql.transaction(async client => {
    // The server refuses any write of this transaction.
    await client.query('SET TRANSACTION READ ONLY');
    return (await client.query(OWNED_SERVICES_SQL)).rows as unknown as StoredService[];
  });

  const ids = [...new Set(services.flatMap(service => (service.owner_principal_id ? [service.owner_principal_id] : [])))];
  const users = new Map<string, FoundUser[]>();
  for (let from = 0; from < ids.length; from += LOOKUP_BATCH) {
    for (const row of await graph.read(OWNER_USERS_CYPHER, { ids: ids.slice(from, from + LOOKUP_BATCH) })) {
      const id = String(row['id']);
      users.set(id, [...(users.get(id) ?? []), { node: String(row['node']), enabled: row['enabled'], organization_id: row['organization_id'] }]);
    }
  }

  const byOrganization = new Map<string, UnresolvedService[]>();
  let unresolved = 0;
  for (const service of services) {
    const reason: UnresolvedReason | null = service.owner_principal_id
      ? unresolvedReason(users.get(service.owner_principal_id), service.organization_id)
      : lifecycleNeedsOwner(service.lifecycle) ? 'no_owner' : null;
    if (reason === null) continue;
    unresolved++;
    byOrganization.set(service.organization_id, [...(byOrganization.get(service.organization_id) ?? []), {
      service_id: service.service_id, name: service.name, lifecycle: service.lifecycle,
      owner_principal_id: service.owner_principal_id, reason,
    }]);
  }
  return {
    checked: services.length,
    unresolved,
    organizations: [...byOrganization].map(([organization_id, listed]) => ({ organization_id, services: listed })),
  };
}

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: { stdout: (line: string) => void; stderr: (line: string) => void }
): Promise<number> {
  let stores: OperatorStores | undefined;
  try {
    if (argv.length > 0) {
      throw new Error('usage: unresolved-business-service-owners (no arguments; connections from CMDB_ROTATE_* variables)');
    }
    stores = openOperatorStores(env);
    io.stdout(JSON.stringify(await reportUnresolvedOwners(stores.sql, stores.graph)));
    return 0;
  } catch (error) {
    io.stderr(`unresolved-business-service-owners: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    return 1;
  } finally {
    await stores?.close();
  }
}

if (require.main === module) {
  isolateOperatorEnvironment(process.env);
  const writeLine = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr);
  void main(process.argv.slice(2), process.env, {
    stdout: line => writeLine(`${line}\n`),
    stderr: line => process.stderr.write(`${line}\n`),
  }).then(code => process.exit(code));
}
