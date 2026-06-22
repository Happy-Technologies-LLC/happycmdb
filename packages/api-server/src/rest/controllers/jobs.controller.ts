// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Jobs API Controller
 *
 * This module provides REST API endpoints for job management:
 * - Trigger discovery/ETL jobs
 * - Get job status and progress
 * - List jobs by queue
 * - Cancel/retry jobs
 * - Get job statistics
 */

import { Request, Response } from 'express';
import { getQueueManager, logger } from '@cmdb/common';
import type { DiscoveryProvider, ETLJobType } from '@cmdb/common';
import { getDiscoveryScheduler } from '@cmdb/discovery-engine';
import { getNeo4jClient } from '@cmdb/database';
// ETLScheduler not used currently - ETL jobs are triggered via queue directly
// import { getETLScheduler } from '@cmdb/etl-processor';

/**
 * Jobs Controller
 */
export class JobsController {
  private queueManager = getQueueManager();
  private discoveryScheduler = getDiscoveryScheduler();
  private neo4jClient = getNeo4jClient();
  // private etlScheduler = getETLScheduler();

  /**
   * POST /api/v1/jobs/discovery/:provider
   * Trigger immediate discovery job
   */
  async triggerDiscovery(req: Request, res: Response): Promise<void> {
    try {
      const provider = req.params['provider'] as DiscoveryProvider;
      const { config, triggeredBy } = req.body;

      logger.info(`Triggering discovery job for ${provider}`, {
        triggeredBy,
      });

      const jobId = await this.discoveryScheduler.triggerDiscovery(
        provider,
        config,
        triggeredBy || req.headers['x-user-id'] || 'api'
      );

      res.status(202).json({
        success: true,
        data: {
          jobId,
          provider,
          status: 'queued',
          message: `Discovery job for ${provider} has been queued`,
        },
      });
    } catch (err: any) {
      logger.error('Error triggering discovery job', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }

  /**
   * POST /api/v1/jobs/etl/:type
   * Trigger immediate ETL job
   * NOTE: Not yet implemented - ETL jobs should be triggered via BullMQ queue directly
   */
  async triggerETL(req: Request, res: Response): Promise<void> {
    try {
      const type = req.params['type'] as ETLJobType;

      // TODO: Implement ETL job triggering through BullMQ queue
      res.status(501).json({
        success: false,
        error: 'ETL job triggering not yet implemented',
        message: 'Please use BullMQ queue directly to trigger ETL jobs',
        type,
      });
    } catch (err: any) {
      logger.error('Error triggering ETL job', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }

  /**
   * GET /api/v1/jobs/:queueName/:jobId
   * Get job status and progress
   */
  async getJobStatus(req: Request, res: Response): Promise<void> {
    try {
      const { queueName, jobId } = req.params;

      if (!queueName || !jobId) {
        res.status(400).json({
          success: false,
          error: 'Queue name and job ID are required',
        });
        return;
      }

      const job = await this.queueManager.getJob(queueName, jobId);

      if (!job) {
        res.status(404).json({
          success: false,
          error: `Job ${jobId} not found in queue ${queueName}`,
        });
        return;
      }

      const state = await job.getState();
      const progress = job.progress;
      const failedReason = job.failedReason;

      res.json({
        success: true,
        data: {
          id: job.id,
          name: job.name,
          queueName,
          state,
          progress,
          data: job.data,
          returnvalue: job.returnvalue,
          failedReason,
          attemptsMade: job.attemptsMade,
          processedOn: job.processedOn,
          finishedOn: job.finishedOn,
          timestamp: job.timestamp,
        },
      });
    } catch (err: any) {
      logger.error('Error getting job status', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }

  /**
   * GET /api/v1/jobs/:queueName
   * List jobs in a queue
   */
  async listJobs(req: Request, res: Response): Promise<void> {
    try {
      const { queueName } = req.params;

      if (!queueName) {
        res.status(400).json({
          success: false,
          error: 'Queue name is required',
        });
        return;
      }

      const { state = 'waiting', start = 0, end = 99 } = req.query;

      const queue = this.queueManager.getQueue(queueName);

      let jobs;
      switch (state) {
        case 'waiting':
          jobs = await queue.getWaiting(Number(start), Number(end));
          break;
        case 'active':
          jobs = await queue.getActive(Number(start), Number(end));
          break;
        case 'completed':
          jobs = await queue.getCompleted(Number(start), Number(end));
          break;
        case 'failed':
          jobs = await queue.getFailed(Number(start), Number(end));
          break;
        case 'delayed':
          jobs = await queue.getDelayed(Number(start), Number(end));
          break;
        default:
          jobs = await queue.getWaiting(Number(start), Number(end));
      }

      const jobsData = await Promise.all(
        jobs.map(async (job) => ({
          id: job.id,
          name: job.name,
          state: await job.getState(),
          data: job.data,
          progress: job.progress,
          attemptsMade: job.attemptsMade,
          timestamp: job.timestamp,
          processedOn: job.processedOn,
          finishedOn: job.finishedOn,
        }))
      );

      res.json({
        success: true,
        data: {
          queueName,
          state,
          jobs: jobsData,
          count: jobsData.length,
        },
      });
    } catch (err: any) {
      logger.error('Error listing jobs', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }

  /**
   * DELETE /api/v1/jobs/:queueName/:jobId
   * Cancel/remove a job
   */
  async cancelJob(req: Request, res: Response): Promise<void> {
    try {
      const { queueName, jobId } = req.params;

      if (!queueName || !jobId) {
        res.status(400).json({
          success: false,
          error: 'Queue name and job ID are required',
        });
        return;
      }

      await this.queueManager.removeJob(queueName, jobId);

      logger.info(`Job ${jobId} cancelled in queue ${queueName}`);

      res.json({
        success: true,
        data: {
          jobId,
          queueName,
          message: 'Job cancelled successfully',
        },
      });
    } catch (err: any) {
      logger.error('Error cancelling job', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }

  /**
   * POST /api/v1/jobs/:queueName/:jobId/retry
   * Retry a failed job
   */
  async retryJob(req: Request, res: Response): Promise<void> {
    try {
      const { queueName, jobId } = req.params;

      if (!queueName || !jobId) {
        res.status(400).json({
          success: false,
          error: 'Queue name and job ID are required',
        });
        return;
      }

      await this.queueManager.retryJob(queueName, jobId);

      logger.info(`Job ${jobId} retried in queue ${queueName}`);

      res.json({
        success: true,
        data: {
          jobId,
          queueName,
          message: 'Job retried successfully',
        },
      });
    } catch (err: any) {
      logger.error('Error retrying job', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }

  /**
   * GET /api/v1/jobs/stats
   * Get statistics for all queues
   */
  async getJobStats(_req: Request, res: Response): Promise<void> {
    try {
      const queueNames = [
        'discovery:nmap',
        'discovery:ssh',
        'discovery:active-directory',
        'discovery:snmp',
        'etl:sync',
        'etl:full-refresh',
        'etl:change-detection',
        'etl:reconciliation',
      ];

      const stats = await Promise.all(
        queueNames.map(async (queueName) => {
          try {
            return await this.queueManager.getQueueStats(queueName);
          } catch (err) {
            logger.error(`Error getting stats for ${queueName}`, err);
            return {
              queueName,
              error: 'Failed to get stats',
            };
          }
        })
      );

      res.json({
        success: true,
        data: {
          queues: stats,
          totalQueues: queueNames.length,
        },
      });
    } catch (err: any) {
      logger.error('Error getting job stats', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }

  /**
   * GET /api/v1/jobs/discovery
   * List all discovery jobs across all providers
   *
   * Scalable implementation: Fetches job IDs from Redis sorted sets and loads full jobs using Job.fromId()
   * This avoids BullMQ queue initialization issues and scales better for high-volume discovery
   */
  async listDiscoveryJobs(req: Request, res: Response): Promise<void> {
    try {
      const { page = 1, limit = 10, provider, status } = req.query;
      const pageNum = parseInt(page as string);
      const limitNum = parseInt(limit as string);
      const start = (pageNum - 1) * limitNum;
      const end = start + limitNum - 1;

      const discoveryQueues = provider
        ? [`discovery:${provider}`]
        : [
            'discovery:nmap',
            'discovery:ssh',
            'discovery:active-directory',
            'discovery:snmp',
          ];

      // Get jobs from all discovery queues using scalable Redis approach
      const allJobs = await Promise.all(
        discoveryQueues.map(async (queueName) => {
          try {
            const queue = this.queueManager.getQueue(queueName);
            const redis = await queue.client;
            const providerName = queueName.split(':')[1];

            // Fetch job IDs directly from Redis sorted sets (much more scalable)
            const jobIdSets: string[][] = [];

            logger.info(`Fetching jobs for ${queueName}`, { status, queueName });

            if (status === 'completed' || !status) {
              try {
                const completedIds = await redis.zrange(`bull:${queueName}:completed`, 0, 99);
                logger.info(`Completed IDs for ${queueName}`, { count: completedIds.length, ids: completedIds });
                if (completedIds.length > 0) jobIdSets.push(completedIds);
              } catch (err: any) {
                logger.warn(`Failed to fetch completed jobs for ${queueName}`, { error: err.message });
              }
            }

            if (status === 'failed' || !status) {
              try {
                const failedIds = await redis.zrange(`bull:${queueName}:failed`, 0, 99);
                if (failedIds.length > 0) jobIdSets.push(failedIds);
              } catch (err: any) {
                logger.warn(`Failed to fetch failed jobs for ${queueName}`, { error: err.message });
              }
            }

            if (status === 'active' || !status) {
              try {
                const activeIds = await redis.zrange(`bull:${queueName}:active`, 0, 99);
                if (activeIds.length > 0) jobIdSets.push(activeIds);
              } catch (err: any) {
                logger.warn(`Failed to fetch active jobs for ${queueName}`, { error: err.message });
              }
            }

            if (status === 'pending' || !status) {
              try {
                const waitingIds = await redis.zrange(`bull:${queueName}:waiting`, 0, 99);
                if (waitingIds.length > 0) jobIdSets.push(waitingIds);
              } catch (err: any) {
                logger.warn(`Failed to fetch waiting jobs for ${queueName}`, { error: err.message });
              }

              try {
                const delayedIds = await redis.zrange(`bull:${queueName}:delayed`, 0, 99);
                if (delayedIds.length > 0) jobIdSets.push(delayedIds);
              } catch (err: any) {
                logger.warn(`Failed to fetch delayed jobs for ${queueName}`, { error: err.message });
              }
            }

            // Flatten job IDs
            const allJobIds = jobIdSets.flat();
            logger.info(`Total job IDs for ${queueName}`, { count: allJobIds.length, ids: allJobIds });

            // Load full job objects using Job.fromId (this properly loads all fields including returnvalue)
            const jobs = await Promise.all(
              allJobIds.map(async (jobId) => {
                try {
                  const { Job } = await import('bullmq');
                  const job = await Job.fromId(queue, jobId);

                  if (!job) return null;

                  // Log returnvalue for debugging
                  logger.info(`Job.fromId loaded job ${jobId}`, {
                    jobId: job.id,
                    hasReturnvalue: !!job.returnvalue,
                    returnvalueType: typeof job.returnvalue,
                    returnvalue: job.returnvalue,
                  });

                  return {
                    id: job.id,
                    provider: providerName,
                    queueName,
                    status: await job.getState(),
                    data: job.data,
                    progress: job.progress,
                    returnvalue: job.returnvalue, // Job.fromId properly loads this
                    createdAt: job.timestamp,
                    processedOn: job.processedOn,
                    finishedOn: job.finishedOn,
                    attemptsMade: job.attemptsMade,
                    failedReason: job.failedReason,
                  };
                } catch (err) {
                  logger.debug(`Could not load job ${jobId} from ${queueName}`, err);
                  return null;
                }
              })
            );

            // Filter out nulls (jobs that couldn't be loaded)
            return jobs.filter((job) => job !== null);
          } catch (err) {
            logger.error(`Error getting jobs for ${queueName}`, err);
            return [];
          }
        })
      );

      // Flatten and sort by timestamp
      const flatJobs = allJobs.flat().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      // Paginate
      const paginatedJobs = flatJobs.slice(start, end + 1);
      const total = flatJobs.length;

      res.json({
        success: true,
        data: paginatedJobs,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      });
    } catch (err: any) {
      logger.error('Error listing discovery jobs', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }

  /**
   * GET /api/v1/jobs/discovery/stats
   * Get discovery-specific statistics across all discovery providers
   */
  async getDiscoveryStats(_req: Request, res: Response): Promise<void> {
    try {
      const discoveryQueues = [
        'discovery:nmap',
        'discovery:ssh',
        'discovery:active-directory',
        'discovery:snmp',
      ];

      // Get queue stats and CI counts from Neo4j
      const stats = await Promise.all(
        discoveryQueues.map(async (queueName) => {
          try {
            const queueStats = await this.queueManager.getQueueStats(queueName);
            const provider = queueName.split(':')[1];

            // Query Neo4j for CI count by provider
            // Check both top-level discovery_provider and metadata for backward compatibility
            let ciCount = 0;
            try {
              const neo4jClient = this.neo4jClient;
              const session = neo4jClient.getSession();
              const result = await session.run(
                `MATCH (ci:CI)
                 WHERE ci.status IN ['active', 'inactive', 'maintenance']
                   AND (ci.discovery_provider = $provider
                        OR ci.metadata CONTAINS '"discovery_provider":"' + $provider + '"')
                 RETURN count(ci) as total`,
                { provider }
              );
              ciCount = result.records[0]?.get('total').toNumber() || 0;
              await session.close();
            } catch (neoErr) {
              logger.error(`Error querying Neo4j for ${provider} CIs`, neoErr);
            }

            return {
              provider,
              ...queueStats,
              totalDiscoveredCIs: ciCount,
            };
          } catch (err) {
            logger.error(`Error getting stats for ${queueName}`, err);
            const provider = queueName.split(':')[1];
            return {
              provider,
              queueName,
              waiting: 0,
              active: 0,
              completed: 0,
              failed: 0,
              delayed: 0,
              totalDiscoveredCIs: 0,
              error: 'Queue not configured',
            };
          }
        })
      );

      res.json({
        success: true,
        data: stats,
      });
    } catch (err: any) {
      logger.error('Error getting discovery stats', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }

  /**
   * GET /api/v1/jobs/:queueName/failed
   * Get failed jobs for a queue
   */
  async getFailedJobs(req: Request, res: Response): Promise<void> {
    try {
      const { queueName } = req.params;

      if (!queueName) {
        res.status(400).json({
          success: false,
          error: 'Queue name is required',
        });
        return;
      }

      const { start = 0, end = 99 } = req.query;

      const failedJobs = await this.queueManager.getFailedJobs(
        queueName,
        Number(start),
        Number(end)
      );

      const jobsData = await Promise.all(
        failedJobs.map(async (job) => ({
          id: job.id,
          name: job.name,
          data: job.data,
          failedReason: job.failedReason,
          stacktrace: job.stacktrace,
          attemptsMade: job.attemptsMade,
          timestamp: job.timestamp,
          processedOn: job.processedOn,
          finishedOn: job.finishedOn,
        }))
      );

      res.json({
        success: true,
        data: {
          queueName,
          failedJobs: jobsData,
          count: jobsData.length,
        },
      });
    } catch (err: any) {
      logger.error('Error getting failed jobs', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }

  /**
   * POST /api/v1/jobs/:queueName/clean
   * Clean old completed/failed jobs
   */
  async cleanQueue(req: Request, res: Response): Promise<void> {
    try {
      const { queueName } = req.params;

      if (!queueName) {
        res.status(400).json({
          success: false,
          error: 'Queue name is required',
        });
        return;
      }

      const { grace = 3600000, limit = 1000, type = 'completed' } = req.body;

      await this.queueManager.cleanQueue(
        queueName,
        Number(grace),
        Number(limit),
        type as 'completed' | 'failed'
      );

      logger.info(`Cleaned ${type} jobs from queue ${queueName}`, {
        grace,
        limit,
      });

      res.json({
        success: true,
        data: {
          queueName,
          message: `Cleaned ${type} jobs older than ${grace}ms`,
        },
      });
    } catch (err: any) {
      logger.error('Error cleaning queue', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }

  /**
   * GET /api/v1/jobs/schedules/discovery
   * Get all discovery schedules
   * TODO: getSchedules() method not yet implemented on DiscoveryOrchestrator
   */
  async getDiscoverySchedules(_req: Request, res: Response): Promise<void> {
    try {
      // TODO: Implement getSchedules() on DiscoveryOrchestrator
      // For now, return empty array to prevent UI errors
      // const schedules = this.discoveryScheduler.getSchedules();

      res.status(200).json({
        success: true,
        data: [],
        message: 'No scheduled discovery jobs configured',
      });
    } catch (err: any) {
      logger.error('Error getting discovery schedules', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }

  /**
   * GET /api/v1/jobs/schedules/etl
   * Get all ETL schedules
   * NOTE: Not yet implemented - schedule management not available
   */
  async getETLSchedules(_req: Request, res: Response): Promise<void> {
    try {
      // TODO: Implement ETL schedule management
      res.status(501).json({
        success: false,
        error: 'ETL schedule management not yet implemented',
        message: 'Please use BullMQ repeatable jobs directly',
      });
    } catch (err: any) {
      logger.error('Error getting ETL schedules', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }

  /**
   * PUT /api/v1/jobs/schedules/discovery/:provider
   * Update discovery schedule
   * TODO: updateSchedule() method not yet implemented on DiscoveryOrchestrator
   */
  async updateDiscoverySchedule(req: Request, res: Response): Promise<void> {
    try {
      const provider = req.params['provider'] as DiscoveryProvider;
      const { cronPattern } = req.body;

      // TODO: Implement updateSchedule() on DiscoveryOrchestrator
      // await this.discoveryScheduler.updateSchedule(provider, cronPattern);

      logger.info(`Schedule update requested for ${provider}`, {
        cronPattern,
      });

      res.status(501).json({
        success: false,
        error: 'Not Implemented',
        message: 'Discovery schedule update not yet implemented',
      });
    } catch (err: any) {
      logger.error('Error updating discovery schedule', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }

  /**
   * PUT /api/v1/jobs/schedules/etl/:type
   * Update ETL schedule
   * NOTE: Not yet implemented - schedule management not available
   */
  async updateETLSchedule(req: Request, res: Response): Promise<void> {
    try {
      const type = req.params['type'] as ETLJobType;

      // TODO: Implement ETL schedule management
      res.status(501).json({
        success: false,
        error: 'ETL schedule management not yet implemented',
        message: 'Please use BullMQ repeatable jobs directly',
        type,
      });
    } catch (err: any) {
      logger.error('Error updating ETL schedule', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }
}

// Export singleton instance
export const jobsController = new JobsController();
