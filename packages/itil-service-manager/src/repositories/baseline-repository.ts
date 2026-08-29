// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Baseline Repository
 * Database access layer for ITIL Configuration Baselines
 */

import { getPostgresClient } from '@cmdb/database';
import { ConfigurationBaseline } from '../types';
import { v4 as uuidv4 } from 'uuid';

export class BaselineRepository {
  /**
   * Create a new baseline
   */
  async createBaseline(
    name: string,
    description: string,
    baselineType: 'configuration' | 'security' | 'performance' | 'compliance',
    scope: {
      ciIds: string[];
      ciTypes: string[];
      environment: string | null;
    },
    baselineData: Record<string, any>,
    createdBy: string
  ): Promise<ConfigurationBaseline> {
    const postgres = getPostgresClient();

    const result = await postgres.query(
      `
      INSERT INTO itil_baselines (
        id, name, description, baseline_type, scope, baseline_data,
        status, created_by, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
      `,
      [
        uuidv4(),
        name,
        description,
        baselineType,
        JSON.stringify(scope),
        JSON.stringify(baselineData),
        'draft',
        createdBy,
        new Date(),
        new Date(),
      ]
    );

    return this.rowToBaseline(result.rows[0]);
  }

  /**
   * Get baseline by ID
   */
  async getBaselineById(id: string): Promise<ConfigurationBaseline | null> {
    const postgres = getPostgresClient();

    const result = await postgres.query(
      `
      SELECT * FROM itil_baselines
      WHERE id = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.rowToBaseline(result.rows[0]);
  }

  /**
   * Get baseline by name
   */
  async getBaselineByName(name: string): Promise<ConfigurationBaseline | null> {
    const postgres = getPostgresClient();

    const result = await postgres.query(
      `
      SELECT * FROM itil_baselines
      WHERE name = $1
      `,
      [name]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.rowToBaseline(result.rows[0]);
  }

  /**
   * Get all baselines
   */
  async getAllBaselines(limit: number = 100): Promise<ConfigurationBaseline[]> {
    const postgres = getPostgresClient();

    const result = await postgres.query(
      `
      SELECT * FROM itil_baselines
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit]
    );

    return result.rows.map(this.rowToBaseline);
  }

  /**
   * Get approved baselines
   */
  async getApprovedBaselines(limit: number = 100): Promise<ConfigurationBaseline[]> {
    const postgres = getPostgresClient();

    const result = await postgres.query(
      `
      SELECT * FROM itil_baselines
      WHERE status = 'approved'
      ORDER BY approved_at DESC
      LIMIT $1
      `,
      [limit]
    );

    return result.rows.map(this.rowToBaseline);
  }

  /**
   * Update baseline status
   */
  async updateBaselineStatus(
    id: string,
    status: 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'deprecated',
    approvedBy?: string
  ): Promise<ConfigurationBaseline> {
    const postgres = getPostgresClient();

    const result = await postgres.query(
      `
      UPDATE itil_baselines
      SET status = $1,
          approved_by = $2,
          approved_at = CASE WHEN $3 = 'approved' THEN NOW() ELSE approved_at END,
          updated_at = NOW()
      WHERE id = $4
      RETURNING *
      `,
      [status, approvedBy, status, id]
    );

    return this.rowToBaseline(result.rows[0]);
  }

  /**
   * Delete baseline
   */
  async deleteBaseline(id: string): Promise<void> {
    const postgres = getPostgresClient();

    await postgres.query(
      `
      DELETE FROM itil_baselines
      WHERE id = $1
      `,
      [id]
    );
  }

  /**
   * Get baselines by CI ID
   * Returns baselines that include the specified CI
   */
  async getBaselinesByCIId(ciId: string): Promise<ConfigurationBaseline[]> {
    const postgres = getPostgresClient();

    const result = await postgres.query(
      `
      SELECT * FROM itil_baselines
      WHERE scope->'ciIds' ? $1
      ORDER BY created_at DESC
      `,
      [ciId]
    );

    return result.rows.map(this.rowToBaseline);
  }

  /**
   * Get baselines by type
   */
  async getBaselinesByType(
    type: 'configuration' | 'security' | 'performance' | 'compliance'
  ): Promise<ConfigurationBaseline[]> {
    const postgres = getPostgresClient();

    const result = await postgres.query(
      `
      SELECT * FROM itil_baselines
      WHERE baseline_type = $1
      ORDER BY created_at DESC
      `,
      [type]
    );

    return result.rows.map(this.rowToBaseline);
  }

  /**
   * Convert database row to ConfigurationBaseline
   */
  private rowToBaseline(row: any): ConfigurationBaseline {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      baselineType: row.baseline_type,
      scope: row.scope,
      baselineData: row.baseline_data,
      status: row.status,
      createdBy: row.created_by,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
