// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { dec, enc, getNeo4jClient, getPostgresClient, isStorableString, PlanUnrepresentableError } from '@cmdb/database';
import { logger, ciIncarnationId } from '@cmdb/common';
import { v4 as uuidv4 } from 'uuid';
import neo4j from 'neo4j-driver';
import { requestOrganizationId, type AuthenticatedRequest } from '../../middleware/auth.middleware';
import {
  assertNoCIGap, CIGapError, CI_GAP_RESPONSE, readSingleCI, readCIList, CIListUnavailableError,
  CI_LIST_UNAVAILABLE_RESPONSE, writeReferencedCIs,
} from '../../read-admission';
import { assertCIId, isReservedKey, requestActor, sendJournalError } from '../../journal-http';
import {
  boundedPgRead, estateFeedTimeoutMs, ESTATE_FEED_LIMIT_RESPONSE, isStatementTimeout,
} from '../../services/bounded-pg-read';
import {
  businessImpactFor, deriveImpact, readMappedServices, readOpenIncidentRibbon,
  RIBBON_DEFAULT_INCIDENTS, RIBBON_MAX_INCIDENTS,
} from '../../services/incident-business-impact';


/** Statuses a change can be approved from: everything before `approved` in itil_changes_status_check (001). */
const PRE_APPROVAL_STATUSES: readonly string[] = ['draft', 'pending_approval'];
const PRE_APPROVAL_STATUS_LIST = PRE_APPROVAL_STATUSES.map(status => `'${status}'`).join(', ');

/**
 * The verified caller's user id, never a body field. Only `_userId` is stamped: a username fallback would store a
 * non-UUID value, and every real principal (JWT access token, API key) carries `_userId`. No 'system' fallback: an
 * approval attributed to no one defeats the record.
 */
function changeApprover(req: Request): string | undefined {
  const userId = (req as AuthenticatedRequest).user?._userId;
  return typeof userId === 'string' && userId !== '' ? userId : undefined;
}
function refuseUnauthenticatedApprover(res: Response): void {
  res.status(401).json({
    success: false,
    error: 'Unauthorized',
    message: 'An authenticated user is required to approve a change',
  });
}
/** Extra WHERE condition of the change UPDATE; `sql` references params already pushed. */
interface ChangeWriteGuard { sql: string; conflict: { code: string; message: string } }
const APPROVABLE_GUARD: ChangeWriteGuard = {
  sql: `status IN (${PRE_APPROVAL_STATUS_LIST})`,
  conflict: { code: 'CHANGE_NOT_APPROVABLE', message: 'Only a draft or pending_approval change can be approved' },
};
/** SET assignments for an approval; the stamp is overwritten, not COALESCEd: the status guard admits only unapproved changes. */
function approvalAssignments(approver: string, params: unknown[]): string[] {
  params.push(approver);
  return ["status = 'approved'", "approval_status = 'approved'", `approved_by = $${params.length}`, 'approved_at = NOW()'];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The cleared approval stamp's approver for the trail event: ids only. approved_by is free text and legacy rows can
 * hold an email or a name, so only a UUID is logged; anything else is reported as a kind with no value.
 */
function previousApproverFields(approvedBy: string | null): Record<string, unknown> {
  if (approvedBy == null) return { previous_approved_by: null };
  return UUID_PATTERN.test(approvedBy)
    ? { previous_approved_by: approvedBy }
    : { previous_approved_by_kind: 'legacy' };
}

/** What the caller claimed in closedBy, without the claim: the actor's own id, some other UUID, or anything else. */
function claimedClosedByKind(claimed: unknown, actorId: string | null): 'matches_actor' | 'uuid' | 'other' {
  if (actorId !== null && claimed === actorId) return 'matches_actor';
  return typeof claimed === 'string' && UUID_PATTERN.test(claimed) ? 'uuid' : 'other';
}

/**
 * ITIL Controller
 *
 * Handles ITIL v4 Service Management operations:
 * - Configuration Management (lifecycle, status, audit)
 * - Incident Management (priority calculation, resolution)
 * - Change Management (risk assessment, approval workflow)
 * - Configuration Baselines (snapshot, comparison; restore awaits journal admission)
 * - ITIL Metrics (accuracy, MTTR, MTBF, change success rate)
 */
export class ITILController {
  private neo4jClient = getNeo4jClient();
  private postgresClient = getPostgresClient();

  // ============================================================================
  // Configuration Items (ITIL Management)
  // ============================================================================

  async getConfigurationItems(req: Request, res: Response): Promise<void> {
    try {
      const { lifecycle, status, ciType, page = 1, limit = 50 } = req.query;

      const session = this.neo4jClient.getSession();
      try {
        let query = 'MATCH (ci:CI) WHERE ci.organization_id = $organizationId AND NOT ci.id IN $pending';
        const organizationId = requestOrganizationId(req);
        const params: Record<string, unknown> = { organizationId };

        // Apply filters
        if (typeof lifecycle === 'string') {
          query += ' AND ci.itil_lifecycle = $lifecycle';
          params.lifecycle = lifecycle;
        }
        if (typeof status === 'string') {
          query += ' AND ci.itil_config_status = $status';
          params.status = status;
        }
        if (typeof ciType === 'string') {
          query += ' AND ci.type = $ciType';
          params.ciType = ciType;
        }

        const pageNum = parseInt(page as string);
        const limitNum = Math.min(parseInt(limit as string), 1000);
        const offset = (pageNum - 1) * limitNum;
        const { total, items } = await readCIList(organizationId, async (pending, timeout) => {
          const queryParams = { ...params, pending, offset: neo4j.int(offset),
            limit: neo4j.int(limitNum) };
          const expiresAt = Date.now() + timeout;
          const remaining = () => {
            const milliseconds = expiresAt - Date.now();
            if (milliseconds <= 0) throw new CIListUnavailableError();
            return milliseconds;
          };
          const countResult = await session.run(
            `${query} RETURN count(ci) AS total`, queryParams, { timeout: remaining() });
          const pageResult = await session.run(
            `${query} RETURN ci ORDER BY ci.name, ci.id SKIP $offset LIMIT $limit`,
            queryParams, { timeout: remaining() });
          return {
            total: countResult.records[0]!.get('total').toNumber() as number,
            items: pageResult.records.map(row =>
              this.convertNeo4jCI((row.get('ci') as { properties: Record<string, unknown> }).properties)),
          };
        });
        res.json({
          success: true, data: items,
          pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error getting configuration items', error);
      if (error instanceof CIListUnavailableError) {
        res.status(503).json(CI_LIST_UNAVAILABLE_RESPONSE);
      } else {
        res.status(500).json({ success: false, error: 'Failed to retrieve configuration items' });
      }
    }
  }

  async getConfigurationItem(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const organizationId = requestOrganizationId(req);
      const ci = await readSingleCI(organizationId, id,
        () => this.neo4jClient.getCI(id, organizationId));

      if (!ci) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Configuration item with ID '${id}' not found`,
        });
        return;
      }

      res.json({
        success: true,
        data: this.convertNeo4jCI(ci),
      });
    } catch (error) {
      logger.error('Error getting configuration item', error);
      if (error instanceof CIGapError) {
        res.status(409).json(CI_GAP_RESPONSE);
      } else {
        res.status(500).json({ success: false, error: 'Failed to retrieve configuration item' });
      }
    }
  }

  /** ITIL lifecycle/status/audit writes are journaled direct writes (v16 §3.1). */
  private async writeCI(req: Request, res: Response, props: Record<string, unknown>, message: string): Promise<void> {
    try {
      assertCIId(req.params['id']);
      const ci = await this.neo4jClient.updateCIProperties(
        req.params['id'], props, requestOrganizationId(req), requestActor(req));
      if (!ci) {
        res.status(404).json({ success: false, error: 'Not Found', message: 'CI not found' });
        return;
      }
      res.json({ success: true, data: this.convertNeo4jCI(ci), message });
    } catch (error) {
      if (sendJournalError(res, error)) return;
      logger.error('Error updating configuration item', error);
      res.status(500).json({ success: false, error: 'Failed to update configuration item' });
    }
  }

  async updateLifecycleStage(req: Request, res: Response): Promise<void> {
    await this.writeCI(req, res, { itil_lifecycle: req.body.stage }, `Lifecycle stage updated to ${req.body.stage}`);
  }

  async updateConfigurationStatus(req: Request, res: Response): Promise<void> {
    await this.writeCI(req, res, { itil_config_status: req.body.status },
      `Configuration status updated to ${req.body.status}`);
  }

  async getCIHistory(_req: Request, res: Response): Promise<void> {
    try {
      const { id } = _req.params;
      const organizationId = requestOrganizationId(_req);
      const ci = await this.neo4jClient.getCI(id, organizationId);
      if (!ci) {
        await assertNoCIGap(organizationId, id);
        res.status(404).json({ success: false, error: 'Not Found', message: 'CI not found' });
        return;
      }
      const { limit = 100 } = _req.query;
      const incarnationId = ciIncarnationId(ci);
      const result = await readSingleCI(organizationId, id, () => incarnationId
        ? this.postgresClient.query(
          `SELECT h.id, h.ci_id, h.change_type, h.changed_fields, h.previous_values,
                  h.new_values, h.changed_at, h.changed_by, h.correlation_id
           FROM ci_change_history h
           WHERE h.ci_id = $1 AND h.organization_id = $2
             AND h.ci_incarnation_id = $3::uuid
           ORDER BY h.changed_at DESC, h.id LIMIT $4`,
          [id, organizationId, incarnationId, parseInt(String(limit), 10)]
        )
        : Promise.resolve({ rows: [] }));
      res.json({ success: true, data: result.rows, count: result.rows.length });
    } catch (error) {
      if (error instanceof CIGapError) {
        res.status(409).json(CI_GAP_RESPONSE);
        return;
      }
      logger.error('Error getting CI history', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve CI history',
        message: 'Internal error',
      });
    }
  }

  async getCIsDueForAudit(req: Request, res: Response): Promise<void> {
    try {
      const session = this.neo4jClient.getSession();
      try {
        const organizationId = requestOrganizationId(req);
        const result = await readCIList(organizationId, (pending, timeout) => session.run(
          `MATCH (ci:CI)
           WHERE ci.organization_id = $organizationId AND NOT ci.id IN $pending
             AND (ci.itil_next_audit_date <= datetime() OR ci.itil_last_audited IS NULL)
           RETURN ci ORDER BY ci.itil_next_audit_date LIMIT 100`,
          { organizationId, pending }, { timeout }
        ));

        const cis = result.records.map((r: any) => this.convertNeo4jCI(r.get('ci').properties));

        res.json({
          success: true,
          data: cis,
          count: cis.length,
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error getting CIs due for audit', error);
      if (error instanceof CIListUnavailableError) res.status(503).json(CI_LIST_UNAVAILABLE_RESPONSE);
      else res.status(500).json({ success: false, error: 'Failed to retrieve CIs due for audit' });
    }
  }

  async scheduleAudit(req: Request, res: Response): Promise<void> {
    const { auditDate, auditor, notes } = req.body;
    await this.writeCI(req, res, {
      itil_next_audit_date: neo4j.types.DateTime.fromStandardDate(new Date(auditDate)),
      itil_audit_scheduled_by: auditor ?? null,
      itil_audit_notes: notes ?? null,
    }, 'Audit scheduled successfully');
  }

  async completeAudit(req: Request, res: Response): Promise<void> {
    const { auditStatus, findings, completedBy } = req.body;
    await this.writeCI(req, res, {
      itil_audit_status: auditStatus,
      itil_last_audited: neo4j.types.DateTime.fromStandardDate(new Date()),
      itil_audit_findings: findings ?? null,
      itil_audit_completed_by: completedBy,
    }, 'Audit completed successfully');
  }

  // ============================================================================
  // Incidents
  // ============================================================================

  async createIncident(req: Request, res: Response): Promise<void> {
    try {
      const { affectedCIId, description, reportedBy, detectedAt } = req.body;

      // Verify CI exists
      const ci = await this.neo4jClient.getCI(affectedCIId, requestOrganizationId(req));
      if (!ci) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `CI with ID '${affectedCIId}' not found`,
        });
        return;
      }

      // TODO: Call IncidentPriorityService to calculate priority
      // For now, use a simple default priority calculation
      const priority = this.calculateBasicPriority(ci);

      // BW8: the figures come from the services the CI is mapped to, never from the priority heuristic above. An
      // estimate that cannot be read must not block the incident: it is stored as unknown (null).
      let impact = deriveImpact([]);
      try {
        impact = deriveImpact(await readMappedServices(
          { query: (text, params) => this.postgresClient.pool.query(text, params) },
          requestOrganizationId(req), [affectedCIId as string]));
      } catch (error) {
        logger.warn('Incident business impact unavailable', error);
      }

      const incidentUuid = uuidv4();
      const incidentNumber = `INC-${incidentUuid}`;
      const title = description.length > 500 ? `${description.slice(0, 497)}...` : description;
      // AP-P': the referenced CI cannot enter a gap between this check and the insert.
      const result = await writeReferencedCIs(requestOrganizationId(req), [affectedCIId], client => client.query(
        `
        INSERT INTO itil_incidents (
          id, incident_number, title, description, affected_ci_id,
          reported_by, reported_at, priority, impact, urgency, status, organization_id, business_impact
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
        RETURNING *
        `,
        [
          incidentUuid,
          incidentNumber,
          title,
          description,
          affectedCIId,
          reportedBy,
          detectedAt || new Date(),
          priority.priority,
          priority.impact,
          priority.urgency,
          'new',
          requestOrganizationId(req),
          JSON.stringify(businessImpactFor(impact)),
        ]
      ));

      res.status(201).json({
        success: true,
        data: result.rows[0],
        priorityCalculation: priority,
        message: `Incident created with priority P${priority.priority}`,
      });
    } catch (error) {
      if (sendJournalError(res, error)) return;
      logger.error('Error creating incident', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create incident',
        message: 'Internal error',
      });
    }
  }

  async getIncidents(req: Request, res: Response): Promise<void> {
    try {
      const { status, priority, affectedCIId, page = 1, limit = 50 } = req.query;

      const pool = this.postgresClient.pool;
      const conditions: string[] = ['organization_id = $1'];
      const params: unknown[] = [requestOrganizationId(req)];
      let paramIndex = 2;

      if (status) {
        conditions.push(`status = $${paramIndex++}`);
        params.push(String(status).toLowerCase());
      }
      if (priority) {
        conditions.push(`priority = $${paramIndex++}`);
        params.push(parseInt(priority as string));
      }
      if (affectedCIId) {
        conditions.push(`affected_ci_id = $${paramIndex++}`);
        params.push(affectedCIId);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get total count
      const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM itil_incidents ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0]!.total);

      // Get paginated results
      const pageNum = parseInt(page as string);
      const limitNum = Math.min(parseInt(limit as string), 1000);
      const offset = (pageNum - 1) * limitNum;

      params.push(limitNum, offset);
      const result = await pool.query(
        `
        SELECT * FROM itil_incidents
        ${whereClause}
        ORDER BY reported_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
        `,
        params
      );

      res.json({
        success: true,
        data: result.rows,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      logger.error('Error getting incidents', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve incidents',
        message: 'Internal error',
      });
    }
  }

  async getIncident(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const pool = this.postgresClient.pool;
      const result = await pool.query(
        'SELECT * FROM itil_incidents WHERE id = $1 AND organization_id = $2',
        [id, requestOrganizationId(req)]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Incident not found',
        });
        return;
      }

      res.json({
        success: true,
        data: result.rows[0],
      });
    } catch (error) {
      logger.error('Error getting incident', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve incident',
        message: 'Internal error',
      });
    }
  }

  async updateIncident(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { status, assignedTo, priority } = req.body;

      const updates: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (status) {
        const next = String(status).toLowerCase();
        updates.push(`status = $${paramIndex++}`);
        params.push(next);
        // Stamp once, atomically: COALESCE keeps an existing value, so a repeat or a later PATCH never moves the
        // downtime end that service availability reads from resolved_at / closed_at. A move back to an open status
        // (reopen) clears both stamps in the same UPDATE, so the outage counts as live again and a later re-resolve
        // stamps a fresh value; MTTR then measures to the latest resolution.
        if (next === 'resolved') {
          updates.push('resolved_at = COALESCE(resolved_at, NOW())');
        } else if (next === 'closed') {
          updates.push('closed_at = COALESCE(closed_at, NOW())');
        } else if (['new', 'assigned', 'in_progress'].includes(next)) {
          updates.push('resolved_at = NULL', 'closed_at = NULL');
        }
      }
      if (assignedTo) {
        updates.push(`assigned_to = $${paramIndex++}`);
        params.push(assignedTo);
      }
      if (priority) {
        updates.push(`priority = $${paramIndex++}`);
        params.push(priority);
      }

      updates.push(`updated_at = NOW()`);

      if (updates.length === 1) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'No fields to update',
        });
        return;
      }

      params.push(id, requestOrganizationId(req));
      const pool = this.postgresClient.pool;
      const result = await pool.query(
        `
        UPDATE itil_incidents
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex} AND organization_id = $${paramIndex + 1}
        RETURNING *
        `,
        params
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Incident not found',
        });
        return;
      }

      res.json({
        success: true,
        data: result.rows[0],
        message: 'Incident updated successfully',
      });
    } catch (error) {
      logger.error('Error updating incident', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update incident',
        message: 'Internal error',
      });
    }
  }

  async resolveIncident(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { resolution } = req.body;

      // resolved_at is stamped once, as in updateIncident: a repeat call keeps the downtime end; a reopen through
      // PATCH clears it, so a later resolve stamps a fresh value.
      const pool = this.postgresClient.pool;
      const result = await pool.query(
        `
        UPDATE itil_incidents
        SET status = 'resolved',
            resolution = $1,
            resolved_at = COALESCE(resolved_at, NOW()),
            updated_at = NOW()
        WHERE id = $2 AND organization_id = $3
        RETURNING *
        `,
        [resolution, id, requestOrganizationId(req)]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Incident not found',
        });
        return;
      }

      res.json({
        success: true,
        data: result.rows[0],
        message: 'Incident resolved successfully',
      });
    } catch (error) {
      logger.error('Error resolving incident', error);
      res.status(500).json({
        success: false,
        error: 'Failed to resolve incident',
        message: 'Internal error',
      });
    }
  }

  async getIncidentPriority(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const pool = this.postgresClient.pool;
      const result = await pool.query(
        'SELECT priority, impact, urgency FROM itil_incidents WHERE id = $1 AND organization_id = $2',
        [id, requestOrganizationId(req)]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Incident not found',
        });
        return;
      }

      res.json({
        success: true,
        data: result.rows[0],
      });
    } catch (error) {
      logger.error('Error getting incident priority', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve incident priority',
        message: 'Internal error',
      });
    }
  }

  // ============================================================================
  // Changes
  // ============================================================================

  async createChange(req: Request, res: Response): Promise<void> {
    try {
      const {
        changeType,
        description,
        affectedCIIds,
        requestedBy,
        plannedStart,
        plannedDuration,
        implementationPlan,
        backoutPlan = '',
        testPlan = '',
      } = req.body;

      // The GraphQL mutation calls this controller directly, bypassing REST's Joi schema.
      if (!Array.isArray(affectedCIIds) || affectedCIIds.length < 1 || affectedCIIds.length > 100) {
        res.status(400).json({ success: false, error: 'Affected CI IDs must contain 1 to 100 entries' });
        return;
      }
      // v16 §3.6: an invalid CI id is a 400 before any owned-CI lookup or journal access.
      for (const ciId of affectedCIIds) assertCIId(ciId);

      // Verify all affected CIs exist
      for (const ciId of affectedCIIds) {
        const ci = await this.neo4jClient.getCI(ciId, requestOrganizationId(req));
        if (!ci) {
          res.status(404).json({
            success: false,
            error: 'Not Found',
            message: `CI with ID '${ciId}' not found`,
          });
          return;
        }
      }

      const changeUuid = uuidv4();
      const changeNumber = `CHG-${changeUuid}`;
      const title = description.length > 500 ? `${description.slice(0, 497)}...` : description;
      const scheduledStart = new Date(plannedStart);
      const scheduledEnd = new Date(scheduledStart.getTime() + plannedDuration * 60000);
      const result = await writeReferencedCIs(requestOrganizationId(req), affectedCIIds, client => client.query(
        `
        INSERT INTO itil_changes (
          id, change_number, title, description, change_type,
          affected_ci_ids, requested_by,
          scheduled_start, scheduled_end, status,
          implementation_plan, backout_plan, test_plan, organization_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *
        `,
        [
          changeUuid,
          changeNumber,
          title,
          description,
          String(changeType).toLowerCase(),
          affectedCIIds,
          requestedBy,
          scheduledStart,
          scheduledEnd,
          'draft',
          implementationPlan,
          backoutPlan,
          testPlan,
          requestOrganizationId(req),
        ]
      ));

      res.status(201).json({
        success: true,
        data: result.rows[0],
        message: 'Change request created successfully',
      });
    } catch (error) {
      if (sendJournalError(res, error)) return;
      logger.error('Error creating change', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create change request',
        message: 'Internal error',
      });
    }
  }

  async getChanges(req: Request, res: Response): Promise<void> {
    try {
      const { status, changeType, requestedBy, page = 1, limit = 50 } = req.query;

      const pool = this.postgresClient.pool;
      const conditions: string[] = ['organization_id = $1'];
      const params: unknown[] = [requestOrganizationId(req)];
      let paramIndex = 2;

      if (status) {
        if (String(status).toLowerCase() === 'requested') {
          conditions.push(`status IN ('draft', 'pending_approval')`);
        } else {
          conditions.push(`status = $${paramIndex++}`);
          params.push(String(status).toLowerCase());
        }
      }
      if (changeType) {
        conditions.push(`change_type = $${paramIndex++}`);
        params.push(String(changeType).toLowerCase());
      }
      if (requestedBy) {
        conditions.push(`requested_by = $${paramIndex++}`);
        params.push(requestedBy);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get total count
      const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM itil_changes ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0]!.total);

      // Get paginated results
      const pageNum = parseInt(page as string);
      const limitNum = Math.min(parseInt(limit as string), 1000);
      const offset = (pageNum - 1) * limitNum;

      params.push(limitNum, offset);
      const result = await pool.query(
        `
        SELECT * FROM itil_changes
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
        `,
        params
      );

      res.json({
        success: true,
        data: result.rows,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      logger.error('Error getting changes', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve changes',
        message: 'Internal error',
      });
    }
  }

  async getChange(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const pool = this.postgresClient.pool;
      const result = await pool.query(
        'SELECT * FROM itil_changes WHERE id = $1 AND organization_id = $2',
        [id, requestOrganizationId(req)]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Change not found',
        });
        return;
      }

      res.json({
        success: true,
        data: result.rows[0],
      });
    } catch (error) {
      logger.error('Error getting change', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve change',
        message: 'Internal error',
      });
    }
  }

  async updateChange(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { status, implementedBy, actualDuration } = req.body;
      // GraphQL updateChange calls this controller directly, bypassing REST's Joi schema;
      // these bounds keep both entry points within the persisted column types (040).
      if ((implementedBy != null && (typeof implementedBy !== 'string' || implementedBy.length < 1 ||
          implementedBy.length > 255 || !isStorableString(implementedBy))) ||
        (actualDuration != null && (!Number.isInteger(actualDuration) || actualDuration < 1 ||
          actualDuration > 2147483647))) {
        res.status(400).json({ success: false, error: 'Bad Request', message: 'Invalid request' });
        return;
      }

      const statusValue = status ? String(status).toLowerCase() : undefined;
      const approving = statusValue === 'approved';
      const updates: string[] = [];
      const params: unknown[] = [];
      let guard: ChangeWriteGuard | undefined;
      let clearedStamp: Record<string, unknown> | undefined;

      if (approving) {
        // The verified caller, never a body approved_by/approved_at; same rules as POST /approve.
        const approver = changeApprover(req);
        if (!approver) {
          refuseUnauthenticatedApprover(res);
          return;
        }
        updates.push(...approvalAssignments(approver, params));
      } else if (statusValue) {
        params.push(statusValue);
        updates.push(`status = $${params.length}`);
        // Back to a pre-approval status: the earlier approval no longer stands, so a later approve records its own.
        if (PRE_APPROVAL_STATUSES.includes(statusValue)) {
          const pool = this.postgresClient.pool;
          const organizationId = requestOrganizationId(req);
          const current = await pool.query(
            `SELECT status, approved_by, approved_at::text AS approved_at_stamp
               FROM itil_changes WHERE id = $1 AND organization_id = $2`, [id, organizationId]);
          const before = current.rows[0] as { status: string; approved_by: string | null;
            approved_at_stamp: string | null } | undefined;
          if (!before) {
            res.status(404).json({ success: false, error: 'Not Found', message: 'Change not found' });
            return;
          }
          // approval_status moves with the stamp in the same statement (BI views, datamart and framework read it).
          updates.push("approval_status = 'pending'", 'approved_by = NULL', 'approved_at = NULL');
          // Conditional on the state just read, so an approval that committed in between is not undone. The stamp
          // is compared as the text the server rendered (microsecond precision a JS Date would lose).
          params.push(before.status, before.approved_by, before.approved_at_stamp);
          const at = params.length;
          guard = {
            sql: `status = $${at - 2} AND approved_by IS NOT DISTINCT FROM $${at - 1}::varchar
              AND approved_at IS NOT DISTINCT FROM $${at}::timestamptz`,
            conflict: {
              code: 'CHANGE_APPROVAL_CHANGED',
              message: 'The change was modified since it was read; reload it and retry',
            },
          };
          if (before.approved_by != null || before.approved_at_stamp != null) {
            clearedStamp = {
              change_id: id, organization_id: organizationId,
              ...previousApproverFields(before.approved_by),
              previous_approved_at: before.approved_at_stamp,
              actor_user_id: (req as AuthenticatedRequest).user?._userId ?? null,
            };
          }
        }
      }
      if (implementedBy != null) {
        params.push(implementedBy);
        updates.push(`implemented_by = $${params.length}`);
      }
      if (actualDuration != null) {
        params.push(actualDuration);
        updates.push(`actual_duration = $${params.length}`);
      }

      if (updates.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'No fields to update',
        });
        return;
      }
      updates.push('updated_at = NOW()');

      const written = await this.writeChange(req, res, id!, updates, params, guard ??
        (approving ? APPROVABLE_GUARD : undefined), 'Change updated successfully');
      if (written && clearedStamp) {
        logger.info('Change approval stamp cleared', clearedStamp);
      }
    } catch (error) {
      logger.error('Error updating change', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update change',
        message: 'Internal error',
      });
    }
  }

  async assessChangeRisk(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const pool = this.postgresClient.pool;
      const result = await pool.query(
        'SELECT * FROM itil_changes WHERE id = $1 AND organization_id = $2',
        [id, requestOrganizationId(req)]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Change not found',
        });
        return;
      }

      const change = result.rows[0];

      // TODO: Call ChangeRiskService to assess risk
      // For now, use a simple risk assessment
      const riskAssessment = await this.calculateBasicRisk(change);

      res.json({
        success: true,
        data: riskAssessment,
      });
    } catch (error) {
      logger.error('Error assessing change risk', error);
      res.status(500).json({
        success: false,
        error: 'Failed to assess change risk',
        message: 'Internal error',
      });
    }
  }

  async approveChange(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const approver = changeApprover(req);
      if (!approver) {
        refuseUnauthenticatedApprover(res);
        return;
      }

      const params: unknown[] = [];
      const assignments = [...approvalAssignments(approver, params), 'updated_at = NOW()'];
      await this.writeChange(req, res, id!, assignments, params, APPROVABLE_GUARD, 'Change approved successfully');
    } catch (error) {
      logger.error('Error approving change', error);
      res.status(500).json({
        success: false,
        error: 'Failed to approve change',
        message: 'Internal error',
      });
    }
  }

  /**
   * The one UPDATE behind approve and PATCH status. A `guard` adds its condition to the same statement
   * (race-free: a concurrent write serialises on the row lock and the condition is re-evaluated), then a
   * 0-row result is a 404 (absent or another organization, nothing written) or the guard's 409 (present,
   * condition not met, nothing written). Returns whether the row was written.
   */
  private async writeChange(req: Request, res: Response, id: string, assignments: string[],
    params: unknown[], guard: ChangeWriteGuard | undefined, message: string): Promise<boolean> {
    const pool = this.postgresClient.pool;
    const organizationId = requestOrganizationId(req);
    params.push(id, organizationId);
    const result = await pool.query(
      `
      UPDATE itil_changes
      SET ${assignments.join(', ')}
      WHERE id = $${params.length - 1} AND organization_id = $${params.length}${guard ? `
        AND ${guard.sql}` : ''}
      RETURNING *
      `,
      params
    );

    if (result.rows.length === 0) {
      const exists = guard && (await pool.query(
        'SELECT 1 FROM itil_changes WHERE id = $1 AND organization_id = $2', [id, organizationId])).rows.length > 0;
      if (guard && exists) {
        res.status(409).json({
          success: false,
          error: 'Conflict',
          code: guard.conflict.code,
          message: guard.conflict.message,
        });
        return false;
      }
      res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Change not found',
      });
      return false;
    }

    res.json({
      success: true,
      data: result.rows[0],
      message,
    });
    return true;
  }

  async implementChange(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const pool = this.postgresClient.pool;
      const result = await pool.query(
        `
        UPDATE itil_changes
        SET status = 'implemented',
            actual_start = COALESCE(actual_start, NOW()),
            actual_end = NOW(),
            updated_at = NOW()
        WHERE id = $1 AND organization_id = $2
        RETURNING *
        `,
        [id, requestOrganizationId(req)]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Change not found',
        });
        return;
      }

      res.json({
        success: true,
        data: result.rows[0],
        message: 'Change implemented successfully',
      });
    } catch (error) {
      logger.error('Error implementing change', error);
      res.status(500).json({
        success: false,
        error: 'Failed to implement change',
        message: 'Internal error',
      });
    }
  }

  async closeChange(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { result: changeResult, notes, closedBy: claimedClosedBy } = req.body;

      const outcomeMap: Record<string, string> = {
        SUCCESS: 'successful',
        PARTIAL_SUCCESS: 'successful_with_issues',
        FAILED: 'failed',
        ROLLED_BACK: 'backed_out',
      };
      const outcome = outcomeMap[changeResult] ?? null;

      const pool = this.postgresClient.pool;
      const result = await pool.query(
        `
        UPDATE itil_changes
        SET status = 'closed',
            outcome = $1,
            closure_notes = $2,
            closed_at = NOW(),
            updated_at = NOW()
        WHERE id = $3 AND organization_id = $4
        RETURNING *
        `,
        [outcome, notes, id, requestOrganizationId(req)]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Change not found',
        });
        return;
      }

      // closed_by is the verified actor. The body's closedBy is free text (an email, a name) and is never logged:
      // only its kind is, and only for a change this organization owns.
      const actorId = (req as AuthenticatedRequest).user?._userId ?? null;
      logger.info('Change closed', { id, closed_by: actorId, claimed_closed_by_kind: claimedClosedByKind(claimedClosedBy, actorId) });

      res.json({
        success: true,
        data: result.rows[0],
        message: 'Change closed successfully',
      });
    } catch (error) {
      logger.error('Error closing change', error);
      res.status(500).json({
        success: false,
        error: 'Failed to close change',
        message: 'Internal error',
      });
    }
  }

  // ============================================================================
  // Baselines
  // ============================================================================

  async createBaseline(req: Request, res: Response): Promise<void> {
    try {
      const { name, ciIds, description, createdBy } = req.body;
      const organizationId = requestOrganizationId(req);

      // §5.2: owned lookup (identical 404, own gap 409); then an AP-M'' snapshot of
      // the raw typed properties (never a W-state CI), persisted under AP-P'.
      for (const ciId of ciIds) {
        assertCIId(ciId);
        if (!(await this.neo4jClient.getCI(ciId, organizationId))) {
          await assertNoCIGap(organizationId, ciId);
          res.status(404).json({ success: false, error: 'Not Found', message: 'CI not found' });
          return;
        }
      }
      const snapshots = await readCIList(organizationId, async (pending, timeout) => {
        if (ciIds.some((ciId: string) => pending.includes(ciId))) throw new CIGapError();
        const session = this.neo4jClient.getSession();
        try {
          const result = await session.run(`MATCH (ci:CI) WHERE ci.id IN $ids AND ci.organization_id = $organizationId
            RETURN ci.id AS id, properties(ci) AS props`, { ids: ciIds, organizationId }, { timeout });
          return Object.fromEntries(result.records.map(record => [record.get('id'), enc(record.get('props'))]));
        } finally {
          await session.close();
        }
      });
      if (ciIds.some((ciId: string) => !Object.hasOwn(snapshots, ciId))) {
        res.status(404).json({ success: false, error: 'Not Found', message: 'CI not found' });
        return;
      }

      const baselineId = uuidv4();
      const result = await writeReferencedCIs(organizationId, ciIds, client => client.query(
        `
        INSERT INTO itil_baselines (
          id, name, description, baseline_type, scope, baseline_data, created_by, organization_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
        `,
        [
          baselineId,
          name,
          description || null,
          'configuration',
          JSON.stringify({ ci_ids: ciIds, ci_types: [], environment: null }),
          JSON.stringify(snapshots),
          createdBy,
          organizationId,
        ]
      ));

      res.status(201).json({
        success: true,
        data: result.rows[0],
        message: 'Baseline created successfully',
      });
    } catch (error) {
      if (sendJournalError(res, error)) return;
      if (error instanceof CIListUnavailableError) {
        res.status(503).json(CI_LIST_UNAVAILABLE_RESPONSE);
        return;
      }
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        res.status(409).json({
          success: false,
          error: 'Conflict',
          message: 'Baseline name already exists',
        });
        return;
      }
      logger.error('Error creating baseline', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create baseline',
        message: 'Internal error',
      });
    }
  }

  async getBaselines(req: Request, res: Response): Promise<void> {
    try {
      const pool = this.postgresClient.pool;
      const result = await pool.query(
        `SELECT id, name, description, baseline_type, status, created_by, approved_by, approved_at,
                created_at, updated_at, organization_id
           FROM itil_baselines WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [requestOrganizationId(req)]
      );

      res.json({
        success: true,
        data: result.rows,
        count: result.rows.length,
      });
    } catch (error) {
      logger.error('Error getting baselines', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve baselines',
        message: 'Internal error',
      });
    }
  }

  async getBaseline(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const pool = this.postgresClient.pool;
      const result = await pool.query(
        'SELECT * FROM itil_baselines WHERE id = $1 AND organization_id = $2',
        [id, requestOrganizationId(req)]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Baseline not found',
        });
        return;
      }

      res.json({
        success: true,
        data: result.rows[0],
      });
    } catch (error) {
      logger.error('Error getting baseline', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve baseline',
        message: 'Internal error',
      });
    }
  }

  async deleteBaseline(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const pool = this.postgresClient.pool;
      const result = await pool.query(
        'DELETE FROM itil_baselines WHERE id = $1 AND organization_id = $2 RETURNING id',
        [id, requestOrganizationId(req)]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Baseline not found',
        });
        return;
      }

      res.status(204).send();
    } catch (error) {
      logger.error('Error deleting baseline', error);
      res.status(500).json({
        success: false,
        error: 'Failed to delete baseline',
        message: 'Internal error',
      });
    }
  }

  async compareToBaseline(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const baseline = await this.postgresClient.pool.query(
        'SELECT id FROM itil_baselines WHERE id = $1 AND organization_id = $2',
        [id, requestOrganizationId(req)]
      );
      if (baseline.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Baseline not found',
        });
        return;
      }

      // Comparison is not implemented: never answer with a "no drift" shape for an unchecked baseline.
      res.status(501).json({
        success: false,
        error: 'Not Implemented',
        message: 'Baseline comparison is not implemented; no drift was evaluated for this baseline',
      });
    } catch (error) {
      logger.error('Error comparing to baseline', error);
      res.status(500).json({
        success: false,
        error: 'Failed to compare to baseline',
        message: 'Internal error',
      });
    }
  }

  /** Journaled single-CI restore (v16 §3.1, §4.1) from an owned baseline's typed snapshot. */
  async restoreFromBaseline(req: Request, res: Response): Promise<void> {
    try {
      const { ciId, restoreAttributes } = req.body;
      const organizationId = requestOrganizationId(req);
      assertCIId(ciId);
      const result = await this.postgresClient.pool.query(
        'SELECT baseline_data FROM itil_baselines WHERE id = $1 AND organization_id = $2',
        [req.params['id'], organizationId]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Not Found', message: 'Baseline not found' });
        return;
      }
      const data = result.rows[0].baseline_data;
      const snapshot = data && typeof data === 'object' && Object.hasOwn(data, ciId) ? dec(data[ciId]) : null;
      if (!snapshot || typeof snapshot !== 'object') {
        res.status(404).json({ success: false, error: 'Not Found', message: 'CI not found' });
        return;
      }
      const restore = baselineRestore(snapshot as Record<string, unknown>, restoreAttributes);
      const ci = await this.neo4jClient.restoreCI(ciId, restore.props, restore.createdAt, restore.discoveredAt,
        organizationId, requestActor(req));
      if (!ci) {
        res.status(404).json({ success: false, error: 'Not Found', message: 'CI not found' });
        return;
      }
      res.json({ success: true, data: this.convertNeo4jCI(ci), message: 'CI restored from baseline' });
    } catch (error) {
      if (sendJournalError(res, error)) return;
      logger.error('Error restoring from baseline', error);
      res.status(500).json({ success: false, error: 'Failed to restore from baseline' });
    }
  }

  // ============================================================================
  // Metrics
  // ============================================================================

  async getConfigurationAccuracy(req: Request, res: Response): Promise<void> {
    const session = this.neo4jClient.getSession();
    try {
      // Count only rows outside the S1 pending/failed journal gap.
      const organizationId = requestOrganizationId(req);
      const result = await readCIList(organizationId, (pending, timeout) => session.run(`
        MATCH (ci:CI)
        WHERE ci.organization_id = $organizationId AND NOT ci.id IN $pending
          AND ci.itil_audit_status IS NOT NULL
        RETURN
          count(CASE WHEN ci.itil_audit_status = 'COMPLIANT' THEN 1 ELSE null END) as compliantCount,
          count(ci) as totalAudited
      `, { organizationId, pending }, { timeout }));

      const row = result.records[0];
      const compliantCount = row ? row.get('compliantCount').toNumber() : 0;
      const totalAudited = row ? row.get('totalAudited').toNumber() : 0;
      const accuracy = totalAudited > 0 ? (compliantCount / totalAudited) * 100 : 0;

      res.json({
        success: true,
        data: {
          accuracy: accuracy.toFixed(2),
          compliantCount,
          totalAudited,
        },
      });
    } catch (error) {
      logger.error('Error getting configuration accuracy', error);
      if (error instanceof CIListUnavailableError) res.status(503).json(CI_LIST_UNAVAILABLE_RESPONSE);
      else res.status(500).json({ success: false, error: 'Failed to retrieve configuration accuracy' });
    } finally {
      await session.close();
    }
  }

  async getIncidentSummary(req: Request, res: Response): Promise<void> {
    try {
      const pool = this.postgresClient.pool;
      const result = await pool.query(`
        SELECT
          status,
          priority,
          COUNT(*) as count
        FROM itil_incidents
        WHERE organization_id = $1
        GROUP BY status, priority
        ORDER BY priority, status
      `, [requestOrganizationId(req)]);

      res.json({
        success: true,
        data: result.rows,
      });
    } catch (error) {
      logger.error('Error getting incident summary', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve incident summary',
        message: 'Internal error',
      });
    }
  }

  /**
   * Open-incident ribbon payload for the estate hub (HAP-1926 BW8).
   * GET /itil/metrics/open-incidents?limit=1..50 (default 5; an invalid value is a 400, never clamped).
   * Rules for "open", ordering, the derived affected service and the users / revenue-per-hour figures:
   * services/incident-business-impact.ts.
   */
  async getOpenIncidentRibbon(req: Request, res: Response): Promise<void> {
    const raw = (req.query as Record<string, unknown>)['limit'];
    const limit = raw === undefined ? RIBBON_DEFAULT_INCIDENTS : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > RIBBON_MAX_INCIDENTS) {
      res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: `limit must be an integer from 1 to ${RIBBON_MAX_INCIDENTS}`,
      });
      return;
    }
    try {
      const organizationId = requestOrganizationId(req);
      const data = await boundedPgRead(this.postgresClient, estateFeedTimeoutMs(),
        sql => readOpenIncidentRibbon(sql, organizationId, limit));
      res.json({ success: true, data });
    } catch (error) {
      if (isStatementTimeout(error)) {
        logger.warn('Open incident ribbon exceeded its statement timeout', error);
        res.status(503).json(ESTATE_FEED_LIMIT_RESPONSE);
        return;
      }
      logger.error('Error getting open incident ribbon', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve open incidents',
        message: 'Internal error',
      });
    }
  }

  async getChangeSuccessRate(req: Request, res: Response): Promise<void> {
    try {
      const pool = this.postgresClient.pool;
      const result = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE outcome = 'successful') as successful_changes,
          COUNT(*) FILTER (WHERE status = 'closed') as total_closed_changes
        FROM itil_changes
        WHERE status = 'closed' AND organization_id = $1
      `, [requestOrganizationId(req)]);

      const successfulChanges = parseInt(result.rows[0]?.successful_changes || '0');
      const totalClosedChanges = parseInt(result.rows[0]?.total_closed_changes || '0');
      const successRate = totalClosedChanges ? (successfulChanges / totalClosedChanges) * 100 : 0;

      res.json({
        success: true,
        data: {
          successRate: successRate.toFixed(2),
          successfulChanges,
          totalClosedChanges,
        },
      });
    } catch (error) {
      logger.error('Error getting change success rate', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve change success rate',
        message: 'Internal error',
      });
    }
  }

  async getMeanTimeToResolve(req: Request, res: Response): Promise<void> {
    try {
      const pool = this.postgresClient.pool;
      // Closed incidents keep their resolution stamp and stay in the mean; a reopen clears it.
      const result = await pool.query(`
        SELECT
          AVG(EXTRACT(EPOCH FROM (resolved_at - reported_at))/3600) as mttr_hours
        FROM itil_incidents
        WHERE organization_id = $1 AND status IN ('resolved', 'closed')
        AND resolved_at IS NOT NULL
      `, [requestOrganizationId(req)]);

      const mttrHours = parseFloat(result.rows[0]?.mttr_hours || '0');

      res.json({
        success: true,
        data: {
          mttr: mttrHours.toFixed(2),
          unit: 'hours',
        },
      });
    } catch (error) {
      logger.error('Error getting MTTR', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve MTTR',
        message: 'Internal error',
      });
    }
  }

  async getMeanTimeBetweenFailures(req: Request, res: Response): Promise<void> {
    try {
      const pool = this.postgresClient.pool;

      // Get average time between incidents for the same CI
      const result = await pool.query(`
        WITH incident_gaps AS (
          SELECT
            affected_ci_id,
            reported_at - LAG(reported_at) OVER (PARTITION BY affected_ci_id ORDER BY reported_at) as gap
          FROM itil_incidents
          WHERE organization_id = $1
        )
        SELECT
          AVG(EXTRACT(EPOCH FROM gap)/3600) as mtbf_hours
        FROM incident_gaps
        WHERE gap IS NOT NULL
      `, [requestOrganizationId(req)]);

      const mtbfHours = parseFloat(result.rows[0]?.mtbf_hours || '0');

      res.json({
        success: true,
        data: {
          mtbf: mtbfHours.toFixed(2),
          unit: 'hours',
        },
      });
    } catch (error) {
      logger.error('Error getting MTBF', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve MTBF',
        message: 'Internal error',
      });
    }
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private convertNeo4jCI(ci: any): any {
    // Convert Neo4j types to plain JavaScript objects
    // Remove underscore prefixes for frontend compatibility
    const converted: any = {};
    for (const key in ci) {
      if (ci.hasOwnProperty(key)) {
        const newKey = key.startsWith('_') ? key.substring(1) : key;
        converted[newKey] = ci[key];
      }
    }
    return converted;
  }


  private calculateBasicPriority(ci: any): any {
    // Basic priority calculation based on CI type and environment
    // TODO: Replace with actual IncidentPriorityService logic

    let priority = 3; // Default to P3 (Medium)
    let impact = 'medium';
    let urgency = 'medium';

    // Production environment gets higher priority
    if (ci.environment === 'production') {
      priority = 2;
      impact = 'high';
    }

    // Critical CI types get highest priority
    if (['database', 'load-balancer', 'service'].includes(ci.type)) {
      priority = 1;
      impact = 'critical';
      urgency = 'high';
    }

    return {
      priority,
      impact,
      urgency,
      reasoning: 'Basic calculation based on CI type and environment',
      estimatedUserImpact: priority === 1 ? 1000 : priority === 2 ? 100 : 10,
      estimatedRevenueImpact: priority === 1 ? 10000 : priority === 2 ? 1000 : 100,
    };
  }

  private async calculateBasicRisk(change: any): Promise<any> {
    // Basic risk calculation
    // TODO: Replace with actual ChangeRiskService logic

    const affectedCIIds = affectedCIIdList(change.affected_ci_ids);
    const ciCount = affectedCIIds.length;

    let riskScore = 0.5; // Default medium risk
    let riskLevel = 'MEDIUM';

    // More CIs affected = higher risk
    if (ciCount > 10) {
      riskScore = 0.8;
      riskLevel = 'HIGH';
    } else if (ciCount > 5) {
      riskScore = 0.6;
      riskLevel = 'MEDIUM';
    }

    // Emergency changes are higher risk
    if (change.change_type === 'EMERGENCY') {
      riskScore = Math.min(riskScore + 0.2, 1.0);
      riskLevel = 'HIGH';
    }

    return {
      riskScore,
      riskLevel,
      requiresCABApproval: riskScore > 0.6,
      affectedCICount: ciCount,
      estimatedDowntime: change.planned_duration || 0,
      estimatedUserImpact: ciCount * 10,
      estimatedRevenueAtRisk: ciCount * 1000,
      recommendations: [
        'Review implementation plan thoroughly',
        'Ensure backout plan is tested',
        'Schedule during maintenance window',
      ],
      mitigationStrategies: [
        'Perform change in stages',
        'Have rollback procedures ready',
        'Monitor closely during implementation',
      ],
    };
  }
}

/** `itil_changes.affected_ci_ids` is TEXT[] (node-postgres decodes it to a JS array); NULL is no affected CIs. */
function affectedCIIdList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

const isGraphScalar = (value: unknown): boolean => value === null || ['boolean', 'number', 'string'].includes(typeof value) ||
  [neo4j.isInt, neo4j.isPoint, neo4j.isDate, neo4j.isDateTime, neo4j.isLocalDateTime, neo4j.isTime,
    neo4j.isLocalTime, neo4j.isDuration].some(test => test(value));

/**
 * Main's restore key handling (legacy snapshots carry `_`-prefixed names) plus
 * v16 §4.4: every reserved key is dropped, never written, and so is `external_id`
 * (D17-3, HAP-1099: set only by REST create). A value Neo4j cannot
 * store is a definitive 422, never a lossy restore.
 */
function baselineRestore(snapshot: Record<string, unknown>, attributes?: string[]): {
  props: Record<string, unknown>; createdAt: unknown; discoveredAt: unknown;
} {
  const props: Record<string, unknown> = {};
  let createdAt: unknown = null;
  let discoveredAt: unknown = null;
  for (const key of attributes?.length ? attributes : Object.keys(snapshot)) {
    const name = key.startsWith('_') ? key.slice(1) : key;
    if (!Object.hasOwn(snapshot, key) || isReservedKey(key) || ['updated_at', 'incarnation_id', 'external_id'].includes(name)) continue;
    let value = snapshot[key];
    if (name === 'created_at' || name === 'discovered_at') {
      // Legacy snapshots hold ISO strings; typed snapshots hold the stored DateTime.
      const parsed = typeof value === 'string' ? new Date(value) : null;
      const at = neo4j.isDateTime(value) ? value
        : parsed && !Number.isNaN(parsed.getTime()) ? neo4j.types.DateTime.fromStandardDate(parsed) : null;
      if (name === 'created_at') createdAt = at;
      else discoveredAt = at;
      continue;
    }
    if (name === 'metadata' && value !== null && typeof value === 'object') value = JSON.stringify(value);
    const members = Array.isArray(value) ? value : [value];
    if (!members.every(isGraphScalar) ||
      new Set(members.map(member => neo4j.isInt(member) ? 'int' : typeof member)).size > 1) {
      throw new PlanUnrepresentableError();
    }
    props[name] = value;
  }
  return { props, createdAt, discoveredAt };
}
