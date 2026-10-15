// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type { Request, Response } from 'express';
import { GraphQLError } from 'graphql';
import { getPostgresClient } from '@cmdb/database';
import { ITILController } from '../../rest/controllers/itil.controller';
import { checkGraphQLPermission } from '../../middleware/auth.middleware';
import { requireGraphQLOrganization } from '../require-organization';
import type { GraphQLContext } from './index';

const controller = new ITILController();
type RecordKind = 'incident' | 'change';
type Handler = (req: Request, res: Response) => Promise<void>;

// Share REST's scoped DML rather than maintain a second implementation of
// record authority. GraphQL authorization and table presence precede invocation.
async function recordCall(context: GraphQLContext, kind: RecordKind, handler: Handler,
  args: { id?: string; input?: Record<string, unknown>; [key: string]: unknown }, write = false): Promise<unknown> {
  requireGraphQLOrganization(context);
  if (write) checkGraphQLPermission(context, 'write');
  const table = kind === 'incident' ? 'itil_incidents' : 'itil_changes';
  const present = await getPostgresClient().pool.query(
    `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass($1)
      AND attname = 'organization_id' AND NOT attisdropped) AS available`, [`public.${table}`]);
  if (!present.rows[0]?.available) throw new GraphQLError('ITIL records unavailable', { extensions: { code: 'SERVICE_UNAVAILABLE' } });
  if (args.id && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(args.id)) {
    throw new GraphQLError(`${kind === 'incident' ? 'Incident' : 'Change'} not found`,
      { extensions: { code: 'NOT_FOUND' } });
  }
  const input = { ...(args.input ?? {}) };
  if (kind === 'change' && input.status === 'REQUESTED') input.status = 'DRAFT';
  const query = { ...args };
  if (kind === 'change' && query.status === 'REQUESTED') query.status = 'DRAFT';
  const req = { user: context.user, params: { id: args.id },
    query, body: { ...input, ...args, ...(kind === 'change' && input.status ? { status: input.status } : {}) } } as unknown as Request;
  let status = 200;
  let body: unknown;
  const res = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
    send() { return this; },
  } as unknown as Response;
  await handler.call(controller, req, res);
  if (status >= 500) {
    throw new GraphQLError('ITIL records unavailable',
      { extensions: { code: 'SERVICE_UNAVAILABLE' } });
  }
  if (status >= 400) {
    const failure = body && typeof body === 'object' ? body : {};
    const message = status === 404 && 'message' in failure && typeof failure.message === 'string'
      ? failure.message : status === 404 ? `${kind === 'incident' ? 'Incident' : 'Change'} not found`
        : 'Invalid ITIL record request';
    throw new GraphQLError(message,
      { extensions: { code: status === 404 ? 'NOT_FOUND' : 'BAD_USER_INPUT' } });
  }
  return body;
}

function incident(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, incidentNumber: row.incident_number, affectedCIId: row.affected_ci_id,
    reportedBy: row.reported_by, reportedAt: row.reported_at,
    assignedTo: row.assigned_to, resolvedAt: row.resolved_at,
    estimatedUserImpact: (row.business_impact as Record<string, unknown> | null)?.estimated_user_impact ?? 0,
    estimatedRevenueImpact: (row.business_impact as Record<string, unknown> | null)?.estimated_revenue_impact ?? 0,
    symptoms: [], affectedBusinessServices: [],
    impact: String(row.impact).toUpperCase(), urgency: String(row.urgency).toUpperCase(),
    status: String(row.status).toUpperCase() };
}
const changeOutcomes: Record<string, string> = {
  successful: 'SUCCESS', successful_with_issues: 'PARTIAL_SUCCESS',
  failed: 'FAILED', backed_out: 'ROLLED_BACK',
};
function changeStatus(status: unknown): string {
  return status === 'draft' || status === 'pending_approval' ? 'REQUESTED' : String(status).toUpperCase();
}
function change(row: Record<string, unknown>): Record<string, unknown> {
  const start = row.scheduled_start instanceof Date ? row.scheduled_start : new Date(String(row.scheduled_start));
  const end = row.scheduled_end instanceof Date ? row.scheduled_end : new Date(String(row.scheduled_end));
  // Map persisted outcomes to the public GraphQL enum.
  return { ...row, changeNumber: row.change_number, changeType: String(row.change_type).toUpperCase(),
    affectedCIIds: row.affected_ci_ids, requestedBy: row.requested_by, requestedAt: row.created_at,
    plannedStart: row.scheduled_start, plannedDuration: Math.round((end.getTime() - start.getTime()) / 60000),
    actualDuration: row.actual_duration, status: changeStatus(row.status),
    implementationPlan: row.implementation_plan, backoutPlan: row.backout_plan,
    testPlan: row.test_plan, implementedBy: row.implemented_by,
    result: row.outcome ? changeOutcomes[String(row.outcome)] ?? null : null,
    closureNotes: row.closure_notes, closedAt: row.closed_at };
}
function mappedData(result: unknown, map: (row: Record<string, unknown>) => Record<string, unknown>) {
  if (!result || typeof result !== 'object' || !('data' in result) || !result.data ||
    typeof result.data !== 'object' || Array.isArray(result.data)) throw new Error('Invalid ITIL record response');
  return map(result.data as Record<string, unknown>);
}
function mappedPage(result: unknown, map: (row: Record<string, unknown>) => Record<string, unknown>) {
  if (!result || typeof result !== 'object' || !('data' in result) || !Array.isArray(result.data) ||
    !('pagination' in result) || !result.pagination || typeof result.pagination !== 'object' ||
    !('total' in result.pagination) || !('page' in result.pagination) ||
    !('limit' in result.pagination) || !('pages' in result.pagination)) {
    throw new Error('Invalid ITIL page response');
  }
  const { total, page, limit, pages } = result.pagination;
  return { items: result.data.map(row => map(row as Record<string, unknown>)),
    total: Number(total), page: Number(page), limit: Number(limit), pages: Number(pages) };
}
export const itilRecordQueries = {
  incidents: async (_: unknown, args: Record<string, unknown>, ctx: GraphQLContext) =>
    mappedPage(await recordCall(ctx, 'incident', controller.getIncidents, args), incident),
  incident: async (_: unknown, args: { id: string }, ctx: GraphQLContext) =>
    mappedData(await recordCall(ctx, 'incident', controller.getIncident, args), incident),
  incidentMetrics: async (_: unknown, _args: unknown, ctx: GraphQLContext) => {
    const summary = await recordCall(ctx, 'incident', controller.getIncidentSummary, {});
    const mttr = await recordCall(ctx, 'incident', controller.getMeanTimeToResolve, {});
    const mtbf = await recordCall(ctx, 'incident', controller.getMeanTimeBetweenFailures, {});
    const rows = summary && typeof summary === 'object' && 'data' in summary && Array.isArray(summary.data) ? summary.data : [];
    const statuses = new Map<string, number>();
    const priorities = new Map<number, number>();
    for (const row of rows) {
      const item = row as { status: string; priority: number; count: string };
      statuses.set(item.status, (statuses.get(item.status) ?? 0) + Number(item.count));
      priorities.set(item.priority, (priorities.get(item.priority) ?? 0) + Number(item.count));
    }
    const metric = (result: unknown, key: 'mttr' | 'mtbf') => {
      if (result && typeof result === 'object' && 'data' in result &&
        result.data && typeof result.data === 'object' && key in result.data) return Number(result.data[key]);
      return 0;
    };
    return { totalIncidents: [...statuses.values()].reduce((a, b) => a + b, 0),
      byStatus: [...statuses].map(([status, count]) => ({ status: status.toUpperCase(), count })),
      byPriority: [...priorities].map(([priority, count]) => ({ priority, count })),
      mttr: metric(mttr, 'mttr'), mtbf: metric(mtbf, 'mtbf') };
  },
  changes: async (_: unknown, args: Record<string, unknown>, ctx: GraphQLContext) =>
    mappedPage(await recordCall(ctx, 'change', controller.getChanges, args), change),
  change: async (_: unknown, args: { id: string }, ctx: GraphQLContext) =>
    mappedData(await recordCall(ctx, 'change', controller.getChange, args), change),
  changeMetrics: async (_: unknown, _args: unknown, ctx: GraphQLContext) => {
    const page = mappedPage(await recordCall(ctx, 'change', controller.getChanges, { limit: 1 }), change);
    const summary = await recordCall(ctx, 'change', controller.getChangeSuccessRate, {});
    const data = summary && typeof summary === 'object' && 'data' in summary ? summary.data : null;
    if (!data || typeof data !== 'object' || !('successfulChanges' in data) ||
      !('totalClosedChanges' in data) || !('successRate' in data)) throw new Error('Invalid change metric response');
    const breakdown = await getPostgresClient().pool.query(
      `SELECT change_type, COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE outcome = 'successful')::int AS successes
        FROM itil_changes WHERE organization_id = $1 GROUP BY change_type`,
      [requireGraphQLOrganization(ctx)]);
    return { totalChanges: page.total, successfulChanges: Number(data.successfulChanges),
      failedChanges: Number(data.totalClosedChanges) - Number(data.successfulChanges),
      successRate: Number(data.successRate),
      byType: breakdown.rows.map(row => ({ changeType: String(row.change_type).toUpperCase(),
        count: Number(row.count), successRate: Number(row.count) ? Number(row.successes) / Number(row.count) * 100 : 0 })) };
  },
};

export const itilRecordMutations = {
  createIncident: async (_: unknown, args: { input: Record<string, unknown> }, ctx: GraphQLContext) => {
    const result = await recordCall(ctx, 'incident', controller.createIncident, args, true);
    if (!result || typeof result !== 'object' || !('data' in result) ||
      !('priorityCalculation' in result) || !result.priorityCalculation ||
      typeof result.priorityCalculation !== 'object') throw new Error('Invalid incident response');
    const priority = result.priorityCalculation as Record<string, unknown>;
    return { incident: incident(result.data as Record<string, unknown>),
      priorityCalculation: { ...priority, impact: String(priority.impact).toUpperCase(),
        urgency: String(priority.urgency).toUpperCase(), affectedBusinessServices: [] } };
  },
  updateIncident: async (_: unknown, args: { id: string; input: Record<string, unknown> }, ctx: GraphQLContext) =>
    mappedData(await recordCall(ctx, 'incident', controller.updateIncident, args, true), incident),
  resolveIncident: async (_: unknown, args: { id: string; resolution: string; resolvedBy: string }, ctx: GraphQLContext) =>
    mappedData(await recordCall(ctx, 'incident', controller.resolveIncident, args, true), incident),
  createChange: async (_: unknown, args: { input: Record<string, unknown> }, ctx: GraphQLContext) =>
    mappedData(await recordCall(ctx, 'change', controller.createChange, args, true), change),
  updateChange: async (_: unknown, args: { id: string; input: Record<string, unknown> }, ctx: GraphQLContext) =>
    mappedData(await recordCall(ctx, 'change', controller.updateChange, args, true), change),
  approveChange: async (_: unknown, args: { id: string }, ctx: GraphQLContext) =>
    mappedData(await recordCall(ctx, 'change', controller.approveChange, args, true), change),
  implementChange: async (_: unknown, args: { id: string }, ctx: GraphQLContext) =>
    mappedData(await recordCall(ctx, 'change', controller.implementChange, args, true), change),
  closeChange: async (_: unknown, args: { id: string; result: string; notes?: string; closedBy: string }, ctx: GraphQLContext) =>
    mappedData(await recordCall(ctx, 'change', controller.closeChange, args, true), change),
};

export const itilNestedRecords = {
  incidents: async (ciId: string, args: { status?: string; limit?: number }, ctx: GraphQLContext) => {
    const page = mappedPage(await recordCall(ctx, 'incident', controller.getIncidents,
      { affectedCIId: ciId, status: args.status, limit: Math.min(100, args.limit ?? 50) }), incident);
    return page.items;
  },
  changes: async (ciId: string, args: { status?: string; limit?: number }, ctx: GraphQLContext) => {
    const organizationId = requireGraphQLOrganization(ctx);
    const present = await getPostgresClient().pool.query(
      `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass($1)
        AND attname = 'organization_id' AND NOT attisdropped) AS available`, ['public.itil_changes']);
    if (!present.rows[0]?.available) {
      throw new GraphQLError('ITIL records unavailable', { extensions: { code: 'SERVICE_UNAVAILABLE' } });
    }
    const result = await getPostgresClient().pool.query(
      `SELECT * FROM itil_changes WHERE organization_id = $1 AND $2 = ANY(affected_ci_ids)
        AND ($3::text IS NULL OR status = $3) ORDER BY created_at DESC LIMIT $4`,
      [organizationId, ciId, args.status === 'REQUESTED' ? 'draft' : args.status?.toLowerCase() ?? null,
        Math.min(100, Math.max(1, args.limit ?? 50))]);
    return result.rows.map(row => change(row));
  },
};
