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
import type { Job } from 'bullmq';
import { getQueueManager, logger } from '@cmdb/common';
import type { DiscoveryProvider, ETLJobType } from '@cmdb/common';
import { getDiscoveryScheduler, getDiscoveryJobScheduler } from '@cmdb/discovery-engine';
import { getNeo4jClient } from '@cmdb/database';
import { getETLScheduler } from '@cmdb/etl-processor';

interface ScheduleUpdate {
  cronExpression?: string;
  enabled?: boolean;
}

const SCHEDULE_UPDATE_FIELDS: Record<string, true> = {
  cronExpression: true,
  enabled: true,
};

/**
 * True when a completed BullMQ job carries both timestamps needed to
 * compute its duration. Narrows the optional fields so callers never
 * fabricate a 0ms duration from a missing timestamp.
 */
function hasCompletionTimestamps(
  job: Job
): job is Job & { processedOn: number; finishedOn: number } {
  return typeof job.processedOn === 'number' && typeof job.finishedOn === 'number';
}

/**
 * Jobs Controller
 */
export class JobsController {
  private queueManager = getQueueManager();
  private discoveryScheduler = getDiscoveryScheduler();
  private discoveryJobScheduler = getDiscoveryJobScheduler();
  private neo4jClient = getNeo4jClient();
  private etlScheduler = getETLScheduler();

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
      const maxAttempts = job.opts?.attempts ?? 1;

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
          maxAttempts,
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
      const startNum = Number(start);
      const endNum = Number(end);
      const JOB_STATE_FIELDS = ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'] as const;

      const queue = this.queueManager.getQueue(queueName);

      let jobs;
      switch (state) {
        case 'waiting':
          jobs = await queue.getWaiting(startNum, endNum);
          break;
        case 'active':
          jobs = await queue.getActive(startNum, endNum);
          break;
        case 'completed':
          jobs = await queue.getCompleted(startNum, endNum);
          break;
        case 'failed':
          jobs = await queue.getFailed(startNum, endNum);
          break;
        case 'delayed':
          jobs = await queue.getDelayed(startNum, endNum);
          break;
        default:
          jobs = await queue.getWaiting(startNum, endNum);
      }

      const jobsData = await Promise.all(
        jobs.map(async (job) => ({
          id: job.id,
          name: job.name,
          queueName,
          state: await job.getState(),
          data: job.data,
          progress: job.progress,
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts?.attempts ?? 1,
          failedReason: job.failedReason,
          returnvalue: job.returnvalue,
          timestamp: job.timestamp,
          processedOn: job.processedOn,
          finishedOn: job.finishedOn,
        }))
      );

      // Real total for the requested state, from BullMQ's job counts
      // (queue.getJobCounts under the hood) rather than an inferred/guessed
      // slice-based value.
      const counts = await this.queueManager.getQueueStats(queueName);
      const stateKey = (typeof state === 'string' && (JOB_STATE_FIELDS as readonly string[]).includes(state)
        ? state
        : 'waiting') as (typeof JOB_STATE_FIELDS)[number];
      const total = counts[stateKey] ?? 0;
      const limit = endNum - startNum + 1;
      const offset = startNum;

      res.json({
        success: true,
        data: {
          queueName,
          state,
          jobs: jobsData,
          count: jobsData.length,
        },
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + jobsData.length < total,
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
        'discovery-nmap',
        'discovery-ssh',
        'discovery-active-directory',
        'discovery-snmp',
        'etl-sync',
        'etl-full-refresh',
        'etl-change-detection',
        'etl-reconciliation',
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
        ? [`discovery-${provider}`]
        : [
            'discovery-nmap',
            'discovery-ssh',
            'discovery-active-directory',
            'discovery-snmp',
          ];

      // Get jobs from all discovery queues using scalable Redis approach
      const allJobs = await Promise.all(
        discoveryQueues.map(async (queueName) => {
          try {
            const queue = this.queueManager.getQueue(queueName);
            const redis = await queue.client;
            const providerName = queueName.replace(/^discovery-/, '');

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
  async getDiscoveryStats(req: Request, res: Response): Promise<void> {
    try {
      const { provider: providerFilter } = req.query;

      const discoveryQueues = providerFilter
        ? [`discovery-${providerFilter}`]
        : [
            'discovery-nmap',
            'discovery-ssh',
            'discovery-active-directory',
            'discovery-snmp',
          ];

      // Get queue stats and CI counts from Neo4j
      const stats = await Promise.all(
        discoveryQueues.map(async (queueName) => {
          try {
            const queueStats = await this.queueManager.getQueueStats(queueName);
            const provider = queueName.replace(/^discovery-/, '') as DiscoveryProvider;

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

            // Real average duration computed from a recent sample of completed
            // jobs on this queue (finishedOn - processedOn). null when no
            // completed job in the sample carries both timestamps.
            const averageDurationMs = await this.getAverageJobDuration(queueName);

            // Real schedule-enabled state from the shared discovery job
            // scheduler contract (same source of truth as
            // GET /jobs/schedules/discovery). undefined (not fabricated
            // true/false) when this provider has no registered schedule.
            const schedule = this.discoveryJobScheduler.getSchedule(provider);

            return {
              provider,
              ...queueStats,
              totalDiscoveredCIs: ciCount,
              averageDurationMs,
              enabled: schedule?._enabled,
            };
          } catch (err) {
            logger.error(`Error getting stats for ${queueName}`, err);
            const provider = queueName.replace(/^discovery-/, '');
            return {
              provider,
              queueName,
              waiting: 0,
              active: 0,
              completed: 0,
              failed: 0,
              delayed: 0,
              totalDiscoveredCIs: 0,
              averageDurationMs: null,
              enabled: undefined,
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
   * Compute the average duration (ms) of a recent sample of completed jobs
   * on the given queue, from BullMQ's own processedOn/finishedOn
   * timestamps. Returns null when no sampled job has both timestamps
   * (e.g. queue not configured, or nothing has completed yet) rather than
   * fabricating a 0ms duration.
   */
  private async getAverageJobDuration(queueName: string): Promise<number | null> {
    try {
      const queue = this.queueManager.getQueue(queueName);
      const completedJobs = await queue.getCompleted(0, 99);
      const durations = completedJobs
        .filter(hasCompletionTimestamps)
        .map((job) => job.finishedOn - job.processedOn);

      if (durations.length === 0) {
        return null;
      }

      return durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
    } catch (err) {
      logger.error(`Error computing average job duration for ${queueName}`, err);
      return null;
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
          queueName,
          status: 'failed' as const,
          data: job.data,
          failedReason: job.failedReason,
          stacktrace: job.stacktrace,
          progress: job.progress,
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts?.attempts ?? 1,
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
   */
  async getDiscoverySchedules(_req: Request, res: Response): Promise<void> {
    try {
      const schedules = (await this.discoveryJobScheduler.getSchedulesView()).map((schedule) => ({
        provider: schedule._provider,
        queueName: schedule._queueName,
        cronExpression: schedule._cronPattern,
        enabled: schedule._enabled,
        config: schedule._config,
      }));

      res.status(200).json({
        success: true,
        data: schedules,
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
   */
  async getETLSchedules(_req: Request, res: Response): Promise<void> {
    try {
      const schedules = (await this.etlScheduler.getSchedulesView()).map((schedule) => ({
        type: schedule._type,
        queueName: schedule._queueName,
        cronExpression: schedule._cronPattern,
        enabled: schedule._enabled,
        config: schedule._config,
      }));

      res.status(200).json({
        success: true,
        data: schedules,
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
   */
  async updateDiscoverySchedule(req: Request, res: Response): Promise<void> {
    try {
      const provider = req.params['provider'] as DiscoveryProvider;
      const update = this.parseScheduleUpdate(req.body);
      if (!update) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'cronExpression must be a five-part cron expression and enabled must be a boolean; no other fields are supported',
        });
        return;
      }

      const { cronExpression, enabled } = update;

      const schedule = await this.discoveryJobScheduler.getScheduleView(provider);
      if (!schedule) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `No schedule found for provider: ${provider}`,
        });
        return;
      }

      if (cronExpression !== undefined) {
        await this.discoveryJobScheduler.updateSchedule(provider, cronExpression);
      }

      if (enabled !== undefined && enabled !== schedule._enabled) {
        if (enabled) {
          await this.discoveryJobScheduler.enableSchedule(provider);
        } else {
          await this.discoveryJobScheduler.disableSchedule(provider);
        }
      }

      const updated = (await this.discoveryJobScheduler.getScheduleView(provider))!;

      logger.info(`Schedule updated for ${provider}`, { cronExpression, enabled });

      res.status(200).json({
        success: true,
        data: {
          provider,
          queueName: updated._queueName,
          cronExpression: updated._cronPattern,
          enabled: updated._enabled,
          config: updated._config,
        },
        message: `Discovery schedule for ${provider} updated successfully`,
      });
    } catch (err) {
      logger.error('Error updating discovery schedule', err);
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * PUT /api/v1/jobs/schedules/etl/:type
   * Update ETL schedule
   */
  async updateETLSchedule(req: Request, res: Response): Promise<void> {
    try {
      const type = req.params['type'] as ETLJobType;
      const update = this.parseScheduleUpdate(req.body);
      if (!update) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'cronExpression must be a five-part cron expression and enabled must be a boolean; no other fields are supported',
        });
        return;
      }

      const { cronExpression, enabled } = update;

      const schedule = await this.etlScheduler.getScheduleView(type);
      if (!schedule) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `No schedule found for ETL type: ${type}`,
        });
        return;
      }

      if (cronExpression !== undefined) {
        await this.etlScheduler.updateSchedule(type, cronExpression);
      }

      if (enabled !== undefined && enabled !== schedule._enabled) {
        if (enabled) {
          await this.etlScheduler.enableSchedule(type);
        } else {
          await this.etlScheduler.disableSchedule(type);
        }
      }

      const updated = (await this.etlScheduler.getScheduleView(type))!;

      logger.info(`Schedule updated for ${type}`, { cronExpression, enabled });

      res.status(200).json({
        success: true,
        data: {
          type,
          queueName: updated._queueName,
          cronExpression: updated._cronPattern,
          enabled: updated._enabled,
          config: updated._config,
        },
        message: `ETL schedule for ${type} updated successfully`,
      });
    } catch (err) {
      logger.error('Error updating ETL schedule', err);
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  private parseScheduleUpdate(body: unknown): ScheduleUpdate | undefined {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return undefined;
    }

    const update = body as Record<string, unknown>;
    if (
      Object.keys(update).some((field) => !Object.hasOwn(SCHEDULE_UPDATE_FIELDS, field)) ||
      (update.cronExpression === undefined && update.enabled === undefined) ||
      (update.cronExpression !== undefined &&
        (typeof update.cronExpression !== 'string' ||
          update.cronExpression.trim().split(/\s+/).length !== 5)) ||
      (update.enabled !== undefined && typeof update.enabled !== 'boolean')
    ) {
      return undefined;
    }

    return {
      ...(typeof update.cronExpression === 'string' && { cronExpression: update.cronExpression }),
      ...(typeof update.enabled === 'boolean' && { enabled: update.enabled }),
    };
  }

}

// Export singleton instance
export const jobsController = new JobsController();
