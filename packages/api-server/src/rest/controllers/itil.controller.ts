// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import { v4 as uuidv4 } from 'uuid';
import neo4j from 'neo4j-driver';

/** Shape of a Neo4j Integer once it has round-tripped through JSON (JS numbers cannot hold a full 64-bit int, so the driver represents one as `{ low, high }`). */
type Neo4jIntegerLike = { low: number; high: number };

function isNeo4jIntegerLike(value: Record<string, unknown>): value is Neo4jIntegerLike {
  return (
    typeof value['low'] === 'number' &&
    typeof value['high'] === 'number' &&
    Object.keys(value).length === 2
  );
}

// Coerces a Neo4j temporal field (a plain number, or an Integer-shaped
// `{ low, high }` object after a JSON round-trip) to a number, defaulting
// missing fields (e.g. `hour` on a Date-only value) to zero. Shared by every
// field of `sanitizeBaselineValue`'s DateTime conversion, which must treat
// year/month/day/hour/minute/second/nanosecond identically.
function toIntegerlikeNumber(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'object' && isNeo4jIntegerLike(value as Record<string, unknown>)) {
    return neo4j.integer.toNumber(value as Neo4jIntegerLike);
  }
  return Number(value);
}

/**
 * ITIL Controller
 *
 * Handles ITIL v4 Service Management operations:
 * - Configuration Management (lifecycle, status, audit)
 * - Incident Management (priority calculation, resolution)
 * - Change Management (risk assessment, approval workflow)
 * - Configuration Baselines (snapshot, comparison, restoration)
 * - ITIL Metrics (accuracy, MTTR, MTBF, change success rate)
 *
 * NOTE: This controller provides REST API endpoints. The actual business logic
 * will be implemented by Agent 5 in the @cmdb/itil-service-manager package.
 * For now, we implement the API contract with placeholder logic.
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
        let query = 'MATCH (ci:CI) WHERE 1=1';
        const params: any = {};

        // Apply filters
        if (lifecycle) {
          query += ' AND ci.itil_lifecycle = $lifecycle';
          params.lifecycle = lifecycle;
        }
        if (status) {
          query += ' AND ci.itil_config_status = $status';
          params.status = status;
        }
        if (ciType) {
          query += ' AND ci.type = $ciType';
          params.ciType = ciType;
        }

        // Get total count
        const countResult = await session.run(query + ' RETURN count(ci) as total', params);
        const total = countResult.records[0]!.get('total').toNumber();

        // Get paginated results
        const pageNum = parseInt(page as string);
        const limitNum = Math.min(parseInt(limit as string), 1000);
        const offset = (pageNum - 1) * limitNum;

        query += ' RETURN ci ORDER BY ci.name SKIP $offset LIMIT $limit';
        params.offset = neo4j.int(offset);
        params.limit = neo4j.int(limitNum);

        const result = await session.run(query, params);
        const items = result.records.map((r: any) => this.convertNeo4jCI(r.get('ci').properties));

        res.json({
          success: true,
          data: items,
          pagination: {
            total,
            page: pageNum,
            limit: limitNum,
            pages: Math.ceil(total / limitNum),
          },
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error getting configuration items', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve configuration items',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async getConfigurationItem(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const ci = await this.neo4jClient.getCI(id);

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
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve configuration item',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async updateLifecycleStage(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { stage } = req.body;

      const session = this.neo4jClient.getSession();
      try {
        const result = await session.run(
          `
          MATCH (ci:CI {id: $id})
          SET ci.itil_lifecycle = $stage,
              ci.updated_at = datetime()
          RETURN ci
          `,
          { id, stage }
        );

        if (result.records.length === 0) {
          res.status(404).json({
            success: false,
            error: 'Not Found',
            message: `Configuration item with ID '${id}' not found`,
          });
          return;
        }

        const ci = this.convertNeo4jCI(result.records[0]!.get('ci').properties);

        res.json({
          success: true,
          data: ci,
          message: `Lifecycle stage updated to ${stage}`,
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error updating lifecycle stage', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update lifecycle stage',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async updateConfigurationStatus(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const session = this.neo4jClient.getSession();
      try {
        const result = await session.run(
          `
          MATCH (ci:CI {id: $id})
          SET ci.itil_config_status = $status,
              ci.updated_at = datetime()
          RETURN ci
          `,
          { id, status }
        );

        if (result.records.length === 0) {
          res.status(404).json({
            success: false,
            error: 'Not Found',
            message: `Configuration item with ID '${id}' not found`,
          });
          return;
        }

        const ci = this.convertNeo4jCI(result.records[0]!.get('ci').properties);

        res.json({
          success: true,
          data: ci,
          message: `Configuration status updated to ${status}`,
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error updating configuration status', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update configuration status',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async getCIHistory(_req: Request, res: Response): Promise<void> {
    try {
      const { id } = _req.params;
      const { limit = 100 } = _req.query;

      const pool = this.postgresClient.pool;
      const result = await pool.query(
        `
        SELECT * FROM ci_change_history
        WHERE ci_id = $1
        ORDER BY changed_at DESC
        LIMIT $2
        `,
        [id, parseInt(limit as string)]
      );

      res.json({
        success: true,
        data: result.rows,
        count: result.rows.length,
      });
    } catch (error) {
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
        const result = await session.run(
          `
          MATCH (ci:CI)
          WHERE ci.itil_next_audit_date <= datetime()
          OR ci.itil_last_audited IS NULL
          RETURN ci
          ORDER BY ci.itil_next_audit_date
          LIMIT 100
          `
        );

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
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve CIs due for audit',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async scheduleAudit(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { auditDate, auditor, notes } = req.body;

      const session = this.neo4jClient.getSession();
      try {
        const result = await session.run(
          `
          MATCH (ci:CI {id: $id})
          SET ci.itil_next_audit_date = datetime($auditDate),
              ci.itil_audit_scheduled_by = $auditor,
              ci.itil_audit_notes = $notes,
              ci.updated_at = datetime()
          RETURN ci
          `,
          {
            id,
            auditDate: new Date(auditDate).toISOString(),
            auditor: auditor ?? null,
            notes: notes ?? null,
          }
        );

        if (result.records.length === 0) {
          res.status(404).json({
            success: false,
            error: 'Not Found',
            message: `Configuration item with ID '${id}' not found`,
          });
          return;
        }

        const ci = this.convertNeo4jCI(result.records[0]!.get('ci').properties);

        res.json({
          success: true,
          data: ci,
          message: 'Audit scheduled successfully',
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error scheduling audit', error);
      res.status(500).json({
        success: false,
        error: 'Failed to schedule audit',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async completeAudit(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { auditStatus, findings, completedBy } = req.body;

      const session = this.neo4jClient.getSession();
      try {
        const result = await session.run(
          `
          MATCH (ci:CI {id: $id})
          SET ci.itil_audit_status = $auditStatus,
              ci.itil_last_audited = datetime(),
              ci.itil_audit_findings = $findings,
              ci.itil_audit_completed_by = $completedBy,
              ci.updated_at = datetime()
          RETURN ci
          `,
          { id, auditStatus, findings: findings ?? null, completedBy }
        );

        if (result.records.length === 0) {
          res.status(404).json({
            success: false,
            error: 'Not Found',
            message: `Configuration item with ID '${id}' not found`,
          });
          return;
        }

        const ci = this.convertNeo4jCI(result.records[0]!.get('ci').properties);

        res.json({
          success: true,
          data: ci,
          message: 'Audit completed successfully',
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error completing audit', error);
      res.status(500).json({
        success: false,
        error: 'Failed to complete audit',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // ============================================================================
  // Incidents
  // ============================================================================

  async createIncident(req: Request, res: Response): Promise<void> {
    try {
      const { affectedCIId, description, reportedBy, detectedAt } = req.body;

      // Verify CI exists
      const ci = await this.neo4jClient.getCI(affectedCIId);
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
      const incidentNumber = `INC-${Date.now()}`;
      const title = description.length > 500 ? `${description.slice(0, 497)}...` : description;
      const pool = this.postgresClient.pool;

      const result = await pool.query(
        `
        INSERT INTO itil_incidents (
          id, incident_number, title, description, affected_ci_id,
          reported_by, reported_at, priority, impact, urgency, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
        ]
      );

      res.status(201).json({
        success: true,
        data: result.rows[0],
        priorityCalculation: priority,
        message: `Incident created with priority P${priority.priority}`,
      });
    } catch (error) {
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
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

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
        'SELECT * FROM itil_incidents WHERE id = $1',
        [id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Incident with ID '${id}' not found`,
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

      params.push(id);
      const pool = this.postgresClient.pool;
      const result = await pool.query(
        `
        UPDATE itil_incidents
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
        `,
        params
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Incident with ID '${id}' not found`,
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
        WHERE id = $2
        RETURNING *
        `,
        [resolution, id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Incident with ID '${id}' not found`,
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
        'SELECT priority, impact, urgency FROM itil_incidents WHERE id = $1',
        [id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Incident with ID '${id}' not found`,
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

      // Verify all affected CIs exist
      for (const ciId of affectedCIIds) {
        const ci = await this.neo4jClient.getCI(ciId);
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
      const changeNumber = `CHG-${Date.now()}`;
      const title = description.length > 500 ? `${description.slice(0, 497)}...` : description;
      const scheduledStart = new Date(plannedStart);
      const scheduledEnd = new Date(scheduledStart.getTime() + plannedDuration * 60000);
      const pool = this.postgresClient.pool;

      const result = await pool.query(
        `
        INSERT INTO itil_changes (
          id, change_number, title, description, change_type,
          affected_ci_ids, requested_by,
          scheduled_start, scheduled_end, status,
          implementation_plan, backout_plan, test_plan
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
        ]
      );

      res.status(201).json({
        success: true,
        data: result.rows[0],
        message: 'Change request created successfully',
      });
    } catch (error) {
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
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (status) {
        conditions.push(`status = $${paramIndex++}`);
        params.push(String(status).toLowerCase());
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
        'SELECT * FROM itil_changes WHERE id = $1',
        [id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Change with ID '${id}' not found`,
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

      const updates: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (status) {
        updates.push(`status = $${paramIndex++}`);
        params.push(String(status).toLowerCase());
      }
      if (implementedBy) {
        updates.push(`implemented_by = $${paramIndex++}`);
        params.push(implementedBy);
      }
      if (actualDuration) {
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

      params.push(id);
      const pool = this.postgresClient.pool;
      const result = await pool.query(
        `
        UPDATE itil_changes
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
        `,
        params
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Change with ID '${id}' not found`,
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
        'SELECT * FROM itil_changes WHERE id = $1',
        [id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Change with ID '${id}' not found`,
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
        WHERE id = $1
        RETURNING *
        `,
        [id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Change with ID '${id}' not found`,
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
        WHERE id = $1
        RETURNING *
        `,
        [id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Change with ID '${id}' not found`,
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
        WHERE id = $3
        RETURNING *
        `,
        [outcome, notes, id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Change with ID '${id}' not found`,
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

      // Verify all CIs exist and snapshot their current state for baseline_data
      const ciSnapshots: Record<string, any> = {};
      for (const ciId of ciIds) {
        const ci = await this.neo4jClient.getCI(ciId);
        if (!ci) {
          res.status(404).json({
            success: false,
            error: 'Not Found',
            message: `CI with ID '${ciId}' not found`,
          });
          return;
        }
        ciSnapshots[ciId] = ci;
      }

      const baselineId = uuidv4();
      const pool = this.postgresClient.pool;

      const result = await pool.query(
        `
        INSERT INTO itil_baselines (
          id, name, description, baseline_type, scope, baseline_data, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
        `,
        [
          baselineId,
          name,
          description || null,
          'configuration',
          JSON.stringify({ ci_ids: ciIds, ci_types: [], environment: null }),
          JSON.stringify(ciSnapshots),
          createdBy,
        ]
      );

      res.status(201).json({
        success: true,
        data: result.rows[0],
        message: 'Baseline created successfully',
      });
    } catch (error) {
      logger.error('Error creating baseline', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create baseline',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async getBaselines(_req: Request, res: Response): Promise<void> {
    try {
      const pool = this.postgresClient.pool;
      const result = await pool.query(
        'SELECT * FROM itil_baselines ORDER BY created_at DESC LIMIT 100'
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
        'SELECT * FROM itil_baselines WHERE id = $1',
        [id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Baseline with ID '${id}' not found`,
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
        'DELETE FROM itil_baselines WHERE id = $1 RETURNING id',
        [id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Baseline with ID '${id}' not found`,
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

  async compareToBaseline(_req: Request, res: Response): Promise<void> {
    try {
      const { id } = _req.params;

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

  async restoreFromBaseline(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { ciId, restoreAttributes, performedBy } = req.body;

      const pool = this.postgresClient.pool;
      const baselineResult = await pool.query(
        'SELECT * FROM itil_baselines WHERE id = $1',
        [id]
      );

      if (baselineResult.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Baseline with ID '${id}' not found`,
        });
        return;
      }

      const baseline = baselineResult.rows[0];
      const snapshot = baseline.baseline_data ? baseline.baseline_data[ciId] : undefined;

      if (!snapshot) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `No snapshot for CI '${ciId}' in baseline '${id}'`,
        });
        return;
      }

      const attributeKeys: string[] =
        Array.isArray(restoreAttributes) && restoreAttributes.length > 0
          ? restoreAttributes
          : Object.keys(snapshot);

      const restoreProps: Record<string, any> = {};
      let createdAtValue: string | null = null;
      let discoveredAtValue: string | null = null;
      const restoredFieldNames: string[] = [];

      for (const key of attributeKeys) {
        if (!Object.prototype.hasOwnProperty.call(snapshot, key)) continue;

        // baseline_data snapshots retain Neo4j's underscore-prefixed field
        // names (e.g. `_type`, `_status`, `_created_at`); strip the prefix so
        // the restored value lands on the CI node's real property instead of
        // creating a stray `_`-prefixed one.
        const cleanKey = key.startsWith('_') ? key.substring(1) : key;
        // `id` is immutable, and `updated_at` is always stamped with the
        // current restore time below, so neither is settable from a snapshot.
        if (cleanKey === 'id' || cleanKey === 'updated_at') continue;

        const value = this.sanitizeBaselineValue(snapshot[key]);
        if (value === undefined) continue;

        if (cleanKey === 'created_at') {
          createdAtValue = typeof value === 'string' ? value : String(value);
        } else if (cleanKey === 'discovered_at') {
          discoveredAtValue = typeof value === 'string' ? value : String(value);
        } else {
          restoreProps[cleanKey] = value;
        }
        restoredFieldNames.push(cleanKey);
      }

      const session = this.neo4jClient.getSession();
      try {
        const result = await session.run(
          `
          MATCH (ci:CI {id: $ciId})
          SET ci += $restoreProps
          SET ci.created_at = coalesce(datetime($createdAt), ci.created_at)
          SET ci.discovered_at = coalesce(datetime($discoveredAt), ci.discovered_at)
          SET ci.updated_at = datetime()
          RETURN ci
          `,
          { ciId, restoreProps, createdAt: createdAtValue, discoveredAt: discoveredAtValue }
        );

        if (result.records.length === 0) {
          res.status(404).json({
            success: false,
            error: 'Not Found',
            message: `Configuration item with ID '${ciId}' not found`,
          });
          return;
        }

        const ci = this.convertNeo4jCI(result.records[0]!.get('ci').properties);

        logger.info('Baseline restored to CI', {
          baselineId: id,
          ciId,
          performedBy,
          restoredFields: restoredFieldNames,
        });

        res.json({
          success: true,
          data: ci,
          message: `Restored ${restoredFieldNames.length} attribute(s) from baseline '${id}' to CI '${ciId}'`,
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error restoring from baseline', error);
      res.status(500).json({
        success: false,
        error: 'Failed to restore from baseline',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // ============================================================================
  // Metrics
  // ============================================================================

  async getConfigurationAccuracy(_req: Request, res: Response): Promise<void> {
    const session = this.neo4jClient.getSession();
    try {
      // Read from Neo4j CI nodes - completeAudit writes itil_audit_status there
      const result = await session.run(`
        MATCH (ci:CI)
        WHERE ci.itil_audit_status IS NOT NULL
        RETURN
          count(CASE WHEN ci.itil_audit_status = 'COMPLIANT' THEN 1 ELSE null END) as compliantCount,
          count(ci) as totalAudited
      `);

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
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve configuration accuracy',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      await session.close();
    }
  }

  async getIncidentSummary(_req: Request, res: Response): Promise<void> {
    try {
      const pool = this.postgresClient.pool;
      const result = await pool.query(`
        SELECT
          status,
          priority,
          COUNT(*) as count
        FROM itil_incidents
        GROUP BY status, priority
        ORDER BY priority, status
      `);

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

  async getChangeSuccessRate(_req: Request, res: Response): Promise<void> {
    try {
      const pool = this.postgresClient.pool;
      const result = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE outcome = 'successful') as successful_changes,
          COUNT(*) FILTER (WHERE status = 'closed') as total_closed_changes
        FROM itil_changes
        WHERE status = 'closed'
      `);

      const successfulChanges = parseInt(result.rows[0]?.successful_changes || '0');
      const totalClosedChanges = parseInt(result.rows[0]?.total_closed_changes || '1');
      const successRate = (successfulChanges / totalClosedChanges) * 100;

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

  async getMeanTimeToResolve(_req: Request, res: Response): Promise<void> {
    try {
      const pool = this.postgresClient.pool;
      const result = await pool.query(`
        SELECT
          AVG(EXTRACT(EPOCH FROM (resolved_at - reported_at))/3600) as mttr_hours
        FROM itil_incidents
        WHERE status = 'resolved'
        AND resolved_at IS NOT NULL
      `);

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

  async getMeanTimeBetweenFailures(_req: Request, res: Response): Promise<void> {
    try {
      const pool = this.postgresClient.pool;

      // Get average time between incidents for the same CI
      const result = await pool.query(`
        WITH incident_gaps AS (
          SELECT
            affected_ci_id,
            reported_at - LAG(reported_at) OVER (PARTITION BY affected_ci_id ORDER BY reported_at) as gap
          FROM itil_incidents
        )
        SELECT
          AVG(EXTRACT(EPOCH FROM gap)/3600) as mtbf_hours
        FROM incident_gaps
        WHERE gap IS NOT NULL
      `);

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

  /**
   * Convert a baseline_data snapshot value into a Neo4j-settable primitive
   * (or array of primitives). CI snapshots captured by createBaseline hold
   * live `getCI()` property values, which include Neo4j temporal/Integer
   * types; once round-tripped through Postgres JSONB storage they arrive
   * here as plain objects shaped like `{ low, high }` (Integer) or
   * `{ year, month, day, ... }` (DateTime/Date). Cypher's `SET node += $map`
   * rejects any map value that isn't a primitive or array of primitives, so
   * those shapes -- and any other nested object such as `metadata` -- must
   * be converted before the SET, the same way createCI/updateCI already
   * stringify `metadata` and wrap ISO date strings in `datetime()`.
   */
  private sanitizeBaselineValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (Array.isArray(value)) {
      const isPrimitiveArray = value.every(
        (item) => item === null || ['string', 'number', 'boolean'].includes(typeof item)
      );
      return isPrimitiveArray ? value : JSON.stringify(value);
    }

    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;

      // Neo4j Integer shape: { low, high }
      if (isNeo4jIntegerLike(record)) {
        return neo4j.integer.toNumber(record);
      }

      // Neo4j DateTime/Date/LocalDateTime shape: { year, month, day, ... }
      if (record['year'] !== undefined && record['month'] !== undefined && record['day'] !== undefined) {
        const year = toIntegerlikeNumber(record['year']);
        const month = String(toIntegerlikeNumber(record['month'])).padStart(2, '0');
        const day = String(toIntegerlikeNumber(record['day'])).padStart(2, '0');
        const hour = String(toIntegerlikeNumber(record['hour'])).padStart(2, '0');
        const minute = String(toIntegerlikeNumber(record['minute'])).padStart(2, '0');
        const second = String(toIntegerlikeNumber(record['second'])).padStart(2, '0');
        const nanosecond = toIntegerlikeNumber(record['nanosecond']);
        const millisecond = String(Math.floor(nanosecond / 1000000)).padStart(3, '0');
        return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`;
      }

      // Any other nested object (e.g. `metadata`) - Neo4j properties cannot
      // hold maps, so persist it the same way createCI/updateCI do: as a
      // JSON string.
      return JSON.stringify(value);
    }

    return value;
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
