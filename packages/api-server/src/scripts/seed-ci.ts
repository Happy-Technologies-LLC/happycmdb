// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/**
 * HAP-1530 (PORT S7): the journaled seed tool for configuration items.
 *
 * Seeds SEED_CIS, the dependency CI of the CO-1 internal portfolio's "Access request fulfilment" (migration 042), so
 * `/context` of that service serves a CI node and its MAPPED_CI edge. A CI is created only through
 * Neo4jClient.createCI: one journaled direct_write op with its HAP-784 audit row, never a bare graph write (operator
 * ruling 2026-11-02: option B; option C, an unjournaled Neo4j migration, is rejected). The CI's cmdb.dim_ci row is then
 * loaded by the ETL job's own batch step, and the mapping is written by BusinessServiceController.mapCIsToService, so
 * the tool holds no copy of either.
 *
 * It runs in the api-server's own environment (POSTGRES_*, NEO4J_*, AUDIT_CHAIN_KEY): as the app login, with the audit
 * chain key the API verifies with. Idempotent: a CI already in the graph is not created again (no second journal op or
 * audit row); the dim_ci sync then adds no version and the mapping upsert no row.
 *
 * Target guard, before any connection: `--target scratch` needs NODE_ENV other than production, a loopback
 * POSTGRES_HOST and a direct bolt:// loopback NEO4J_URI, and then both stores must carry the CO-1 tenant-fixture
 * markers. Any other target is refused unless `--founder-approval approvals/founder-<id>.go` names the approval.
 *
 * Usage: node seed-ci.js --target scratch
 *        node seed-ci.js --target <name> --founder-approval approvals/founder-<id>.go
 * Prints one JSON summary line on stdout; exits 0, or 1 with the reason on stderr.
 */
import type { CIType, Environment } from '@cmdb/common';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import type { Request, Response } from 'express';

import { extractedCI, Neo4jToPostgresJob } from '../../../etl-processor/src/jobs/neo4j-to-postgres.job';
import { withDimCiIds } from '../../../etl-processor/src/transformers/ci-organization';
import { assertNoCIGap, CIGapError } from '../read-admission';
import { BusinessServiceController } from '../rest/controllers/business-service.controller';

import { inspectGraph, inspectPostgres, LOOPBACK_HOSTS } from './seed-tenant-fixture';

export interface SeedCI {
  id: string;
  name: string;
  type: CIType;
  environment: Environment;
  organizationId: string;
  serviceId: string;
  mappingType: 'hosts' | 'supports' | 'enables' | 'provides';
}

/** The CO-1 seed. The fixed id is what makes a re-run find the CI it seeded before. */
export const SEED_CIS: readonly SeedCI[] = [{
  id: '5e7d1c3a-9b42-4f6e-8a15-3c0d2b7e9f41',
  name: 'Access request workflow engine',
  type: 'application',
  environment: 'production',
  organizationId: '00000000-0000-0000-0000-000000000000',
  serviceId: 'bs-11ab0f28-85c8-4494-b220-e90758c6219a',
  mappingType: 'supports',
}];

/** The journal actor of the seeded CI's direct_write op and audit row. */
export const SEED_ACTOR = 'seed-ci';
const ETL_JOB = 'seed-ci';

export class TargetRefusedError extends Error {}

export interface SeedArgs {
  target: string;
  founderApproval: string | null;
}

export function parseArgs(argv: readonly string[]): SeedArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const [name, value] = [argv[index]!, argv[index + 1]];
    if (!['--target', '--founder-approval'].includes(name) || value === undefined || value.startsWith('--') || values.has(name)) {
      throw new Error(`usage: --target scratch | --target <name> --founder-approval approvals/founder-<id>.go (bad argument ${name})`);
    }
    values.set(name, value);
  }
  const target = values.get('--target');
  if (target === undefined) {
    throw new Error('--target is required');
  }
  return { target, founderApproval: values.get('--founder-approval') ?? null };
}

const FOUNDER_APPROVAL = /^approvals\/founder-[A-Za-z0-9][A-Za-z0-9._-]*\.go$/;

/** The target guard: runs before any connection; `approved` only with a founder-approval reference. */
export function assertTarget(args: SeedArgs, env: NodeJS.ProcessEnv): 'scratch' | 'approved' {
  if (args.target !== 'scratch') {
    if (args.founderApproval === null) {
      throw new TargetRefusedError(
        `refusing target "${args.target}": only --target scratch runs without --founder-approval approvals/founder-<id>.go`);
    }
    if (!FOUNDER_APPROVAL.test(args.founderApproval)) {
      throw new TargetRefusedError('--founder-approval must name a founder approval file: approvals/founder-<id>.go');
    }
    return 'approved';
  }
  if (args.founderApproval !== null) {
    throw new TargetRefusedError('--founder-approval applies to a non-scratch target only');
  }
  if (env['NODE_ENV'] === 'production') {
    throw new TargetRefusedError('refusing --target scratch with NODE_ENV=production');
  }
  if (!LOOPBACK_HOSTS.has(env['POSTGRES_HOST'] ?? '')) {
    throw new TargetRefusedError('refusing --target scratch: POSTGRES_HOST is not a loopback host');
  }
  let neo4jUri: URL | null = null;
  try {
    neo4jUri = new URL(env['NEO4J_URI'] ?? '');
  } catch {
    // refused below
  }
  if (neo4jUri?.protocol !== 'bolt:' || !LOOPBACK_HOSTS.has(neo4jUri.hostname)) {
    throw new TargetRefusedError('refusing --target scratch: NEO4J_URI is not a direct bolt:// loopback URI');
  }
  return 'scratch';
}

export interface SeededCI {
  ci_id: string;
  service_id: string;
  organization_id: string;
  /** false on a re-run: the CI was already there and nothing was journaled. */
  created: boolean;
  journal_committed: number;
  audit_rows: number;
}

async function seedOne(ci: SeedCI): Promise<SeededCI> {
  const [postgres, neo4j] = [getPostgresClient(), getNeo4jClient()];
  const service = await postgres.query(
    'SELECT 1 FROM dim_business_services WHERE service_id = $1 AND organization_id = $2', [ci.serviceId, ci.organizationId]);
  if (service.rows.length === 0) {
    throw new Error(`business service ${ci.serviceId} is not in organization ${ci.organizationId}`);
  }
  // A pending or failed op on the CI is the journal's to finish (its sweeper): seeding beside it could double the create.
  await assertNoCIGap(ci.organizationId, ci.id).catch((error: unknown) => {
    throw error instanceof CIGapError ? new Error(`CI ${ci.id} has a pending or failed journal op; re-run once it is finished`) : error;
  });
  const existing = await neo4j.getCI(ci.id, ci.organizationId);
  if (existing !== null && (existing.name !== ci.name || existing._type !== ci.type)) {
    throw new Error(`CI ${ci.id} exists with another name or type; the seed never changes a CI`);
  }
  if (existing === null) {
    await neo4j.createCI({ _id: ci.id, name: ci.name, _type: ci.type, environment: ci.environment, status: 'active' },
      ci.organizationId, SEED_ACTOR);
  }
  // The ETL job's own batch step loads the CI's cmdb.dim_ci row (SCD 2: an unchanged CI adds no version).
  const session = neo4j.getSession();
  let props: Record<string, unknown> | undefined;
  try {
    const result = await session.run(
      'MATCH (ci:CI {id: $id}) WHERE ci.organization_id = $organizationId RETURN properties(ci) AS props',
      { id: ci.id, organizationId: ci.organizationId });
    const record = result.records[0];
    // properties() of a node is a property map.
    props = record === undefined ? undefined : record.get('props') as Record<string, unknown>;
  } finally {
    await session.close();
  }
  const extracted = props === undefined ? null : extractedCI(props, ETL_JOB);
  if (extracted === null) {
    throw new Error(`CI ${ci.id} is not readable in organization ${ci.organizationId}`);
  }
  const loaded = await new Neo4jToPostgresJob(neo4j, postgres)
    .processBatch(withDimCiIds([extracted], row => row._id, ETL_JOB), false, ETL_JOB);
  if (loaded.cisProcessed !== 1) {
    throw new Error(`cmdb.dim_ci sync of CI ${ci.id} failed`);
  }
  await mapToService(ci);
  const evidence = await postgres.query(`SELECT
      (SELECT count(*)::int FROM ci_reconciliation_operations WHERE organization_id = $1 AND ci_id = $2
        AND operation = 'direct_write' AND state = 'committed') AS journal_committed,
      (SELECT count(*)::int FROM audit_log WHERE organization_id = $1 AND entity_type = 'CI' AND entity_id = $2) AS audit_rows`,
  [ci.organizationId, ci.id]);
  const [facts] = evidence.rows as Array<{ journal_committed: number; audit_rows: number }>; // one row of two counts
  return {
    ci_id: ci.id, service_id: ci.serviceId, organization_id: ci.organizationId, created: existing === null,
    journal_committed: facts!.journal_committed, audit_rows: facts!.audit_rows,
  };
}

/** The mapping goes through the API's own handler (its gap, ownership and dim_ci checks), not a copy of its SQL. */
async function mapToService(ci: SeedCI): Promise<void> {
  const reply = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) {
      reply.status = code;
      return res;
    },
    json(body: unknown) {
      reply.body = body;
      return res;
    },
  };
  const req = {
    params: { service_id: ci.serviceId },
    body: { ci_ids: [ci.id], mapping_type: ci.mappingType, confidence_score: 1 },
    user: { _userId: SEED_ACTOR, _organizationId: ci.organizationId },
  };
  await new BusinessServiceController().mapCIsToService(req as unknown as Request, res as unknown as Response);
  if (reply.status !== 201) {
    throw new Error(`mapping CI ${ci.id} to ${ci.serviceId} was refused (${reply.status}: ${JSON.stringify(reply.body)})`);
  }
}

export async function seedCIs(target: 'scratch' | 'approved'): Promise<SeededCI[]> {
  if (target === 'scratch') {
    const stores = [await inspectPostgres(getPostgresClient()), await inspectGraph(getNeo4jClient())];
    if (stores.some(state => state !== 'fixture')) {
      throw new TargetRefusedError(`refusing --target scratch: the stores are not the CO-1 tenant fixture (${stores.join(', ')})`);
    }
  }
  const seeded: SeededCI[] = [];
  for (const ci of SEED_CIS) {
    seeded.push(await seedOne(ci));
  }
  return seeded;
}

export async function main(
  argv: readonly string[],
  io: { stdout: (line: string) => void; stderr: (line: string) => void }
): Promise<number> {
  try {
    const args = parseArgs(argv);
    const target = assertTarget(args, process.env);
    const cis = await seedCIs(target);
    io.stdout(JSON.stringify({ target: args.target, founder_approval: args.founderApproval, cis }));
    return 0;
  } catch (error) {
    io.stderr(`seed-ci: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (require.main === module) {
  // stdout is reserved for the JSON summary; everything else that writes to stdout goes to stderr.
  const writeSummary = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr);
  // Explicit exit: the drivers and the BullMQ Redis connection the @cmdb/database barrel opens stay alive otherwise.
  void main(process.argv.slice(2), {
    stdout: line => writeSummary(`${line}\n`),
    stderr: line => process.stderr.write(`${line}\n`),
  }).then(code => process.exit(code));
}
