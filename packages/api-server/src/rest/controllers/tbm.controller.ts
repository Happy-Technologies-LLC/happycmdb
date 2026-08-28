// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';


/**
 * A single GL account entry accepted by importGLData. Mirrors the fields the
 * tbm-cost-engine GLIntegration package models for a GL account (account
 * number/name, cost center, and the TBM cost pool it maps to).
 */
interface GLImportRecord {
  accountNumber?: string;
  accountName?: string;
  costPool?: string;
  costCenter?: string;
  department?: string;
  allocationPercentage?: number;
}

/**
 * TBM (Technology Business Management) Controller
 *
 * Handles TBM cost operations:
 * - Cost summary and reporting
 * - Cost allocation to business services and capabilities
 * - Tower-based cost analysis
 * - GL import and license management
 * - Cost trends and forecasting
 */
export class TBMController {
  private neo4jClient = getNeo4jClient();
  private postgresClient = getPostgresClient();

  // ============================================================================
  // Cost Summary Endpoints
  // ============================================================================

  async getCostSummary(req: Request, res: Response): Promise<void> {
    try {
      const session = this.neo4jClient.getSession();
      try {
        // Get total monthly cost across all CIs
        const costResult = await session.run(`
          MATCH (ci:CI)
          WHERE ci.tbm_monthly_cost IS NOT NULL
          RETURN
            sum(ci.tbm_monthly_cost) as totalMonthlyCost,
            count(ci) as totalCIs
        `);

        const totalMonthlyCost = costResult.records[0]?.get('totalMonthlyCost') || 0;
        const totalCIs = costResult.records[0]?.get('totalCIs')?.toNumber() || 0;

        // Get cost by tower
        const towerResult = await session.run(`
          MATCH (ci:CI)
          WHERE ci.tbm_resource_tower IS NOT NULL
            AND ci.tbm_monthly_cost IS NOT NULL
          RETURN
            ci.tbm_resource_tower as tower,
            sum(ci.tbm_monthly_cost) as cost,
            count(ci) as ciCount
          ORDER BY cost DESC
        `);

        const costByTower = towerResult.records.map((r: any) => ({
          tower: r.get('tower'),
          cost: r.get('cost'),
          ciCount: r.get('ciCount').toNumber(),
        }));

        res.json({
          success: true,
          data: {
            totalMonthlyCost,
            totalCIs,
            costByTower,
            currency: 'USD',
            timestamp: new Date(),
          },
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error getting cost summary', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve cost summary',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async getCostsByTower(req: Request, res: Response): Promise<void> {
    try {
      const { tower } = req.query;

      const session = this.neo4jClient.getSession();
      try {
        let query = `
          MATCH (ci:CI)
          WHERE ci.tbm_resource_tower IS NOT NULL
            AND ci.tbm_monthly_cost IS NOT NULL
        `;

        const params: any = {};

        if (tower) {
          query += ' AND ci.tbm_resource_tower = $tower';
          params.tower = tower;
        }

        query += `
          RETURN
            ci.tbm_resource_tower as tower,
            ci.tbm_sub_tower as subTower,
            ci.tbm_cost_pool as costPool,
            sum(ci.tbm_monthly_cost) as totalCost,
            count(ci) as ciCount,
            collect({id: ci.id, name: ci.name, cost: ci.tbm_monthly_cost})[..10] as topCIs
          ORDER BY totalCost DESC
        `;

        const result = await session.run(query, params);

        const costs = result.records.map((r: any) => ({
          tower: r.get('tower'),
          subTower: r.get('subTower'),
          costPool: r.get('costPool'),
          totalCost: r.get('totalCost'),
          ciCount: r.get('ciCount').toNumber(),
          topCIs: r.get('topCIs'),
        }));

        res.json({
          success: true,
          data: costs,
          count: costs.length,
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error getting costs by tower', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve costs by tower',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async getCostsByCapability(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const session = this.neo4jClient.getSession();
      try {
        // Get capability and its supporting services
        const result = await session.run(
          `
          MATCH (cap:BusinessCapability {id: $capabilityId})
          OPTIONAL MATCH (cap)-[:REALIZES]->(service:BusinessService)
          OPTIONAL MATCH (service)-[:SUPPORTED_BY]->(app:ApplicationService)
          OPTIONAL MATCH (app)-[:DEPENDS_ON|RUNS_ON*1..2]->(ci:CI)
          WHERE ci.tbm_monthly_cost IS NOT NULL
          RETURN
            cap.id as capabilityId,
            cap.name as capabilityName,
            collect(DISTINCT service.id) as serviceIds,
            sum(DISTINCT ci.tbm_monthly_cost) as totalCost,
            count(DISTINCT ci) as ciCount
          `,
          { capabilityId: id }
        );

        if (result.records.length === 0) {
          res.status(404).json({
            success: false,
            error: 'Not Found',
            message: `Business capability with ID '${id}' not found`,
          });
          return;
        }

        const record = result.records[0]!;

        res.json({
          success: true,
          data: {
            capabilityId: record.get('capabilityId'),
            capabilityName: record.get('capabilityName'),
            totalMonthlyCost: record.get('totalCost') || 0,
            ciCount: record.get('ciCount').toNumber(),
            supportingServices: record.get('serviceIds').length,
          },
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error getting costs by capability', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve costs by capability',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async getCostsByBusinessService(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const session = this.neo4jClient.getSession();
      try {
        const result = await session.run(
          `
          MATCH (service:BusinessService {id: $serviceId})
          OPTIONAL MATCH (service)-[:SUPPORTED_BY]->(app:ApplicationService)
          OPTIONAL MATCH (app)-[:DEPENDS_ON|RUNS_ON*1..2]->(ci:CI)
          WHERE ci.tbm_monthly_cost IS NOT NULL
          RETURN
            service.id as serviceId,
            service.name as serviceName,
            sum(ci.tbm_monthly_cost) as totalCost,
            count(DISTINCT ci) as ciCount,
            collect(DISTINCT ci.tbm_resource_tower) as towers
          `,
          { serviceId: id }
        );

        if (result.records.length === 0) {
          res.status(404).json({
            success: false,
            error: 'Not Found',
            message: `Business service with ID '${id}' not found`,
          });
          return;
        }

        const record = result.records[0]!;

        res.json({
          success: true,
          data: {
            serviceId: record.get('serviceId'),
            serviceName: record.get('serviceName'),
            totalMonthlyCost: record.get('totalCost') || 0,
            ciCount: record.get('ciCount').toNumber(),
            towers: record.get('towers'),
          },
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error getting costs by business service', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve costs by business service',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async getCostTrends(req: Request, res: Response): Promise<void> {
    try {
      const { months = 6 } = req.query;
      const monthsBack = Math.min(Math.max(parseInt(months as string, 10) || 6, 1), 36);

      const pool = this.postgresClient.pool;

      // Query cost history from cmdb.dim_ci, the real SCD Type-2 dimension table that
      // versions CI attributes (including TBM monthly_cost) over time; ci_snapshot does
      // not exist in any migration. Each CI version is bucketed by the month it became
      // effective, approximating a monthly cost trend from real dimensional history.
      const result = await pool.query(
        `
        SELECT
          date_trunc('month', effective_from) as month,
          sum((tbm_attributes->>'monthly_cost')::numeric) as total_cost,
          count(DISTINCT ci_id) as ci_count
        FROM cmdb.dim_ci
        WHERE effective_from >= NOW() - ($1 * INTERVAL '1 month')
          AND tbm_attributes->>'monthly_cost' IS NOT NULL
        GROUP BY date_trunc('month', effective_from)
        ORDER BY month DESC
        `,
        [monthsBack]
      );

      const trends = result.rows.map((row) => ({
        month: row.month,
        totalCost: parseFloat(row.total_cost),
        ciCount: parseInt(row.ci_count),
      }));

      res.json({
        success: true,
        data: trends,
        count: trends.length,
      });
    } catch (error) {
      logger.error('Error getting cost trends', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve cost trends',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // ============================================================================
  // Cost Allocation Endpoints
  // ============================================================================

  async allocateCosts(req: Request, res: Response): Promise<void> {
    try {
      const { sourceId, targetType, targetIds, allocationMethod, allocationRules } = req.body;

      // Validate input
      if (!sourceId || !targetType || !targetIds || !Array.isArray(targetIds)) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'sourceId, targetType, and targetIds (array) are required',
        });
        return;
      }

      // Get source CI cost
      const session = this.neo4jClient.getSession();
      try {
        const sourceResult = await session.run(
          'MATCH (ci:CI {id: $id}) RETURN ci.tbm_monthly_cost as cost',
          { id: sourceId }
        );

        if (sourceResult.records.length === 0) {
          res.status(404).json({
            success: false,
            error: 'Not Found',
            message: `CI with ID '${sourceId}' not found`,
          });
          return;
        }

        const totalCost = sourceResult.records[0]?.get('cost') || 0;

        // Allocate costs based on method
        let allocations: any[] = [];

        switch (allocationMethod) {
          case 'equal':
            allocations = this.allocateEqual(totalCost, targetIds);
            break;
          case 'usage_based':
            allocations = this.allocateUsageBased(totalCost, targetIds, allocationRules);
            break;
          case 'direct':
            allocations = [{ targetId: targetIds[0], allocatedCost: totalCost }];
            break;
          default:
            allocations = this.allocateEqual(totalCost, targetIds);
        }

        // TODO: Persist allocations to database

        res.json({
          success: true,
          data: {
            sourceId,
            totalCost,
            allocationMethod,
            allocations,
          },
          message: 'Costs allocated successfully',
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error allocating costs', error);
      res.status(500).json({
        success: false,
        error: 'Failed to allocate costs',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async getCostAllocations(req: Request, res: Response): Promise<void> {
    try {
      const { ciId } = req.params;

      // TODO: Query cost allocations from database
      // For now, return placeholder

      res.json({
        success: true,
        data: {
          ciId,
          allocations: [],
          totalAllocatedCost: 0,
        },
      });
    } catch (error) {
      logger.error('Error getting cost allocations', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve cost allocations',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // ============================================================================
  // GL and License Management
  // ============================================================================

  async importGLData(req: Request, res: Response): Promise<void> {
    try {
      const rawRecords = req.body?.records;
      const importedBy = typeof req.body?.importedBy === 'string' ? req.body.importedBy : 'gl-import';

      if (!Array.isArray(rawRecords) || rawRecords.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'records (a non-empty array of GL account entries) is required',
        });
        return;
      }

      const pool = this.postgresClient.pool;
      const imported: unknown[] = [];
      const unmatched: Array<{ record: unknown; reason: string }> = [];

      // Match each GL record to an existing TBM cost pool (the real target of GL account
      // mapping in this schema - tbm_gl_mappings/tbm_cost_pools; there is no gl_accounts or
      // gl_transactions table), then persist the mapping and roster the account code on the
      // cost pool it was matched to.
      for (const raw of rawRecords as unknown[]) {
        const record = (raw && typeof raw === 'object' ? raw : {}) as GLImportRecord;
        const { accountNumber, accountName, costPool: costPoolName } = record;

        if (!accountNumber || !accountName) {
          unmatched.push({ record, reason: 'accountNumber and accountName are required' });
          continue;
        }

        if (!costPoolName) {
          unmatched.push({ record, reason: 'No costPool specified to match against' });
          continue;
        }

        const allocationPercentage = record.allocationPercentage ?? 100;
        if (allocationPercentage < 0 || allocationPercentage > 100) {
          unmatched.push({ record, reason: 'allocationPercentage must be between 0 and 100' });
          continue;
        }

        const poolResult = await pool.query(
          'SELECT id, name, gl_account_codes FROM tbm_cost_pools WHERE name = $1',
          [costPoolName]
        );

        if (poolResult.rows.length === 0) {
          unmatched.push({ record, reason: `Cost pool '${costPoolName}' not found` });
          continue;
        }

        const costPool = poolResult.rows[0];

        const mappingResult = await pool.query(
          `
          INSERT INTO tbm_gl_mappings (
            entity_type, entity_id, entity_name, gl_account_code, gl_account_name,
            gl_cost_center, gl_business_unit, mapping_rules, created_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING *
          `,
          [
            'cost_pool',
            costPool.id,
            costPool.name,
            accountNumber,
            accountName,
            record.costCenter || null,
            record.department || null,
            JSON.stringify({
              allocation_percentage: allocationPercentage,
              allocation_driver: 'direct',
              notes: '',
            }),
            importedBy,
          ]
        );

        if (!(costPool.gl_account_codes || []).includes(accountNumber)) {
          await pool.query(
            `UPDATE tbm_cost_pools SET gl_account_codes = array_append(gl_account_codes, $1), updated_at = NOW() WHERE id = $2`,
            [accountNumber, costPool.id]
          );
        }

        imported.push(mappingResult.rows[0]);
      }

      logger.info('GL data import completed', {
        importedCount: imported.length,
        unmatchedCount: unmatched.length,
      });

      res.json({
        success: true,
        message: `Imported ${imported.length} GL account mapping(s); ${unmatched.length} record(s) could not be matched`,
        data: {
          imported,
          unmatched,
        },
      });
    } catch (error) {
      logger.error('Error importing GL data', error);
      res.status(500).json({
        success: false,
        error: 'Failed to import GL data',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async getLicenses(req: Request, res: Response): Promise<void> {
    try {
      const { vendor, status } = req.query;

      const session = this.neo4jClient.getSession();
      try {
        let query = `MATCH (ci:CI {type: 'software'}) WHERE 1=1`;
        const params: any = {};

        if (vendor) {
          query += ' AND ci.vendor = $vendor';
          params.vendor = vendor;
        }

        if (status) {
          query += ' AND ci.license_status = $status';
          params.status = status;
        }

        query += `
          RETURN ci
          ORDER BY ci.license_expiry_date ASC
          LIMIT 100
        `;

        const result = await session.run(query, params);
        const licenses = result.records.map((r: any) => r.get('ci').properties);

        res.json({
          success: true,
          data: licenses,
          count: licenses.length,
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error getting licenses', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve licenses',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async getUpcomingRenewals(req: Request, res: Response): Promise<void> {
    try {
      const { days = 90 } = req.query;

      const session = this.neo4jClient.getSession();
      try {
        const result = await session.run(
          `
          MATCH (ci:CI {type: 'software'})
          WHERE ci.license_expiry_date IS NOT NULL
            AND ci.license_expiry_date <= date() + duration({days: $days})
            AND ci.license_expiry_date >= date()
          RETURN ci
          ORDER BY ci.license_expiry_date ASC
          `,
          { days: parseInt(days as string) }
        );

        const renewals = result.records.map((r: any) => r.get('ci').properties);

        res.json({
          success: true,
          data: renewals,
          count: renewals.length,
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error getting upcoming renewals', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve upcoming renewals',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private allocateEqual(totalCost: number, targetIds: string[]): any[] {
    const costPerTarget = totalCost / targetIds.length;
    return targetIds.map((targetId) => ({
      targetId,
      allocatedCost: costPerTarget,
      allocationPercentage: (1 / targetIds.length) * 100,
    }));
  }

  private allocateUsageBased(
    totalCost: number,
    targetIds: string[],
    rules?: Record<string, number>
  ): any[] {
    if (!rules) {
      // If no rules provided, use equal allocation
      return this.allocateEqual(totalCost, targetIds);
    }

    // Calculate total weight
    const totalWeight = Object.values(rules).reduce((sum, weight) => sum + weight, 0);

    // Allocate based on weights
    return targetIds.map((targetId) => {
      const weight = rules[targetId] || 0;
      const allocatedCost = (weight / totalWeight) * totalCost;
      return {
        targetId,
        allocatedCost,
        allocationPercentage: (weight / totalWeight) * 100,
        weight,
      };
    });
  }
}
