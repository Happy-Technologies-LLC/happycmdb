// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Authentication Routes
 * Routes for user authentication, token management, and API key operations
 */

import { Router } from 'express';
import { AuthController } from '../auth.controller';
import { ValidationMiddleware } from '../middleware/validation.middleware';
import { RateLimitMiddleware } from '../../middleware/rate-limit.middleware';
import { getRedisClient } from '@cmdb/database';
import { loadConfig } from '@cmdb/common';
import { getAuthService, getAuthMiddleware } from '../../auth/auth-bootstrap';

// Create router
const router = Router();

// Load configuration
const config = loadConfig();

// Shared AuthService / AuthMiddleware (see auth/auth-bootstrap.ts). The
// Neo4j+Postgres repository behind AuthService now lives in
// auth/neo4j-auth.repository.ts.
const authService = getAuthService();
const validationMiddleware = new ValidationMiddleware();
const authMiddleware = getAuthMiddleware();
const rateLimitMiddleware = new RateLimitMiddleware(getRedisClient().getConnection(), config.rateLimit);

// Create controller
const authController = new AuthController(
  authService,
  validationMiddleware,
  authMiddleware,
  rateLimitMiddleware
);

// Mount controller routes
router.use('/', authController.getRouter());

export { router as authRoutes };
