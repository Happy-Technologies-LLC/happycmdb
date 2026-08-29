// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration Hub - Transformation Rules API Routes
 */

import { Router } from 'express';
import { getPostgresClient } from '@cmdb/database';
import { TransformationEngine } from '@cmdb/data-mapper';
import { logger } from '@cmdb/common';

export const transformationRulesRouter = Router();
const postgresClient = getPostgresClient();
const transformationEngine = new TransformationEngine();

/**
 * List all transformation rules
 */
transformationRulesRouter.get('/', async (req, res) => {
  try {
    const { connector_type, enabled } = req.query;

    let query = 'SELECT * FROM transformation_rules WHERE 1=1';
    const params: any[] = [];

    if (connector_type) {
      params.push(connector_type);
      query += ` AND connector_type = $${params.length}`;
    }

    if (enabled !== undefined) {
      params.push(enabled === 'true');
      query += ` AND enabled = $${params.length}`;
    }

    query += ' ORDER BY created_at DESC';

    const result = await postgresClient.query(query, params);
    res.json({ rules: result.rows });
  } catch (error) {
    logger.error('Failed to list transformation rules', { error });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Get transformation rule by ID
 */
transformationRulesRouter.get('/:id', async (req, res) => {
  try {
    const result = await postgresClient.query(
      'SELECT * FROM transformation_rules WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }

    res.json({ rule: result.rows[0] });
  } catch (error) {
    logger.error('Failed to get transformation rule', { error });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Create new transformation rule
 */
transformationRulesRouter.post('/', async (req, res) => {
  try {
    const {
      connector_type,
      name,
      description,
      enabled = true,
      version = '1.0.0',
      created_by = 'system',
      field_mappings = [],
      conditions = [],
      validations = [],
    } = req.body;

    const result = await postgresClient.query(
      `INSERT INTO transformation_rules
       (connector_type, name, description, enabled, version, created_by,
        field_mappings, conditions, validations)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        connector_type,
        name,
        description,
        enabled,
        version,
        created_by,
        JSON.stringify(field_mappings),
        JSON.stringify(conditions),
        JSON.stringify(validations),
      ]
    );

    res.status(201).json({ rule: result.rows[0] });
  } catch (error) {
    logger.error('Failed to create transformation rule', { error });
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * Update transformation rule
 */
transformationRulesRouter.put('/:id', async (req, res) => {
  try {
    const {
      name,
      description,
      enabled,
      field_mappings,
      conditions,
      validations,
    } = req.body;

    const result = await postgresClient.query(
      `UPDATE transformation_rules
       SET name = COALESCE($2, name),
           description = COALESCE($3, description),
           enabled = COALESCE($4, enabled),
           field_mappings = COALESCE($5, field_mappings),
           conditions = COALESCE($6, conditions),
           validations = COALESCE($7, validations),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        req.params.id,
        name,
        description,
        enabled,
        field_mappings ? JSON.stringify(field_mappings) : null,
        conditions ? JSON.stringify(conditions) : null,
        validations ? JSON.stringify(validations) : null,
      ]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }

    res.json({ rule: result.rows[0] });
  } catch (error) {
    logger.error('Failed to update transformation rule', { error });
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * Delete transformation rule
 */
transformationRulesRouter.delete('/:id', async (req, res) => {
  try {
    await postgresClient.query(
      'DELETE FROM transformation_rules WHERE id = $1',
      [req.params.id]
    );

    res.status(204).send();
  } catch (error) {
    logger.error('Failed to delete transformation rule', { error });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Test transformation rule with sample data
 */
transformationRulesRouter.post('/:id/test', async (req, res) => {
  try {
    const { sample_data } = req.body;

    const ruleResult = await postgresClient.query(
      'SELECT * FROM transformation_rules WHERE id = $1',
      [req.params.id]
    );

    if (ruleResult.rows.length === 0) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }

    const rule = ruleResult.rows[0];

    // Load lookup tables
    const lookupResult = await postgresClient.query(
      'SELECT name, data FROM transformation_lookup_tables'
    );

    const lookupTables: Record<string, any> = {};
    for (const row of lookupResult.rows) {
      lookupTables[row.name] = row.data;
    }

    // Execute transformation
    const result = await transformationEngine.transform(rule, {
      source_data: sample_data,
      connector_type: rule.connector_type,
      metadata: {},
      lookup_tables: lookupTables,
    });

    res.json({ result });
  } catch (error) {
    logger.error('Failed to test transformation', { error });
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * Clone transformation rule
 */
transformationRulesRouter.post('/:id/clone', async (req, res) => {
  try {
    const { name } = req.body;

    const existingResult = await postgresClient.query(
      'SELECT * FROM transformation_rules WHERE id = $1',
      [req.params.id]
    );

    if (existingResult.rows.length === 0) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }

    const existing = existingResult.rows[0];

    const result = await postgresClient.query(
      `INSERT INTO transformation_rules
       (connector_type, name, description, enabled, version, created_by,
        field_mappings, conditions, validations)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        existing.connector_type,
        name,
        existing.description,
        existing.enabled,
        existing.version,
        existing.created_by,
        JSON.stringify(existing.field_mappings),
        JSON.stringify(existing.conditions),
        JSON.stringify(existing.validations),
      ]
    );

    res.status(201).json({ rule: result.rows[0] });
  } catch (error) {
    logger.error('Failed to clone transformation rule', { error });
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * Lookup Tables endpoints
 */

/**
 * List lookup tables
 */
transformationRulesRouter.get('/lookups', async (_req, res) => {
  try {
    const result = await postgresClient.query(
      'SELECT id, name, description, created_at, updated_at FROM transformation_lookup_tables ORDER BY name'
    );

    res.json({ lookup_tables: result.rows });
  } catch (error) {
    logger.error('Failed to list lookup tables', { error });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Create lookup table
 */
transformationRulesRouter.post('/lookups', async (req, res) => {
  try {
    const { name, description, data } = req.body;

    const result = await postgresClient.query(
      `INSERT INTO transformation_lookup_tables (name, description, data)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, description, JSON.stringify(data)]
    );

    res.status(201).json({ lookup_table: result.rows[0] });
  } catch (error) {
    logger.error('Failed to create lookup table', { error });
    res.status(400).json({ error: (error as Error).message });
  }
});
