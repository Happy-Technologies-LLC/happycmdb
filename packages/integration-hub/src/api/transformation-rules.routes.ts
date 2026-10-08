// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Transformation rules and lookup tables are globally scoped, with no tenant
 * ownership column. Until the dedicated platform-admin authority is available,
 * authentication is attempted but every HTTP caller receives the same denial.
 * This router stays fail-closed even if mounted directly by a trusted consumer.
 */
import { Router } from 'express';
import { getAuthMiddleware } from '@cmdb/api-server/auth/auth-bootstrap';

export const transformationRulesRouter = Router();
const UNAVAILABLE = { error: 'TRANSFORMATION_RULES_UNAVAILABLE' };

transformationRulesRouter.use(getAuthMiddleware().optionalAuthenticate(), (_req, res) => {
  res.status(403).json(UNAVAILABLE);
});
