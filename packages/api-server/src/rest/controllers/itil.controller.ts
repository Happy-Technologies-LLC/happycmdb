// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { dec, enc, getNeo4jClient, getPostgresClient, isStorableString, PlanUnrepresentableError } from '@cmdb/database';
import { logger, ciIncarnationId } from '@cmdb/common';
import { v4 as uuidv4 } from 'uuid';
import neo4j from 'neo4j-driver';
import { requestOrganizationId } from '../../middleware/auth.middleware';
import {
  assertNoCIGap, CIGapError, CI_GAP_RESPONSE, readSingleCI, readCIList, CIListUnavailableError,
  CI_LIST_UNAVAILABLE_RESPONSE, writeReferencedCIs,
} from '../../read-admission';
import { assertCIId, isReservedKey, requestActor, sendJournalError } from '../../journal-http';


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
        message: error instanceof Error ? error.message : 'Unknown error',
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

      const incidentUuid = uuidv4();
      const incidentNumber = `INC-${incidentUuid}`;
      const title = description.length > 500 ? `${description.slice(0, 497)}...` : description;
      // AP-P': the referenced CI cannot enter a gap between this check and the insert.
      const result = await writeReferencedCIs(requestOrganizationId(req), [affectedCIId], client => client.query(
        `
        INSERT INTO itil_incidents (
          id, incident_number, title, description, affected_ci_id,
          reported_by, reported_at, priority, impact, urgency, status, organization_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        updates.push(`status = $${paramIndex++}`);
        params.push(String(status).toLowerCase());
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async resolveIncident(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { resolution } = req.body;

      const pool = this.postgresClient.pool;
      const result = await pool.query(
        `
        UPDATE itil_incidents
        SET status = 'resolved',
            resolution = $1,
            resolved_at = NOW(),
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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

      const updates: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (status) {
        updates.push(`status = $${paramIndex++}`);
        params.push(String(status).toLowerCase());
      }
      if (implementedBy != null) {
        updates.push(`implemented_by = $${paramIndex++}`);
        params.push(implementedBy);
      }
      if (actualDuration != null) {
        updates.push(`actual_duration = $${paramIndex++}`);
        params.push(actualDuration);
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
        UPDATE itil_changes
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
          message: 'Change not found',
        });
        return;
      }

      res.json({
        success: true,
        data: result.rows[0],
        message: 'Change updated successfully',
      });
    } catch (error) {
      logger.error('Error updating change', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update change',
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async approveChange(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const pool = this.postgresClient.pool;
      const result = await pool.query(
        `
        UPDATE itil_changes
        SET status = 'approved',
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
        message: 'Change approved successfully',
      });
    } catch (error) {
      logger.error('Error approving change', error);
      res.status(500).json({
        success: false,
        error: 'Failed to approve change',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async closeChange(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { result: changeResult, notes, closedBy } = req.body;

      const outcomeMap: Record<string, string> = {
        SUCCESS: 'successful',
        PARTIAL_SUCCESS: 'successful_with_issues',
        FAILED: 'failed',
        ROLLED_BACK: 'backed_out',
      };
      const outcome = outcomeMap[changeResult] ?? null;

      logger.info('Closing change', { id, closedBy });

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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async getBaselines(req: Request, res: Response): Promise<void> {
    try {
      const pool = this.postgresClient.pool;
      const result = await pool.query(
        'SELECT * FROM itil_baselines WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 100',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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

      // TODO: Implement baseline comparison logic
      // This would compare current CI state to baseline snapshot
      res.json({
        success: true,
        data: {
          baselineId: id,
          comparisonDate: new Date(),
          driftedCIs: [],
          totalDriftCount: 0,
          driftPercentage: 0,
        },
        message: 'Baseline comparison feature coming soon',
      });
    } catch (error) {
      logger.error('Error comparing to baseline', error);
      res.status(500).json({
        success: false,
        error: 'Failed to compare to baseline',
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async getMeanTimeToResolve(req: Request, res: Response): Promise<void> {
    try {
      const pool = this.postgresClient.pool;
      const result = await pool.query(`
        SELECT
          AVG(EXTRACT(EPOCH FROM (resolved_at - reported_at))/3600) as mttr_hours
        FROM itil_incidents
        WHERE organization_id = $1 AND status = 'resolved'
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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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

    const affectedCIIds = JSON.parse(change.affected_ci_ids || '[]');
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

const isGraphScalar = (value: unknown): boolean => value === null || ['boolean', 'number', 'string'].includes(typeof value) ||
  [neo4j.isInt, neo4j.isPoint, neo4j.isDate, neo4j.isDateTime, neo4j.isLocalDateTime, neo4j.isTime,
    neo4j.isLocalTime, neo4j.isDuration].some(test => test(value));

/**
 * Main's restore key handling (legacy snapshots carry `_`-prefixed names) plus
 * v16 §4.4: every reserved key is dropped, never written. A value Neo4j cannot
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
    if (!Object.hasOwn(snapshot, key) || isReservedKey(key) || name === 'updated_at' || name === 'incarnation_id') continue;
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
