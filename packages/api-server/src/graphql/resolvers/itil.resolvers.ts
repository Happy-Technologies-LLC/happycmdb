// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/graphql/resolvers/itil.resolvers.ts

import { GraphQLError } from 'graphql';
import { getPostgresClient } from '@cmdb/database';
import { GraphQLContext } from './index';
import { logger } from '@cmdb/common';

/**
 * ITIL GraphQL Resolvers
 *
 * NOTE: This implements the GraphQL API contract. The actual business logic
 * will be implemented by Agent 5 in the @cmdb/itil-service-manager package.
 * For now, we provide placeholder implementations that interact with the database directly.
 */

const Query = {
  // Configuration Items
  configurationItems: async (
    _parent: any,
    args: {
      lifecycle?: string;
      status?: string;
      ciType?: string;
      page?: number;
      limit?: number;
    },
    context: GraphQLContext
  ) => {
    const session = context._neo4jClient.getSession();
    try {
      const { lifecycle, status, ciType, page = 1, limit = 50 } = args;

      let query = 'MATCH (ci:CI) WHERE 1=1';
      const params: any = {};

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
        params.ciType = ciType.toLowerCase().replace(/_/g, '-');
      }

      const countResult = await session.run(query + ' RETURN count(ci) as total', params);
      const total = countResult.records[0]!.get('total').toNumber();

      const offset = (page - 1) * limit;
      query += ' RETURN ci ORDER BY ci.name SKIP $offset LIMIT $limit';
      params.offset = offset;
      params.limit = limit;

      const result = await session.run(query, params);
      const items = result.records.map((r: any) => r.get('ci').properties);

      return {
        items,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      };
    } catch (error: any) {
      logger.error('Error fetching configuration items', error);
      throw new GraphQLError('Failed to fetch configuration items', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    } finally {
      await session.close();
    }
  },

  configurationItem: async (_parent: any, args: { id: string }, context: GraphQLContext) => {
    try {
      return await context._loaders._ciLoader.load(args.id);
    } catch (error: any) {
      logger.error('Error fetching configuration item', error);
      throw new GraphQLError('Failed to fetch configuration item', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    }
  },

  ciHistory: async (_parent: any, args: { id: string; limit?: number }, context: GraphQLContext) => {
    const pool = getPostgresClient().pool;
    try {
      const result = await pool.query(
        'SELECT * FROM ci_history WHERE ci_id = $1 ORDER BY changed_at DESC LIMIT $2',
        [args.id, args.limit || 100]
      );
      return result.rows;
    } catch (error: any) {
      logger.error('Error fetching CI history', error);
      throw new GraphQLError('Failed to fetch CI history', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    }
  },

  cisDueForAudit: async (_parent: any, args: { limit?: number }, context: GraphQLContext) => {
    const session = context._neo4jClient.getSession();
    try {
      const result = await session.run(
        `
        MATCH (ci:CI)
        WHERE ci.itil_next_audit_date <= datetime()
        OR ci.itil_last_audited IS NULL
        RETURN ci
        ORDER BY ci.itil_next_audit_date
        LIMIT $limit
        `,
        { limit: args.limit || 100 }
      );
      return result.records.map((r: any) => r.get('ci').properties);
    } catch (error: any) {
      logger.error('Error fetching CIs due for audit', error);
      throw new GraphQLError('Failed to fetch CIs due for audit', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    } finally {
      await session.close();
    }
  },

  configurationAccuracy: async (_parent: any, _args: any, context: GraphQLContext) => {
    const session = context._neo4jClient.getSession();
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

      return {
        accuracy: parseFloat(accuracy.toFixed(2)),
        compliantCount,
        totalAudited,
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      logger.error('Error calculating configuration accuracy', error);
      throw new GraphQLError('Failed to calculate configuration accuracy', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    } finally {
      await session.close();
    }
  },

  // Incidents
  incidents: async (_parent: any, args: any) => {
    const pool = getPostgresClient().pool;
    try {
      const { status, priority, affectedCIId, page = 1, limit = 50 } = args;
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (status) {
        conditions.push(`status = $${paramIndex++}`);
        params.push(status);
      }
      if (priority) {
        conditions.push(`priority = $${paramIndex++}`);
        params.push(priority);
      }
      if (affectedCIId) {
        conditions.push(`affected_ci_id = $${paramIndex++}`);
        params.push(affectedCIId);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM itil_incidents ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0]!.total);

      const offset = (page - 1) * limit;
      params.push(limit, offset);
      const result = await pool.query(
        `SELECT * FROM itil_incidents ${whereClause} ORDER BY reported_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
        params
      );

      return {
        items: result.rows,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      };
    } catch (error: any) {
      logger.error('Error fetching incidents', error);
      throw new GraphQLError('Failed to fetch incidents', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    }
  },

  incident: async (_parent: any, args: { id: string }) => {
    const pool = getPostgresClient().pool;
    try {
      const result = await pool.query('SELECT * FROM itil_incidents WHERE id = $1', [args.id]);
      return result.rows[0] || null;
    } catch (error: any) {
      logger.error('Error fetching incident', error);
      throw new GraphQLError('Failed to fetch incident', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    }
  },

  incidentMetrics: async () => {
    const pool = getPostgresClient().pool;
    try {
      const [totalResult, statusResult, priorityResult, mttrResult, mtbfResult] = await Promise.all([
        pool.query('SELECT COUNT(*) as total FROM itil_incidents'),
        pool.query('SELECT status, COUNT(*) as count FROM itil_incidents GROUP BY status'),
        pool.query('SELECT priority, COUNT(*) as count FROM itil_incidents GROUP BY priority'),
        pool.query(`
          SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - reported_at))/3600) as mttr_hours
          FROM itil_incidents WHERE status = 'RESOLVED' AND resolved_at IS NOT NULL
        `),
        pool.query(`
          WITH incident_gaps AS (
            SELECT affected_ci_id,
              reported_at - LAG(reported_at) OVER (PARTITION BY affected_ci_id ORDER BY reported_at) as gap
            FROM itil_incidents
          )
          SELECT AVG(EXTRACT(EPOCH FROM gap)/3600) as mtbf_hours
          FROM incident_gaps WHERE gap IS NOT NULL
        `),
      ]);

      return {
        totalIncidents: parseInt(totalResult.rows[0]?.total || '0'),
        byStatus: statusResult.rows,
        byPriority: priorityResult.rows,
        mttr: parseFloat(mttrResult.rows[0]?.mttr_hours || '0'),
        mtbf: parseFloat(mtbfResult.rows[0]?.mtbf_hours || '0'),
      };
    } catch (error: any) {
      logger.error('Error fetching incident metrics', error);
      throw new GraphQLError('Failed to fetch incident metrics', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    }
  },

  // Changes
  changes: async (_parent: any, args: any) => {
    const pool = getPostgresClient().pool;
    try {
      const { status, changeType, requestedBy, page = 1, limit = 50 } = args;
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (status) {
        conditions.push(`status = $${paramIndex++}`);
        params.push(status);
      }
      if (changeType) {
        conditions.push(`change_type = $${paramIndex++}`);
        params.push(changeType);
      }
      if (requestedBy) {
        conditions.push(`requested_by = $${paramIndex++}`);
        params.push(requestedBy);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM itil_changes ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0]!.total);

      const offset = (page - 1) * limit;
      params.push(limit, offset);
      const result = await pool.query(
        `SELECT * FROM itil_changes ${whereClause} ORDER BY requested_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
        params
      );

      return {
        items: result.rows,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      };
    } catch (error: any) {
      logger.error('Error fetching changes', error);
      throw new GraphQLError('Failed to fetch changes', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    }
  },

  change: async (_parent: any, args: { id: string }) => {
    const pool = getPostgresClient().pool;
    try {
      const result = await pool.query('SELECT * FROM itil_changes WHERE id = $1', [args.id]);
      return result.rows[0] || null;
    } catch (error: any) {
      logger.error('Error fetching change', error);
      throw new GraphQLError('Failed to fetch change', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    }
  },

  changeMetrics: async () => {
    const pool = getPostgresClient().pool;
    try {
      const [totalResult, successResult, typeResult] = await Promise.all([
        pool.query('SELECT COUNT(*) as total FROM itil_changes'),
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE result = 'SUCCESS') as successful,
            COUNT(*) FILTER (WHERE result IN ('FAILED', 'ROLLED_BACK')) as failed
          FROM itil_changes WHERE status = 'CLOSED'
        `),
        pool.query(`
          SELECT change_type,
            COUNT(*) as count,
            COUNT(*) FILTER (WHERE result = 'SUCCESS') as successful
          FROM itil_changes WHERE status = 'CLOSED'
          GROUP BY change_type
        `),
      ]);

      const total = parseInt(totalResult.rows[0]?.total || '0');
      const successful = parseInt(successResult.rows[0]?.successful || '0');
      const failed = parseInt(successResult.rows[0]?.failed || '0');
      const successRate = total > 0 ? (successful / (successful + failed)) * 100 : 0;

      return {
        totalChanges: total,
        successfulChanges: successful,
        failedChanges: failed,
        successRate: parseFloat(successRate.toFixed(2)),
        byType: typeResult.rows.map((row: any) => ({
          changeType: row.change_type,
          count: parseInt(row.count),
          successRate: row.count > 0 ? (parseInt(row.successful) / parseInt(row.count)) * 100 : 0,
        })),
      };
    } catch (error: any) {
      logger.error('Error fetching change metrics', error);
      throw new GraphQLError('Failed to fetch change metrics', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    }
  },

  // Baselines
  baselines: async (_parent: any, args: { limit?: number }) => {
    const pool = getPostgresClient().pool;
    try {
      const result = await pool.query(
        'SELECT * FROM itil_baselines ORDER BY snapshot_date DESC LIMIT $1',
        [args.limit || 100]
      );
      return result.rows;
    } catch (error: any) {
      logger.error('Error fetching baselines', error);
      throw new GraphQLError('Failed to fetch baselines', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    }
  },

  baseline: async (_parent: any, args: { id: string }) => {
    const pool = getPostgresClient().pool;
    try {
      const result = await pool.query('SELECT * FROM itil_baselines WHERE id = $1', [args.id]);
      return result.rows[0] || null;
    } catch (error: any) {
      logger.error('Error fetching baseline', error);
      throw new GraphQLError('Failed to fetch baseline', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    }
  },

  baselineComparison: async (_parent: any, args: { id: string }) => {
    // TODO: Implement baseline comparison logic
    return {
      baseline: await Query.baseline(_parent, args),
      comparisonDate: new Date().toISOString(),
      driftedCIs: [],
      totalDriftCount: 0,
      driftPercentage: 0,
    };
  },
};

const Mutation = {
  // Configuration Management
  updateLifecycleStage: async (_parent: any, args: { id: string; stage: string }, context: GraphQLContext) => {
    const session = context._neo4jClient.getSession();
    try {
      await session.run(
        'MATCH (ci:CI {id: $id}) SET ci.itil_lifecycle = $stage, ci.updated_at = datetime() RETURN ci',
        { id: args.id, stage: args.stage }
      );
      context._loaders._ciLoader.clear(args.id);
      return await context._loaders._ciLoader.load(args.id);
    } catch (error: any) {
      logger.error('Error updating lifecycle stage', error);
      throw new GraphQLError('Failed to update lifecycle stage', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    } finally {
      await session.close();
    }
  },

  updateConfigurationStatus: async (_parent: any, args: { id: string; status: string }, context: GraphQLContext) => {
    const session = context._neo4jClient.getSession();
    try {
      await session.run(
        'MATCH (ci:CI {id: $id}) SET ci.itil_config_status = $status, ci.updated_at = datetime() RETURN ci',
        { id: args.id, status: args.status }
      );
      context._loaders._ciLoader.clear(args.id);
      return await context._loaders._ciLoader.load(args.id);
    } catch (error: any) {
      logger.error('Error updating configuration status', error);
      throw new GraphQLError('Failed to update configuration status', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    } finally {
      await session.close();
    }
  },

  // createIncident, updateIncident, resolveIncident
  // createChange, updateChange, approveChange, implementChange, closeChange
  // createBaseline, deleteBaseline, restoreFromBaseline
  // (Implementations follow similar patterns - omitted for brevity)
};

const CI = {
  itilAttributes: (parent: any) => {
    return {
      ciClass: parent.itil_class || null,
      lifecycleStage: parent.itil_lifecycle || null,
      configurationStatus: parent.itil_config_status || null,
      version: parent.itil_version || null,
      baselineId: parent.itil_baseline_id || null,
      lastAudited: parent.itil_last_audited || null,
      auditStatus: parent.itil_audit_status || null,
      nextAuditDate: parent.itil_next_audit_date || null,
    };
  },

  history: async (parent: any, args: { limit?: number }) => {
    const pool = getPostgresClient().pool;
    const result = await pool.query(
      'SELECT * FROM ci_history WHERE ci_id = $1 ORDER BY changed_at DESC LIMIT $2',
      [parent.id, args.limit || 100]
    );
    return result.rows;
  },

  incidents: async (parent: any, args: { status?: string; limit?: number }) => {
    const pool = getPostgresClient().pool;
    let query = 'SELECT * FROM itil_incidents WHERE affected_ci_id = $1';
    const params: any[] = [parent.id];

    if (args.status) {
      query += ' AND status = $2';
      params.push(args.status);
    }

    query += ' ORDER BY reported_at DESC LIMIT $' + (params.length + 1);
    params.push(args.limit || 50);

    const result = await pool.query(query, params);
    return result.rows;
  },

  changes: async (parent: any, args: { status?: string; limit?: number }) => {
    const pool = getPostgresClient().pool;
    let query = `SELECT * FROM itil_changes WHERE affected_ci_ids::jsonb ? $1`;
    const params: any[] = [parent.id];

    if (args.status) {
      query += ' AND status = $2';
      params.push(args.status);
    }

    query += ' ORDER BY requested_at DESC LIMIT $' + (params.length + 1);
    params.push(args.limit || 50);

    const result = await pool.query(query, params);
    return result.rows;
  },
};

const Incident = {
  affectedCI: async (parent: any, _args: any, context: GraphQLContext) => {
    return await context._loaders._ciLoader.load(parent.affected_ci_id);
  },

  symptoms: (parent: any) => {
    return typeof parent.symptoms === 'string' ? JSON.parse(parent.symptoms) : parent.symptoms || [];
  },

  affectedBusinessServices: () => {
    // TODO: Implement business service lookup
    return [];
  },
};

const Change = {
  affectedCIs: async (parent: any, _args: any, context: GraphQLContext) => {
    const ciIds = typeof parent.affected_ci_ids === 'string'
      ? JSON.parse(parent.affected_ci_ids)
      : parent.affected_ci_ids || [];
    return await Promise.all(ciIds.map((id: string) => context._loaders._ciLoader.load(id)));
  },

  riskAssessment: () => {
    // TODO: Implement risk assessment calculation
    return null;
  },
};

const ConfigurationBaseline = {
  cis: async (parent: any, _args: any, context: GraphQLContext) => {
    const ciIds = typeof parent.ci_ids === 'string' ? JSON.parse(parent.ci_ids) : parent.ci_ids || [];
    return await Promise.all(ciIds.map((id: string) => context._loaders._ciLoader.load(id)));
  },
};

export const itilResolvers = {
  Query,
  Mutation,
  CI,
  Incident,
  Change,
  ConfigurationBaseline,
};
