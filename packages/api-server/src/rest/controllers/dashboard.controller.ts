// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard Controller
 * REST API endpoints for Business Insights dashboards
 */

import { Request, Response } from 'express';
import { getDashboardService } from '../../services/dashboard.service';
import { logger } from '@cmdb/common';
import { requestOrganizationId } from '../../middleware/auth.middleware';
import { BUSINESS_SERVICE_NOT_FOUND } from '../../services/business-service-ownership';

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
    try {
      const serviceId = req.params.serviceId || req.query.serviceId;
      // A repeated (array) or nested (object) ?serviceId is never a service the caller owns.
      if (typeof serviceId === 'object') {
        res.status(404).json(BUSINESS_SERVICE_NOT_FOUND);
        return;
      }

      logger.info('Fetching business service dashboard', { serviceId });

      const data = await this.dashboardService.getBusinessServiceDashboard(requestOrganizationId(req), serviceId);
      if (data === null) {
        res.status(404).json(BUSINESS_SERVICE_NOT_FOUND);
        return;
      }

      res.json({
        success: true,
        data,
        serviceId,
      });
    } catch (error: any) {
      logger.error('Error fetching business service dashboard', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch business service dashboard',
        message: error.message,
      });
    }
  }
}
