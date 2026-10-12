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
class DashboardDeadlineError extends Error {}

function sendGlobalDashboardResourceFailure(res: Response, error: unknown): boolean {
  if (error instanceof DashboardAggregateLimitError) {
    res.status(503).json({ success: false, error: 'Dashboard aggregate resource limit exceeded' });
    return true;
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && (code.includes('TransactionTimedOut') || code.includes('Transaction.Terminated'))) {
    res.status(504).json({ success: false, error: 'Dashboard analysis timed out' });
    return true;
  }
  return false;
}

export class DashboardController {
  private dashboardService = getDashboardService();

  /**
   * GET /api/v1/dashboards/executive
   * Get Executive Dashboard summary data
   */
  async getExecutiveDashboard(req: Request, res: Response): Promise<void> {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const timeRange = this.dashboardService.parseTimeRange(days);

      logger.info('Fetching executive dashboard', { timeRange });

      const data = await this.dashboardService.getExecutiveSummary(requestOrganizationId(req), timeRange);

      res.json({
        success: true,
        data,
        timeRange,
      });
    } catch (error: any) {
      logger.error('Error fetching executive dashboard', { error });
      if (sendGlobalDashboardResourceFailure(res, error)) return;
      res.status(500).json({
        success: false,
        error: 'Failed to fetch executive dashboard',
        message: error.message,
      });
    }
  }

  /**
   * GET /api/v1/dashboards/cio
   * Get CIO Dashboard metrics
   */
  async getCIODashboard(req: Request, res: Response): Promise<void> {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const timeRange = this.dashboardService.parseTimeRange(days);

      logger.info('Fetching CIO dashboard', { timeRange });

      const data = await this.dashboardService.getCIOMetrics(requestOrganizationId(req), timeRange);

      res.json({
        success: true,
        data,
        timeRange,
      });
    } catch (error: any) {
      logger.error('Error fetching CIO dashboard', { error });
      if (sendGlobalDashboardResourceFailure(res, error)) return;
      res.status(500).json({
        success: false,
        error: 'Failed to fetch CIO dashboard',
        message: error.message,
      });
    }
  }

  /**
   * GET /api/v1/dashboards/itsm
   * Get ITSM Dashboard data
   */
  async getITSMDashboard(req: Request, res: Response): Promise<void> {
    try {
      logger.info('Fetching ITSM dashboard');

      const data = await this.dashboardService.getITSMDashboard(requestOrganizationId(req));

      res.json({
        success: true,
        data,
      });
    } catch (error: any) {
      logger.error('Error fetching ITSM dashboard', { error });
      if (sendGlobalDashboardResourceFailure(res, error)) return;
      res.status(500).json({
        success: false,
        error: 'Failed to fetch ITSM dashboard',
        message: error.message,
      });
    }
  }

  /**
   * GET /api/v1/dashboards/finops
   * Get FinOps Dashboard data
   */
  async getFinOpsDashboard(req: Request, res: Response): Promise<void> {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const timeRange = this.dashboardService.parseTimeRange(days);

      logger.info('Fetching FinOps dashboard', { timeRange });

      const data = await this.dashboardService.getFinOpsDashboard(requestOrganizationId(req), timeRange);

      res.json({
        success: true,
        data,
        timeRange,
      });
    } catch (error: any) {
      logger.error('Error fetching FinOps dashboard', { error });
      if (sendGlobalDashboardResourceFailure(res, error)) return;
      res.status(500).json({
        success: false,
        error: 'Failed to fetch FinOps dashboard',
        message: error.message,
      });
    }
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
        if (error instanceof DashboardDeadlineError) {
          return { status: 504, message: 'Dashboard analysis timed out' };
        }
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (typeof code === 'string' && (code.includes('TransactionTimedOut') || code.includes('Transaction.Terminated'))) {
          return { status: 504, message: 'Dashboard analysis timed out' };
        }
        return null;
      },
      internalError: 'Failed to fetch business service dashboard',
    });
  }
}
