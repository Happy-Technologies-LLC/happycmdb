// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Portfolio import routes (HAP-1426, PoR S5), mounted at /api/v1/portfolio/imports: the one-way import of a HappyHive
 * catalog-as-portfolio export. Admin only (plan ruling D7, provisional: Suite Contracts v2 C1 names the migration
 * principal; HAP-1615). The tenant is the token's organization; the body is the JSONL export, at most 1 MiB (413).
 */

import { Router, text } from 'express';
import { PortfolioImportController } from '../controllers/portfolio-import.controller';
import { auditMiddleware } from '../../middleware/audit.middleware';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';

export const PORTFOLIO_IMPORT_MAX_BYTES = 1_048_576;

export const portfolioImportRoutes = Router();
const controller = new PortfolioImportController();
const authMiddleware = getAuthMiddleware();

portfolioImportRoutes.use(auditMiddleware);
portfolioImportRoutes.use(authMiddleware.requireOrganization());

/**
 * @route   POST /api/v1/portfolio/imports?mode=dry_run|apply
 * @desc    Plan (dry_run, persists nothing) or apply a HappyHive export; response {import_id, mode, mapping, rejected}
 * @access  Private (admin)
 */
portfolioImportRoutes.post(
  '/',
  authMiddleware.requirePermission('admin'),
  text({ type: 'application/x-ndjson', limit: PORTFOLIO_IMPORT_MAX_BYTES }),
  controller.importPortfolio.bind(controller)
);
