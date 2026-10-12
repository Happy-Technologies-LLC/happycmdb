// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard Controller
 * REST API endpoints for Business Insights dashboards
 */

import { Request, Response } from 'express';
import { DashboardAggregateLimitError, getDashboardService } from '../../services/dashboard.service';
import { logger } from '@cmdb/common';
import { requestOrganizationId } from '../../middleware/auth.middleware';
import { BUSINESS_SERVICE_NOT_FOUND } from '../../services/business-service-ownership';
import { CITraversalLimitError } from '@cmdb/database';
import { executeBoundedAnalysis } from '../../middleware/analysis-admission';

const DASHBOARD_TIMEOUT_MS = 5000;
const GLOBAL_DASHBOARD_TIMEOUT_MS = 20_000;
class DashboardDeadlineError extends Error {}

function dashboardTimedOut(error: unknown): boolean {
  if (error instanceof DashboardDeadlineError) return true;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && (code.includes('TransactionTimedOut') || code.includes('Transaction.Terminated'));
}

export class DashboardController {
  private dashboardService = getDashboardService();

  private async executeGlobalDashboard(
    req: Request, res: Response, operation: () => Promise<unknown>, internalError: string
  ): Promise<void> {
    await executeBoundedAnalysis(req, res, async () => ({
      status: 200, body: await operation(),
    }), {
      scope: 'dashboard',
      timeoutMs: GLOBAL_DASHBOARD_TIMEOUT_MS,
      withDeadline: (_deadline, work) => work(),
      deadlineError: () => new DashboardDeadlineError(),
      failure: error => {
        if (error instanceof DashboardAggregateLimitError) {
          return { status: 503, message: 'Dashboard aggregate resource limit exceeded' };
        }
        if (dashboardTimedOut(error)) {
          return { status: 504, message: 'Dashboard analysis timed out' };
        }
        return null;
      },
      internalError,
    });
  }

  /**
   * GET /api/v1/dashboards/executive
   * Get Executive Dashboard summary data
   */
  async getExecutiveDashboard(req: Request, res: Response): Promise<void> {
    await this.executeGlobalDashboard(req, res, async () => {
      const days = parseInt(req.query.days as string) || 30;
      const timeRange = this.dashboardService.parseTimeRange(days);
      logger.info('Fetching executive dashboard', { timeRange });
      const data = await this.dashboardService.getExecutiveSummary(requestOrganizationId(req), timeRange);
      return { success: true, data, timeRange };
    }, 'Failed to fetch executive dashboard');
  }

  /**
   * GET /api/v1/dashboards/cio
   * Get CIO Dashboard metrics
   */
  async getCIODashboard(req: Request, res: Response): Promise<void> {
    await this.executeGlobalDashboard(req, res, async () => {
      const days = parseInt(req.query.days as string) || 30;
      const timeRange = this.dashboardService.parseTimeRange(days);
      logger.info('Fetching CIO dashboard', { timeRange });
      const data = await this.dashboardService.getCIOMetrics(requestOrganizationId(req), timeRange);
      return { success: true, data, timeRange };
    }, 'Failed to fetch CIO dashboard');
  }

  /**
   * GET /api/v1/dashboards/itsm
   * Get ITSM Dashboard data
   */
  async getITSMDashboard(req: Request, res: Response): Promise<void> {
    await this.executeGlobalDashboard(req, res, async () => {
      logger.info('Fetching ITSM dashboard');
      const data = await this.dashboardService.getITSMDashboard(requestOrganizationId(req));
      return { success: true, data };
    }, 'Failed to fetch ITSM dashboard');
  }

  /**
   * GET /api/v1/dashboards/finops
   * Get FinOps Dashboard data
   */
  async getFinOpsDashboard(req: Request, res: Response): Promise<void> {
    await this.executeGlobalDashboard(req, res, async () => {
      const days = parseInt(req.query.days as string) || 30;
      const timeRange = this.dashboardService.parseTimeRange(days);
      logger.info('Fetching FinOps dashboard', { timeRange });
      const data = await this.dashboardService.getFinOpsDashboard(requestOrganizationId(req), timeRange);
      return { success: true, data, timeRange };
    }, 'Failed to fetch FinOps dashboard');
  }

  /**
   * GET /api/v1/dashboards/business-service/:serviceId?
   * Get Business Service Dashboard data
   */
  async getBusinessServiceDashboard(req: Request, res: Response): Promise<void> {
    await executeBoundedAnalysis(req, res, async () => {
      const serviceId = req.params.serviceId || req.query.serviceId;
      // A repeated (array) or nested (object) ?serviceId is never a service the caller owns.
      if (typeof serviceId === 'object') {
        return { status: 404, body: BUSINESS_SERVICE_NOT_FOUND };
      }

      logger.info('Fetching business service dashboard', { serviceId });
      const data = await this.dashboardService.getBusinessServiceDashboard(requestOrganizationId(req), serviceId);
      if (data === null) {
        return { status: 404, body: BUSINESS_SERVICE_NOT_FOUND };
      }
      return { status: 200, body: { success: true, data, serviceId } };
    }, {
      scope: 'dashboard',
      timeoutMs: DASHBOARD_TIMEOUT_MS,
      withDeadline: (_deadline, operation) => operation(),
      deadlineError: () => new DashboardDeadlineError(),
      failure: error => {
        if (error instanceof CITraversalLimitError) {
          return { status: 503, message: 'CI traversal resource limit exceeded' };
        }
        if (dashboardTimedOut(error)) {
          return { status: 504, message: 'Dashboard analysis timed out' };
        }
        return null;
      },
      internalError: 'Failed to fetch business service dashboard',
    });
  }
}
