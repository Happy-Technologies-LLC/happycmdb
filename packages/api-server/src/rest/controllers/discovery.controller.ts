// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { queueManager, QUEUE_NAMES } from '@cmdb/database';
import { logger, DiscoveryJob, DiscoveryProvider } from '@cmdb/common';
import { v4 as uuidv4 } from 'uuid';

export class DiscoveryController {
  /**
   * Sanitize job config by redacting sensitive fields
   */
  private sanitizeJobData(jobData: any): any {
    if (!jobData) return jobData;

    const sanitized = { ...jobData };

    // Sanitize config object
    if (sanitized.config) {
      sanitized.config = { ...sanitized.config };

      // Redact credentials object
      if (sanitized.config.credentials) {
        const credKeys = Object.keys(sanitized.config.credentials);
        sanitized.config.credentials = credKeys.reduce((acc: any, key: string) => {
          acc[key] = '***REDACTED***';
          return acc;
        }, {});
      }

      // Redact common secret fields
      const secretFields = ['password', 'secret', 'secretKey', 'secretAccessKey', 'apiKey', 'token', 'privateKey'];
      secretFields.forEach(field => {
        if (sanitized.config[field]) {
          sanitized.config[field] = '***REDACTED***';
        }
      });
    }

    return sanitized;
  }

  /**
   * Schedule a new discovery job
   * POST /discovery/schedule
   */
  async scheduleDiscovery(req: Request, res: Response): Promise<void> {
    try {
      const { provider, config } = req.body;

      // Validate provider
      if (!provider) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Provider is required'
        });
        return;
      }

      // Map provider to queue name
      // NOTE: Cloud/API providers (AWS, Azure, GCP, Kubernetes, etc.) are now handled by Connectors
      const queueNameMap: Record<DiscoveryProvider, string> = {
        nmap: QUEUE_NAMES._DISCOVERY_NMAP,
        ssh: QUEUE_NAMES._DISCOVERY_SSH,
        'active-directory': 'discovery:active-directory',
        snmp: 'discovery:snmp',
      };

      const queueName = queueNameMap[provider as DiscoveryProvider];
      if (!queueName) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `Unsupported provider: ${provider}`
        });
        return;
      }

      // Create job ID
      const jobId = uuidv4();

      // Create discovery job object
      const discoveryJob: Partial<DiscoveryJob> = {
        id: jobId,
        provider: provider as DiscoveryProvider,
        method: 'agentless',
        config: config || {},
        status: 'pending',
        created_at: new Date().toISOString(),
      };

      // Get queue and add job
      const queue = queueManager.getQueue(queueName);
      await queue.add(
        'discover',
        discoveryJob,
        {
          jobId,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        }
      );

      logger.info(`Discovery job scheduled: ${jobId}`, {
        provider,
        queueName,
      });

      res.status(201).json({
        success: true,
        data: {
          id: jobId,
          provider,
          status: 'pending',
          created_at: discoveryJob.created_at,
        },
        message: 'Discovery job scheduled successfully',
      });
    } catch (error) {
      logger.error('Error scheduling discovery job', error);
      res.status(500).json({
        success: false,
        error: 'Failed to schedule discovery job',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get discovery job status
   * GET /discovery/jobs/:id
   */
  async getJobStatus(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Job ID is required'
        });
        return;
      }

      // Search across all discovery queues
      const discoveryQueues = [
        QUEUE_NAMES._DISCOVERY_NMAP,
        QUEUE_NAMES._DISCOVERY_SSH,
        'discovery:active-directory',
        'discovery:snmp',
      ];

      let foundJob = null;
      let foundQueue = null;

      for (const queueName of discoveryQueues) {
        const queue = queueManager.getQueue(queueName);
        const job = await queue.getJob(id);

        if (job) {
          foundJob = job;
          foundQueue = queueName;
          break;
        }
      }

      if (!foundJob) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Discovery job with ID '${id}' not found`
        });
        return;
      }

      // Get job state
      const state = await foundJob.getState();
      const progress = foundJob.progress;
      const returnValue = foundJob.returnvalue;
      const failedReason = foundJob.failedReason;

      const sanitizedData = this.sanitizeJobData(foundJob.data);

      res.json({
        success: true,
        data: {
          id: foundJob.id,
          ...sanitizedData,
          status: state,
          progress,
          result: returnValue,
          error: failedReason,
          queue: foundQueue,
          attemptsMade: foundJob.attemptsMade,
          processedOn: foundJob.processedOn,
          finishedOn: foundJob.finishedOn,
        },
      });
    } catch (error) {
      logger.error('Error getting job status', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve job status',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * List all discovery jobs with pagination
   * GET /discovery/jobs
   */
  async listJobs(req: Request, res: Response): Promise<void> {
    try {
      const { status, provider, limit = 100, offset = 0 } = req.query;

      const limitNum = Math.min(parseInt(limit as string), 1000);
      const offsetNum = parseInt(offset as string);

      // Determine which queues to query
      const discoveryQueues = [
        QUEUE_NAMES._DISCOVERY_NMAP,
        QUEUE_NAMES._DISCOVERY_SSH,
        'discovery:active-directory',
        'discovery:snmp',
      ];

      const allJobs: any[] = [];

      // Collect jobs from all queues
      for (const queueName of discoveryQueues) {
        const queue = queueManager.getQueue(queueName);

        // Get jobs based on status filter
        let jobs: any[] = [];

        if (!status || status === 'pending') {
          const waiting = await queue.getWaiting(0, limitNum);
          jobs = [...jobs, ...waiting];
        }
        if (!status || status === 'running') {
          const active = await queue.getActive(0, limitNum);
          jobs = [...jobs, ...active];
        }
        if (!status || status === 'completed') {
          const completed = await queue.getCompleted(0, limitNum);
          jobs = [...jobs, ...completed];
        }
        if (!status || status === 'failed') {
          const failed = await queue.getFailed(0, limitNum);
          jobs = [...jobs, ...failed];
        }

        // Map jobs to response format
        for (const job of jobs) {
          const state = await job.getState();

          // Filter by provider if specified
          if (provider && job.data.provider !== provider) {
            continue;
          }

          const sanitizedData = this.sanitizeJobData(job.data);

          // Get return value for completed jobs
          // BullMQ exposes returnvalue directly on the job object for completed jobs
          const returnValue = (state === 'completed' && job.returnvalue) ? job.returnvalue : null;

          allJobs.push({
            id: job.id,
            ...sanitizedData,
            status: state,
            queue: queueName,
            attemptsMade: job.attemptsMade,
            processedOn: job.processedOn,
            finishedOn: job.finishedOn,
            returnValue: returnValue,
          });
        }
      }

      // Sort by created_at descending
      allJobs.sort((a, b) => {
        const dateA = new Date(a.created_at || 0).getTime();
        const dateB = new Date(b.created_at || 0).getTime();
        return dateB - dateA;
      });

      // Apply pagination
      const paginatedJobs = allJobs.slice(offsetNum, offsetNum + limitNum);

      res.json({
        success: true,
        data: paginatedJobs,
        pagination: {
          total: allJobs.length,
          count: paginatedJobs.length,
          offset: offsetNum,
          limit: limitNum,
        },
      });
    } catch (error) {
      logger.error('Error listing discovery jobs', error);
      res.status(500).json({
        success: false,
        error: 'Failed to list discovery jobs',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Cancel a discovery job
   * DELETE /discovery/jobs/:id
   */
  async cancelJob(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Job ID is required'
        });
        return;
      }

      // Search across all discovery queues
      const discoveryQueues = [
        QUEUE_NAMES._DISCOVERY_NMAP,
        QUEUE_NAMES._DISCOVERY_SSH,
        'discovery:active-directory',
        'discovery:snmp',
      ];

      let foundJob = null;

      for (const queueName of discoveryQueues) {
        const queue = queueManager.getQueue(queueName);
        const job = await queue.getJob(id);

        if (job) {
          foundJob = job;
          break;
        }
      }

      if (!foundJob) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Discovery job with ID '${id}' not found`
        });
        return;
      }

      // Check if job can be cancelled
      const state = await foundJob.getState();
      if (state === 'completed' || state === 'failed') {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `Cannot cancel job in '${state}' state`
        });
        return;
      }

      // Remove the job
      await foundJob.remove();

      logger.info(`Discovery job cancelled: ${id}`, { state });

      res.json({
        success: true,
        message: 'Discovery job cancelled successfully',
        data: {
          id,
          previousState: state,
        },
      });
    } catch (error) {
      logger.error('Error cancelling discovery job', error);
      res.status(500).json({
        success: false,
        error: 'Failed to cancel discovery job',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}
