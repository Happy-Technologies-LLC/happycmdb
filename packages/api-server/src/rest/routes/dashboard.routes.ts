// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard Routes
 * REST API routes for Business Insights dashboards
 */

import { Router } from 'express';
import Joi from 'joi';
import { DashboardController } from '../controllers/dashboard.controller';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';
import { validateOptional } from '../middleware/validation.middleware';

const router = Router();
const dashboardController = new DashboardController();

// `days` is echoed in `timeRange` and fed to Date arithmetic: a non-integer, a
// non-positive value or one past the Date range must be a 400, not a 500 or a
// future startDate. Ten years is a generous ceiling; the dashboards UI offers
// 7, 30, 90 and 365. Other query keys are stripped by validate(), not refused.
const daysQuerySchema = Joi.object({ days: Joi.number().integer().min(1).max(3650).default(30) });

// Tenant scoping: a token without an org claim is rejected with 403 before any
// data access. Every dashboard is computed from the caller organization's CIs
// and business services only.
router.use(getAuthMiddleware().requireOrganization());

/**
 * @route GET /api/v1/dashboards/executive
 * @desc Get Executive Dashboard summary data
 * @query {number} days - Time range in days (integer 1 to 3650, default: 30)
 */
router.get('/executive', validateOptional(daysQuerySchema, 'query'), (req, res) => dashboardController.getExecutiveDashboard(req, res));

/**
 * @route GET /api/v1/dashboards/cio
 * @desc Get CIO Dashboard metrics
 * @query {number} days - Time range in days (integer 1 to 3650, default: 30)
 */
router.get('/cio', validateOptional(daysQuerySchema, 'query'), (req, res) => dashboardController.getCIODashboard(req, res));

/**
 * @route GET /api/v1/dashboards/itsm
 * @desc Get ITSM Dashboard data
 */
router.get('/itsm', (req, res) => dashboardController.getITSMDashboard(req, res));

/**
 * @route GET /api/v1/dashboards/finops
 * @desc Get FinOps Dashboard data
 * @query {number} days - Time range in days (integer 1 to 3650, default: 30)
 */
router.get('/finops', validateOptional(daysQuerySchema, 'query'), (req, res) => dashboardController.getFinOpsDashboard(req, res));

/**
 * @route GET /api/v1/dashboards/business-service/:serviceId?
 * @desc Get Business Service Dashboard data
 * @param {string} serviceId - Optional service ID to filter by
 */
router.get('/business-service/:serviceId?', (req, res) => dashboardController.getBusinessServiceDashboard(req, res));

export { router as dashboardRoutes };
