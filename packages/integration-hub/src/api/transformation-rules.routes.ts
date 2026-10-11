// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Transformation rules and lookup tables are globally scoped, with no tenant
 * ownership column. Until dedicated platform-admin authority exists, deny
 * every caller before parsing or identity lookups can fail or reach storage.
 * This router remains fail-closed even when mounted independently.
 */
import { Router } from 'express';

export const transformationRulesRouter = Router();
const UNAVAILABLE = { error: 'TRANSFORMATION_RULES_UNAVAILABLE' };

transformationRulesRouter.use((_req, res) => {
  res.status(403).json(UNAVAILABLE);
});
