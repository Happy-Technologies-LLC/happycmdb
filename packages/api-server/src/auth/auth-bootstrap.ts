// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared Auth Service / Middleware Bootstrap
 *
 * AuthService and AuthMiddleware are stateless config wrappers with no
 * per-request data, but every route module that guards endpoints with
 * `authMiddleware.authenticate()` / `.requireRole()` needs an instance.
 * This module memoizes a single AuthService/AuthMiddleware pair so route
 * files (auth.routes.ts, settings.routes.ts, discovery.routes.ts, ...) can
 * share it instead of each re-deriving JWT/bcrypt config and re-wrapping a
 * fresh Neo4jAuthRepository.
 */

import { loadConfig } from '@cmdb/common';
import { AuthService } from './auth.service';
import { AuthMiddleware } from '../middleware/auth.middleware';
import { Neo4jAuthRepository } from './neo4j-auth.repository';

let authService: AuthService | null = null;
let authMiddleware: AuthMiddleware | null = null;

export function getAuthService(): AuthService {
  if (!authService) {
    const config = loadConfig();
    authService = new AuthService(config.auth, new Neo4jAuthRepository());
  }
  return authService;
}

export function getAuthMiddleware(): AuthMiddleware {
  if (!authMiddleware) {
    const config = loadConfig();
    authMiddleware = new AuthMiddleware(getAuthService(), config.auth);
  }
  return authMiddleware;
}
