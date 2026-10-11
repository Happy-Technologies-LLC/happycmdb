/**
 * Jobs CLI Commands
 *
 * This module provides CLI commands for job management:
 * - List jobs
 * - Run jobs manually
 * - Check job status
 * - Retry failed jobs
 */

import axios from 'axios';
import { Command } from 'commander';
import { logger, getQueueManager, QUEUE_NAMES } from '@cmdb/common';
import type { ETLJobType } from '@cmdb/common';
import { getETLScheduler } from '@cmdb/etl-processor';

const MISSING_DISCOVERY_AUTH = 'Discovery API authentication required (--key or --token)';

/**
 * Create jobs command
 */
export function createJobsCommand(): Command {
  const jobsCmd = new Command('jobs');
  jobsCmd.description('Manage jobs');

  // List jobs command
  jobsCmd
    .command('list [queueName]')
    .description('List jobs in a queue')
    .option('-s, --state <state>', 'Job state (waiting, active, completed, failed)', 'waiting')
    .option('-l, --limit <limit>', 'Number of jobs to show', '20')
    .action(async (queueName?: string, options?: any) => {
      try {
        const queueManager = getQueueManager();

        if (!queueName) {
          // List all queues
          console.log('\n=== Available Queues ===');
          Object.values(QUEUE_NAMES).forEach((name) => {
            console.log(`  - ${name}`);
          });
          console.log('');
          process.exit(0);
        }

        const queue = queueManager.getQueue(queueName);
        const state = options.state || 'waiting';
        const limit = parseInt(options.limit || '20');

        let jobs;
        switch (state) {
          case 'waiting':
            jobs = await queue.getWaiting(0, limit - 1);
            break;
          case 'active':
            jobs = await queue.getActive(0, limit - 1);
            break;
          case 'completed':
            jobs = await queue.getCompleted(0, limit - 1);
            break;
          case 'failed':
            jobs = await queue.getFailed(0, limit - 1);
            break;
          default:
            jobs = await queue.getWaiting(0, limit - 1);
        }

        console.log(`\n=== ${queueName} - ${state} jobs ===`);
        console.log(`Total: ${jobs.length}`);

        for (const job of jobs) {
          const jobState = await job.getState();
          console.log(`\nJob ${job.id}:`);
          console.log(`  Name: ${job.name}`);
          console.log(`  State: ${jobState}`);
          console.log(`  Created: ${new Date(job.timestamp).toISOString()}`);
          if (job.processedOn) {
            console.log(`  Processed: ${new Date(job.processedOn).toISOString()}`);
          }
          if (job.finishedOn) {
            console.log(`  Finished: ${new Date(job.finishedOn).toISOString()}`);
          }
          if (job.progress) {
            console.log(`  Progress: ${JSON.stringify(job.progress)}`);
          }
          if (job.failedReason) {
            console.log(`  Failed Reason: ${job.failedReason}`);
          }
        }

        console.log('');
        process.exit(0);
      } catch (err: any) {
        logger.error('Error listing jobs', err);
        process.exit(1);
      }
    });

  // Run discovery job command
  jobsCmd
    .command('run:discovery <provider>')
    .description('Run discovery job immediately through the authenticated API (ssh, nmap)')
    .option('-c, --config <config>', 'Job configuration (JSON string)')
    .option('--token <token>', 'JWT access token for API (or CMDB_ACCESS_TOKEN)')
    .action(async (provider: string, options: any) => {
      try {
        // There is no verified CLI-local tenant. Only the authenticated API
        // can derive an organization before a job is added to BullMQ.
        const globals = jobsCmd.optsWithGlobals();
        const apiKey = globals['key'] || process.env['CMDB_API_KEY'];
        const token = options.token || process.env['CMDB_ACCESS_TOKEN'];
        if (!token && !apiKey) throw new Error(MISSING_DISCOVERY_AUTH);
        const apiUrl = globals['url'] || process.env['CMDB_API_URL'] || 'http://localhost:3000/api/v1';
        const headers = token
          ? { Authorization: `Bearer ${token}` }
          : { [process.env['API_KEY_HEADER_NAME'] || 'X-API-Key']: apiKey };
        let config;
        if (options.config) {
          config = JSON.parse(options.config);
        }

        logger.info(`Triggering discovery job for ${provider}...`);

        const response = await axios.post(
          `${String(apiUrl).replace(/\/+$/, '')}/jobs/discovery/${encodeURIComponent(provider)}`,
          { config },
          { headers }
        );
        const jobId: string = response.data.data.jobId;

        logger.info(`Discovery job ${jobId} queued for ${provider}`);
        console.log(`\nJob ID: ${jobId}`);
        console.log(`Use 'cmdb jobs status ${jobId}' to check status\n`);

        process.exit(0);
      } catch (error) {
        logger.error(error instanceof Error && error.message === MISSING_DISCOVERY_AUTH
          ? MISSING_DISCOVERY_AUTH
          : axios.isAxiosError(error) && [401, 403].includes(error.response?.status ?? 0)
            ? 'Discovery API authorization failed'
            : 'Error running discovery job');
        process.exit(1);
      }
    });

  // Run ETL job command
  jobsCmd
    .command('run:etl <type>')
    .description('Run ETL job immediately (sync, change-detection, reconciliation, full-refresh)')
    .option('-c, --config <config>', 'Job configuration (JSON string)')
    .action(async (type: string, options: any) => {
      try {
        const etlScheduler = getETLScheduler();

        let config;
        if (options.config) {
          config = JSON.parse(options.config);
        }

        logger.info(`Triggering ETL job for ${type}...`);

        const jobId = await etlScheduler.triggerETL(
          type as ETLJobType,
          config,
          'cli'
        );

        logger.info(`ETL job ${jobId} queued for ${type}`);
        console.log(`\nJob ID: ${jobId}`);
        console.log(`Use 'cmdb jobs status ${jobId}' to check status\n`);

        process.exit(0);
      } catch (err: any) {
        logger.error('Error running ETL job', err);
        process.exit(1);
      }
    });

  // Job status command
  jobsCmd
    .command('status <queueName> <jobId>')
    .description('Get job status and progress')
    .action(async (queueName: string, jobId: string) => {
      try {
        const queueManager = getQueueManager();
        const job = await queueManager.getJob(queueName, jobId);

        if (!job) {
          logger.error(`Job ${jobId} not found in queue ${queueName}`);
          process.exit(1);
        }

        const state = await job.getState();

        console.log(`\n=== Job ${jobId} Status ===`);
        console.log(`Queue: ${queueName}`);
        console.log(`Name: ${job.name}`);
        console.log(`State: ${state}`);
        console.log(`Created: ${new Date(job.timestamp).toISOString()}`);

        if (job.processedOn) {
          console.log(`Processed: ${new Date(job.processedOn).toISOString()}`);
        }

        if (job.finishedOn) {
          console.log(`Finished: ${new Date(job.finishedOn).toISOString()}`);
          const duration = job.finishedOn - (job.processedOn || job.timestamp);
          console.log(`Duration: ${duration}ms`);
        }

        if (job.progress) {
          console.log(`\nProgress:`);
          console.log(JSON.stringify(job.progress, null, 2));
        }

        if (job.returnvalue) {
          console.log(`\nResult:`);
          console.log(JSON.stringify(job.returnvalue, null, 2));
        }

        if (job.failedReason) {
          console.log(`\nFailed Reason: ${job.failedReason}`);
        }

        if (job.stacktrace) {
          console.log(`\nStack Trace:`);
          console.log(job.stacktrace.join('\n'));
        }

        console.log('');
        process.exit(0);
      } catch (err: any) {
        logger.error('Error getting job status', err);
        process.exit(1);
      }
    });

  // Retry job command
  jobsCmd
    .command('retry <queueName> <jobId>')
    .description('Retry a failed job')
    .action(async (queueName: string, jobId: string) => {
      try {
        const queueManager = getQueueManager();
        await queueManager.retryJob(queueName, jobId);

        logger.info(`Job ${jobId} retried in queue ${queueName}`);
        process.exit(0);
      } catch (err: any) {
        logger.error('Error retrying job', err);
        process.exit(1);
      }
    });

  // Cancel job command
  jobsCmd
    .command('cancel <queueName> <jobId>')
    .description('Cancel a job')
    .action(async (queueName: string, jobId: string) => {
      try {
        const queueManager = getQueueManager();
        await queueManager.removeJob(queueName, jobId);

        logger.info(`Job ${jobId} cancelled in queue ${queueName}`);
        process.exit(0);
      } catch (err: any) {
        logger.error('Error cancelling job', err);
        process.exit(1);
      }
    });

  // Queue stats command
  jobsCmd
    .command('stats [queueName]')
    .description('Get queue statistics')
    .action(async (queueName?: string) => {
      try {
        const queueManager = getQueueManager();

        if (queueName) {
          // Single queue stats
          const stats = await queueManager.getQueueStats(queueName);
          console.log(`\n=== ${queueName} Statistics ===`);
          console.log(`Waiting: ${stats.waiting}`);
          console.log(`Active: ${stats.active}`);
          console.log(`Completed: ${stats.completed}`);
          console.log(`Failed: ${stats.failed}`);
          console.log(`Delayed: ${stats.delayed}`);
        } else {
          // All queues stats
          console.log('\n=== Queue Statistics ===');
          for (const name of Object.values(QUEUE_NAMES)) {
            try {
              const stats = await queueManager.getQueueStats(name);
              console.log(`\n${name}:`);
              console.log(`  Waiting: ${stats.waiting}`);
              console.log(`  Active: ${stats.active}`);
              console.log(`  Completed: ${stats.completed}`);
              console.log(`  Failed: ${stats.failed}`);
            } catch (err) {
              console.log(`  Error: Failed to get stats`);
            }
          }
        }

        console.log('');
        process.exit(0);
      } catch (err: any) {
        logger.error('Error getting stats', err);
        process.exit(1);
      }
    });

  return jobsCmd;
}
