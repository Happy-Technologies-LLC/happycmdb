// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HP1 v16 §3–§4 journaled write contract: T1 (epoch + per-org cap + in-flight
 * slot) → plan under the slot → derived-plan validation → T1b → W (one
 * auto-commit Neo4j statement that also creates the :ReconciliationOp fences)
 * → T2 (org-stamped evidence + committed) → result. A W whose outcome is not
 * definitive leaves the group pending: the gap stays closed (409/503) until the
 * recovery sweep proves the fence outcome. No PG transaction spans a graph call.
 */
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { logger } from '@cmdb/common';
import { getPostgresClient } from '../postgres/client';
import { assertPlanRepresentable, dec, Encoded, PlanUnrepresentableError } from './encoding';

export type JournalOperation = 'update' | 'hold' | 'delete' | 'resolve_conflict' | 'direct_write' | 'relationship_write'
  | 'restore';
export type GraphPlanKind = 'create' | 'update' | 'restore' | 'delete' | 'relationship_create' | 'relationship_delete';

/** v16 §7.2 one review field of a hold; `supersedes` is the stale pending row it replaces (exact match). */
export interface ConflictPlan {
  id: string; field: string; source: string; sourceId: string; incoming: Encoded; target: Encoded;
  targetSource: string; contentHash: string; targetCorrelationId: string | null;
  supersedes?: { id: string; contentHash: string };
}

export interface StoredPlan {
  /** Null: no W and no fence (hold, accept_target, dismiss_stale); T1b records graph_effect=false. */
  graph: { kind: GraphPlanKind; label: string | null; params: Encoded } | null;
  /** Decided under the slot: a merge update whose pre-scan found a review field is a hold (v16 §7.2). */
  operation?: 'hold';
  /**
   * T2 history evidence (v16 §3.1): one org-stamped row for a merge `updated`,
   * a `deleted`, or a `dismiss_stale` `conflict_superseded`; a delete also purges
   * this incarnation's derived rows.
   */
  history?: {
    changeType: 'updated' | 'deleted' | 'conflict_superseded'; changedFields: string[]; source: string;
    previous: Encoded; next: Encoded | null; incarnationId: string | null;
  };
  /** T2 merge/resolve evidence, keyed by (organization, CI): typed field values, lineage, conflicts (v16 §7). */
  fields?: Array<{ name: string; value: Encoded; text: string; source: string }>;
  lineage?: { source: string; sourceId: string; confidence: number };
  conflicts?: ConflictPlan[];
  resolve?: { id: string; revision: string; status: 'resolved' | 'superseded'; action: string;
    suppressionHash: string | null; data: Encoded };
}

/** Graph runner for W and recovery: one auto-commit statement, records as plain objects. */
export type JournalGraphRunner = (query: string, params: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;

/** The caller's own (organization, CI) has a pending/failed operation: the gap 409. */
export class JournalGapError extends Error {
  constructor() { super('CI is temporarily unavailable'); }
}
/** 503: schema gate, cap, lock timeout or an unproven graph outcome (the gap stays closed). */
export class JournalUnavailableError extends Error {
  constructor(readonly correlationId?: string) { super('CI write temporarily unavailable'); }
}
/** Definitive not-applied with the target present (e.g. an identity collision). */
export class JournalAbortedError extends Error {
  constructor() { super('CI could not be reconciled'); }
}
/** The guarded target disappeared before W: fences_created = 0, aborted, no effect. */
export class JournalTargetMissingError extends Error {
  constructor() { super('CI not found'); }
}
/** v16 §7 conflict precondition refused under the slot (409); the journal row is aborted with the reason. */
export class JournalConflictError extends Error {
  constructor(readonly reason: 'pending_content' | 'stale_conflict' | 'revision_mismatch' | 'not_stale') { super(reason); }
}
export { PlanUnrepresentableError };

const MAX_INFLIGHT_PER_ORG = 1000;
const FENCE = `UNWIND $fences AS f CREATE (:ReconciliationOp {op_id: f.op_id, organization_id: $org,
  ci_id: f.ci_id, operation: f.operation, outcome: 'applied', created_at: datetime()})
  RETURN count(*) AS fences_created`;
/** v16 §4.1 W statements. Labels and relationship types are whitelisted by the caller. */
function wStatement(kind: GraphPlanKind, label: string | null): string {
  switch (kind) {
    case 'create': return `CREATE (ci:CI:${label}) SET ci = $props, ci.id = $id, ci.organization_id = $org,
      ci.created_at = datetime(), ci.updated_at = datetime() WITH ci ${FENCE}`;
    case 'update': return `MATCH (ci:CI {id: $id}) WHERE ci.organization_id = $org
      SET ci += $props, ci.updated_at = datetime() WITH ci ${FENCE}`;
    case 'restore': return `MATCH (ci:CI {id: $id}) WHERE ci.organization_id = $org SET ci += $props
      SET ci.created_at = coalesce($createdAt, ci.created_at),
          ci.discovered_at = coalesce($discoveredAt, ci.discovered_at), ci.updated_at = datetime()
      WITH ci ${FENCE}`;
    case 'delete': return `MATCH (ci:CI {id: $id}) WHERE ci.organization_id = $org
      WITH collect(ci) AS cs WHERE size(cs) = 1 UNWIND cs AS ci DETACH DELETE ci WITH 1 AS one ${FENCE}`;
    case 'relationship_create': return `MATCH (a:CI {id: $from}) WHERE a.organization_id = $org
      MATCH (b:CI {id: $to}) WHERE b.organization_id = $org MERGE (a)-[r:${label}]->(b)
      SET r += $props, r.created_at = coalesce(r.created_at, datetime()), r.updated_at = datetime()
      WITH DISTINCT 1 AS one ${FENCE}`;
    case 'relationship_delete': return `MATCH (a:CI {id: $from})-[r:${label}]->(b:CI {id: $to})
      WHERE a.organization_id = $org AND b.organization_id = $org
      WITH collect(r) AS rs WHERE size(rs) >= 1 UNWIND rs AS r DELETE r WITH DISTINCT 1 AS one ${FENCE}`;
  }
}

/** Deterministic test seam at the v16 §17 pause points; never set in production. */
export type JournalSeam = 'beforeW' | 'afterW' | 'beforeT2' | 'beforeFence';
let seam: ((point: JournalSeam, context: { groupId: string; recovery: boolean }) => Promise<void>) | undefined;
export function setJournalSeam(next: typeof seam): void { seam = next; }

/** PostgreSQL SQLSTATE or Neo4j status code of a driver error. */
function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}

let schemaReady = false;
let mergeReady = false;
/**
 * v16 §3.2 schema/fence gate, before any journal or data query of a journaled writer.
 * `merge` (merge, hold, resolve) also refuses the initdb variant whose lineage/field `ci_id` is uuid.
 */
export async function assertJournalSchema(graph: JournalGraphRunner, merge = false): Promise<void> {
  try {
    if (!schemaReady) {
      const pg = await getPostgresClient().pool.query(`SELECT
        to_regclass('public.ci_reconciliation_operations') IS NOT NULL
        AND to_regclass('public.ci_reconciliation_epochs') IS NOT NULL
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ci_change_history_organization_required')
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ci_field_sources_organization_required')
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'cmdb'
                    AND table_name = 'dim_ci' AND column_name = 'org_backfilled') AS ready`);
      const fence = await graph(`SHOW CONSTRAINTS YIELD name WHERE name = 'reconciliation_op_fence_unique'
        RETURN count(*) AS present`, {});
      schemaReady = pg.rows[0]?.ready === true && Number(fence[0]?.['present']) === 1;
    }
    if (schemaReady && merge && !mergeReady) {
      const ids = await getPostgresClient().pool.query(`SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('ci_source_lineage', 'ci_field_sources')
          AND column_name = 'ci_id' AND data_type = 'character varying'`);
      mergeReady = ids.rows[0]?.n === 2;
    }
  } catch {
    schemaReady = mergeReady = false;
  }
  if (!schemaReady || (merge && !mergeReady)) throw new JournalUnavailableError();
}

function schemaFault(error: unknown): void {
  const code = errorCode(error);
  if (code === '42P01' || code === '42703' ||
    (code.startsWith('Neo.ClientError.Schema.') && !code.endsWith('ConstraintValidationFailed'))) schemaReady = mergeReady = false;
}

interface Slot { id: string; ciId: string; operation: JournalOperation }

/**
 * v16 §5.1 F7/F8 per-org admission lock. A tuple FOR SHARE on the epoch row
 * overtakes a queued T1 UPDATE (operator probe 12/12), so readers take this
 * heavyweight advisory lock shared and T1 exclusive: a new shared request queues
 * behind a waiting exclusive one. 64-bit key with a dedicated seed; two orgs whose
 * keys collide only wait on each other (availability, never correctness).
 */
export const ADMISSION_LOCK_KEY = 'hashtextextended($1::text, 4431)';
/** T1 records graph_effect=true; T1b (before any W) sets the final operation and graph_effect from the plan. */
async function t1(organizationId: string, actor: string, groupId: string, slots: Slot[]): Promise<void> {
  await getPostgresClient().transaction(async client => {
    await client.query(`SET LOCAL lock_timeout = '12s'`);
    // F8': queued here, T1 blocks newly arriving own-org admission readers (their shared lock waits behind it).
    await client.query(`SELECT pg_advisory_xact_lock(${ADMISSION_LOCK_KEY})`, [organizationId]);
    await client.query(`INSERT INTO ci_reconciliation_epochs (organization_id, epoch) VALUES ($1, 0)
      ON CONFLICT (organization_id) DO NOTHING`, [organizationId]);
    const epoch = await client.query(`UPDATE ci_reconciliation_epochs SET epoch = epoch + 1
      WHERE organization_id = $1 RETURNING epoch`, [organizationId]);
    const inflight = await client.query(`SELECT count(*)::int AS n FROM ci_reconciliation_operations
      WHERE organization_id = $1 AND state IN ('pending', 'failed')`, [organizationId]);
    if (inflight.rows[0].n + slots.length > MAX_INFLIGHT_PER_ORG) throw new JournalUnavailableError();
    for (const slot of slots) {
      await client.query(`INSERT INTO ci_reconciliation_operations (id, group_id, organization_id, ci_id, origin,
          operation, graph_effect, state, actor, epoch, plan, lease_expires_at)
        VALUES ($1, $2, $3, $4, 'api', $5, true, 'pending', $6, $7, NULL, now() + interval '30 seconds')`,
        [slot.id, groupId, organizationId, slot.ciId, slot.operation, actor, epoch.rows[0].epoch]);
    }
  });
}

async function abortGroup(groupId: string, reason: string): Promise<void> {
  await getPostgresClient().pool.query(`UPDATE ci_reconciliation_operations
    SET state = 'aborted', plan = NULL, claim_token = NULL, last_error = $2, updated_at = now()
    WHERE group_id = $1 AND state = 'pending'`, [groupId, reason]);
}

/** T2 evidence; idempotent under the history correlation key. */
async function writeEvidence(client: PoolClient, row: { group_id: string; organization_id: string; ci_id: string;
  actor: string; plan: StoredPlan }): Promise<void> {
  const { plan, organization_id: org, ci_id: ci, group_id: group, actor } = row;
  for (const field of plan.fields ?? []) {
    await client.query(`INSERT INTO ci_field_sources (organization_id, ci_id, field_name, field_value, value_json,
        source_name, last_correlation_id, updated_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now())
      ON CONFLICT (organization_id, ci_id, field_name) DO UPDATE SET field_value = EXCLUDED.field_value,
        value_json = EXCLUDED.value_json, source_name = EXCLUDED.source_name,
        last_correlation_id = EXCLUDED.last_correlation_id, updated_at = now()`,
    [org, ci, field.name, field.text, JSON.stringify(field.value), field.source, group]);
  }
  if (plan.lineage) {
    await client.query(`INSERT INTO ci_source_lineage (organization_id, ci_id, source_name, source_id, confidence_score,
        last_correlation_id, last_seen_at) VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (organization_id, ci_id, source_name, source_id) DO UPDATE SET
        confidence_score = EXCLUDED.confidence_score, last_correlation_id = EXCLUDED.last_correlation_id, last_seen_at = now()`,
    [org, ci, plan.lineage.source, plan.lineage.sourceId, Math.round(plan.lineage.confidence), group]);
  }
  const exactlyOne = (count: number | null) => {
    if (count !== 1) throw Object.assign(new Error('conflict lifecycle mismatch'), { code: 'HP1CF' });
  };
  for (const conflict of plan.conflicts ?? []) {
    if (conflict.supersedes) {
      exactlyOne((await client.query(`UPDATE reconciliation_conflicts SET status = 'superseded', superseded_by = $3,
          resolution_correlation_id = $4, resolved_at = now()
        WHERE id = $1 AND organization_id = $5 AND ci_id = $6 AND status = 'pending' AND content_hash = $2`,
      [conflict.supersedes.id, conflict.supersedes.contentHash, conflict.id, group, org, ci])).rowCount);
    }
    await client.query(`INSERT INTO reconciliation_conflicts (id, organization_id, ci_id, conflict_type, source_data,
        target_data, conflicting_fields, field_name, source_name, source_id, incoming_json, target_json,
        target_source_name, content_hash, target_field_correlation_id, detected_by, correlation_id)
      VALUES ($1, $2, $3, 'field_conflict', $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10::jsonb, $11::jsonb,
        $12, $13, $14, $15, $16)`,
    [conflict.id, org, ci, JSON.stringify({ source_name: conflict.source, source_id: conflict.sourceId, value: conflict.incoming }),
      JSON.stringify({ source_name: conflict.targetSource, value: conflict.target }), JSON.stringify([conflict.field]),
      conflict.field, conflict.source, conflict.sourceId, JSON.stringify(conflict.incoming), JSON.stringify(conflict.target),
      conflict.targetSource, conflict.contentHash, conflict.targetCorrelationId, actor, group]);
  }
  if (plan.resolve) {
    exactlyOne((await client.query(`UPDATE reconciliation_conflicts SET status = $3, resolution_action = $4,
        resolved_by = $5, resolved_at = now(), suppression_hash = $6, resolution_correlation_id = $7, resolution_data = $8::jsonb
      WHERE id = $1 AND organization_id = $9 AND ci_id = $10 AND status = 'pending' AND content_hash = $2`,
    [plan.resolve.id, plan.resolve.revision, plan.resolve.status, plan.resolve.action, actor, plan.resolve.suppressionHash,
      group, JSON.stringify(plan.resolve.data), org, ci])).rowCount);
  }
  const history = row.plan.history;
  if (!history) return;
  await client.query(`INSERT INTO ci_change_history (ci_id, change_type, changed_by, change_source, changed_fields,
      previous_values, new_values, ci_incarnation_id, organization_id, correlation_id)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::uuid, $9, $10)
    ON CONFLICT (correlation_id) DO NOTHING`,
  [row.ci_id, history.changeType, row.actor, history.source, history.changedFields, JSON.stringify(history.previous),
    history.next === null ? null : JSON.stringify(history.next), history.incarnationId, row.organization_id, row.group_id]);
  if (history.changeType !== 'deleted') return;
  for (const [table, column] of [['drift_detection_results', 'ci_id'], ['baseline_snapshots', 'ci_id'],
    ['impact_analyses', 'source_ci_id'], ['ci_criticality_scores', 'ci_id']] as const) {
    await client.query(`DELETE FROM ${table} WHERE ${column} = $1
      AND (ci_incarnation_id = $2::uuid OR ci_incarnation_id IS NULL)`, [row.ci_id, history.incarnationId]);
  }
}

/** Returns true when this call or an earlier one committed the group. */
async function t2(groupId: string, recovery: boolean, claimToken?: string): Promise<boolean> {
  await seam?.('beforeT2', { groupId, recovery });
  return getPostgresClient().transaction(async client => {
    const rows = (await client.query(`SELECT id, group_id, organization_id, ci_id, actor, state, plan, claim_token
      FROM ci_reconciliation_operations WHERE group_id = $1 ORDER BY organization_id, ci_id FOR UPDATE`, [groupId])).rows;
    if (rows.every(row => row.state === 'committed')) return true;
    if (rows.some(row => row.state !== 'pending') ||
      (claimToken !== undefined && !rows.some(row => row.claim_token === claimToken))) return false;
    if (rows.some(row => row.plan === null)) throw Object.assign(new Error('journal plan missing'), { code: 'HP1PL' });
    await writeEvidence(client, rows[0]);
    await client.query(`UPDATE ci_reconciliation_operations SET state = 'committed', plan = NULL,
      claim_token = NULL, updated_at = now() WHERE group_id = $1`, [groupId]);
    return true;
  });
}

export interface JournaledWrite<T> {
  organizationId: string;
  actor: string;
  operation: JournalOperation;
  ciIds: string[];
  /** Runs under the slot; may throw JournalTargetMissingError, PlanUnrepresentableError or JournalConflictError. */
  plan: () => Promise<StoredPlan>;
  /** After T2; `groupId` is the request correlation id. */
  result: (groupId: string) => Promise<T>;
}

export class ReconciliationJournal {
  constructor(private readonly graph: JournalGraphRunner) {}

  async run<T>(write: JournaledWrite<T>): Promise<T> {
    await assertJournalSchema(this.graph, write.operation === 'update' || write.operation === 'resolve_conflict');
    const groupId = randomUUID();
    const slots = [...new Set(write.ciIds)].sort().map(ciId => ({ id: randomUUID(), ciId, operation: write.operation }));
    await this.reserve(write, groupId, slots);
    let plan: StoredPlan;
    let params: Record<string, unknown>;
    try {
      plan = await write.plan();
      assertPlanRepresentable(plan as unknown as Encoded);
      // Decoded before W: an undecodable value is a definitive 422, never an unproven W.
      try { params = plan.graph ? dec(plan.graph.params) as Record<string, unknown> : {}; } catch { throw new PlanUnrepresentableError(); }
    } catch (error) {
      await abortGroup(groupId, error instanceof PlanUnrepresentableError ? 'plan_unrepresentable'
        : error instanceof JournalTargetMissingError ? 'target_missing'
        : error instanceof JournalConflictError ? error.reason : 'plan_failed');
      schemaFault(error);
      throw error;
    }
    const lease = await getPostgresClient().pool.query(`UPDATE ci_reconciliation_operations
      SET plan = $2::jsonb, operation = coalesce($3, operation), graph_effect = $4,
        lease_expires_at = now() + interval '30 seconds', updated_at = now()
      WHERE group_id = $1 AND state = 'pending'
      RETURNING lease_expires_at - clock_timestamp() >= interval '20 seconds' AS sendable`,
      [groupId, JSON.stringify(plan), plan.operation ?? null, plan.graph !== null]);
    if (lease.rows.length !== slots.length || !lease.rows.every(row => row.sendable)) {
      await abortGroup(groupId, 'lease_expired');
      throw new JournalUnavailableError(groupId);
    }
    const fences = slots.map(slot => ({ op_id: slot.id, ci_id: slot.ciId, operation: slot.operation }));
    let created = fences.length;
    if (plan.graph) try {
      await seam?.('beforeW', { groupId, recovery: false });
      const records = await this.graph(wStatement(plan.graph.kind, plan.graph.label),
        { ...params, org: write.organizationId, fences });
      await seam?.('afterW', { groupId, recovery: false });
      created = Number(records[0]?.['fences_created'] ?? 0);
    } catch (error) {
      if (errorCode(error) === 'Neo.ClientError.Schema.ConstraintValidationFailed') {
        await abortGroup(groupId, 'constraint');
        throw new JournalAbortedError();
      }
      schemaFault(error);
      logger.warn('HP1 W outcome unproven; left pending for recovery', { correlation_id: groupId });
      throw new JournalUnavailableError(groupId);
    }
    if (created === 0) {
      await abortGroup(groupId, 'target_missing');
      throw new JournalTargetMissingError();
    }
    if (created !== fences.length) {
      await getPostgresClient().pool.query(`UPDATE ci_reconciliation_operations SET state = 'failed',
        last_error = 'fence_count', updated_at = now() WHERE group_id = $1 AND state = 'pending'`, [groupId]);
      logger.error('HP1 W fence count mismatch', { correlation_id: groupId });
      throw new JournalUnavailableError(groupId);
    }
    try {
      if (!(await t2(groupId, false))) throw new JournalUnavailableError(groupId);
    } catch (error) {
      schemaFault(error);
      throw error instanceof JournalUnavailableError ? error : new JournalUnavailableError(groupId);
    }
    return write.result(groupId);
  }

  private async reserve(write: JournaledWrite<unknown>, groupId: string, slots: Slot[]): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await t1(write.organizationId, write.actor, groupId, slots);
      } catch (error) {
        schemaFault(error);
        if (errorCode(error) === '55P03') throw new JournalUnavailableError();
        if (errorCode(error) !== '23505') throw error;
        // Inspect the holder outside any transaction; recover an expired one once.
        const holder = await getPostgresClient().pool.query(`SELECT id FROM ci_reconciliation_operations
          WHERE organization_id = $1 AND ci_id = ANY($2::text[]) AND state = 'pending'
            AND lease_expires_at + interval '20 seconds' < now()`, [write.organizationId, slots.map(s => s.ciId)]);
        if (attempt > 0 || holder.rows.length === 0) throw new JournalGapError();
        for (const row of holder.rows) await this.sweep(row.id);
      }
    }
  }

  /** v16 §4.3 recovery: claim in a short transaction, MERGE the fence outside it, decide on the claim. */
  async sweep(onlyId?: string): Promise<number> {
    const token = randomUUID();
    const claimed = (await getPostgresClient().pool.query(`UPDATE ci_reconciliation_operations
      SET claim_token = $1, lease_expires_at = now() + interval '60 seconds', attempts = attempts + 1, updated_at = now()
      WHERE id IN (SELECT id FROM ci_reconciliation_operations WHERE state = 'pending'
                   AND lease_expires_at + interval '20 seconds' < now() AND ($2::uuid IS NULL OR id = $2::uuid)
                   ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED LIMIT 50)
      RETURNING id, group_id, organization_id, ci_id, operation, graph_effect, plan IS NULL AS plan_missing`,
      [token, onlyId ?? null])).rows;
    for (const row of claimed) {
      const decide = (state: 'aborted' | 'failed', reason: string) => getPostgresClient().pool.query(
        `UPDATE ci_reconciliation_operations SET state = $3::varchar, last_error = $4, claim_token = NULL,
           plan = CASE WHEN $3::varchar = 'aborted' THEN NULL ELSE plan END, updated_at = now()
         WHERE group_id = $1 AND state = 'pending'
           AND EXISTS (SELECT 1 FROM ci_reconciliation_operations WHERE id = $2 AND claim_token = $5)`,
        [row.group_id, row.id, state, reason, token]);
      // v16 §4.3: graph_effect=false (hold, accept_target, dismiss_stale) never had a W or fence: T2 decides.
      let outcome: Record<string, unknown> | undefined = row.graph_effect ? undefined
        : { outcome: 'applied', org: row.organization_id, ci: row.ci_id, operation: row.operation };
      if (row.graph_effect) try {
        await seam?.('beforeFence', { groupId: row.group_id, recovery: true });
        outcome = (await this.graph(`MERGE (op:ReconciliationOp {op_id: $op}) ON CREATE SET
            op.organization_id = $org, op.ci_id = $ci, op.operation = $operation, op.outcome = 'aborted',
            op.created_at = datetime()
          RETURN op.outcome AS outcome, op.organization_id AS org, op.ci_id AS ci, op.operation AS operation`,
          { op: row.id, org: row.organization_id, ci: row.ci_id, operation: row.operation }))[0];
      } catch {
        await getPostgresClient().pool.query(`UPDATE ci_reconciliation_operations SET claim_token = NULL,
            lease_expires_at = now() + make_interval(secs => LEAST(power(2, attempts) * 15, 900)), updated_at = now()
          WHERE id = $1 AND claim_token = $2`, [row.id, token]);
        continue;
      }
      if (!outcome || outcome['org'] !== row.organization_id || outcome['ci'] !== row.ci_id ||
        outcome['operation'] !== row.operation) {
        await decide('failed', 'fence_mismatch');
        logger.error('HP1 recovery fence mismatch', { correlation_id: row.group_id });
      } else if (outcome['outcome'] === 'aborted') {
        await decide('aborted', 'fence_aborted');
      } else if (row.plan_missing) {
        await decide('failed', 'plan_missing');
      } else {
        try {
          await t2(row.group_id, true, token);
        } catch (error) {
          if (['08', '40', '53', '57'].includes(errorCode(error).slice(0, 2))) {
            await getPostgresClient().pool.query(`UPDATE ci_reconciliation_operations SET claim_token = NULL,
                lease_expires_at = now() + make_interval(secs => LEAST(power(2, attempts) * 15, 900))
              WHERE id = $1 AND claim_token = $2`, [row.id, token]);
          } else {
            await decide('failed', 't2_failed');
            logger.error('HP1 recovery T2 failed permanently', { correlation_id: row.group_id });
          }
        }
      }
    }
    return claimed.length;
  }
}

/** Reviewed corrective replay only (v16 §3.4): failed → pending, then the sweep decides from the fence. */
export async function requeueFailedJournalGroup(opId: string): Promise<number> {
  const result = await getPostgresClient().pool.query(`UPDATE ci_reconciliation_operations
    SET state = 'pending', claim_token = NULL, lease_expires_at = now() - interval '1 minute', updated_at = now()
    WHERE group_id = (SELECT group_id FROM ci_reconciliation_operations WHERE id = $1) AND state = 'failed'`, [opId]);
  return result.rowCount ?? 0;
}
