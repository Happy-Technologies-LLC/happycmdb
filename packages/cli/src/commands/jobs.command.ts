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
import { logger, QUEUE_NAMES } from '@cmdb/common';

const MISSING_DISCOVERY_AUTH = 'Jobs API authentication required (--key or --token)';
const GLOBAL_CLI_REFUSAL = 'Queue operations require the authenticated API; global operations unavailable';
type PublicJob = { id: string; name: string; state: string };

/**
 * Create jobs command
 */
export function createJobsCommand(): Command {
  const jobsCmd = new Command('jobs');
  jobsCmd.description('Manage platform queue jobs via the authenticated API; discovery execution and ETL triggers unavailable');
  // A CLI process has no verified platform identity. The API validates a
  // freshly verified platform administrator JWT before shared queue access.
  function apiAccess(token?: string) {
    const globals = jobsCmd.optsWithGlobals();
    const apiKey = globals['key'] || process.env['CMDB_API_KEY'];
    const accessToken = token || process.env['CMDB_ACCESS_TOKEN'];
    if (!accessToken && !apiKey) throw new Error(MISSING_DISCOVERY_AUTH);
    const url = String(globals['url'] || process.env['CMDB_API_URL'] || 'http://localhost:3000/api/v1').replace(/\/+$/, '');
    const headers = accessToken
      ? { Authorization: `Bearer ${accessToken}` }
      : { [process.env['API_KEY_HEADER_NAME'] || 'X-API-Key']: apiKey };
    return { url, headers };
  }

  function reportApiFailure(error: unknown): void {
    logger.error(error instanceof Error && error.message === MISSING_DISCOVERY_AUTH
      ? MISSING_DISCOVERY_AUTH
      : axios.isAxiosError(error) && [401, 403].includes(error.response?.status ?? 0)
        ? 'Jobs API authorization failed'
        : 'Jobs API request failed');
    process.exit(1);
  }

  jobsCmd
    .command('list <queueName>')
    .description('List platform queue jobs through the authenticated API')
    .option('-s, --state <state>', 'Job state (waiting, active, completed, failed)', 'waiting')
    .option('-l, --limit <limit>', 'Maximum jobs to show (1-100)', '20')
    .option('--token <token>', 'JWT access token (or CMDB_ACCESS_TOKEN)')
    .action(async (queueName: string, options: { state: string; limit: string; token?: string }) => {
      try {
        const { url, headers } = apiAccess(options.token);
        if (!Object.values(QUEUE_NAMES).includes(queueName as typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES])) {
          throw new Error('Known queue name required');
        }
        const limit = Number(options.limit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !['waiting', 'active', 'completed', 'failed'].includes(options.state)) {
          throw new Error('Invalid job list filter');
        }
        const response = await axios.get<{ data: { jobs: PublicJob[] } }>(`${url}/jobs/${encodeURIComponent(queueName)}`, {
          headers, params: { state: options.state, start: 0, end: limit - 1 },
        });
        console.log(`\n=== ${queueName} - ${options.state} jobs ===`);
        for (const job of response.data.data.jobs) {
          console.log(`Job ${job.id}: ${job.name} (${job.state})`);
        }
        process.exit(0);
      } catch (error) {
        reportApiFailure(error);
      }
    });

  // Run discovery job command
  jobsCmd
    .command('run:discovery <provider>')
    .description('Unavailable: discovery execution requires organization-owned journaled definitions')
    .option('-c, --config <config>', 'Job configuration (JSON string)')
    .option('--token <token>', 'JWT access token for API (or CMDB_ACCESS_TOKEN)')
    .action(async (provider: string, options: any) => {
      try {
        // Legacy endpoints cannot queue discovery; they return a controlled
        // refusal until organization-owned journaled definitions are enabled.
        const { url: apiUrl, headers } = apiAccess(options.token);
        let config;
        if (options.config) {
          config = JSON.parse(options.config);
        }

        logger.info(`Triggering discovery job for ${provider}...`);

        const response = await axios.post(
          `${apiUrl}/jobs/discovery/${encodeURIComponent(provider)}`,
          { config },
          { headers }
        );
        const jobId: string = response.data.data.jobId;

        logger.info(`Discovery job ${jobId} queued for ${provider}`);
        console.log(`\nJob ID: ${jobId}`);
        console.log(`Use 'cmdb jobs status <queueName> ${jobId} --token <token>' to check status\n`);

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

  jobsCmd
    .command('run:etl <type>')
    .description('Unavailable: global ETL execution requires a tenant-authorized API')
    .action(() => {
      logger.error(GLOBAL_CLI_REFUSAL);
      process.exit(1);
    });

  jobsCmd
    .command('status <queueName> <jobId>')
    .description('Read platform job status through the authenticated API (no raw worker output)')
    .option('--token <token>', 'JWT access token (or CMDB_ACCESS_TOKEN)')
    .action(async (queueName: string, jobId: string, options: { token?: string }) => {
      try {
        const { url, headers } = apiAccess(options.token);
        const response = await axios.get<{ data: PublicJob }>(`${url}/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}`, { headers });
        const job = response.data.data;
        console.log(`Job ${job.id}: ${job.name} (${job.state})`);
        process.exit(0);
      } catch (error) {
        reportApiFailure(error);
      }
    });

  for (const [command, method] of [['retry', 'post'], ['cancel', 'delete']] as const) {
    jobsCmd
      .command(`${command} <queueName> <jobId>`)
      .description(`${command} a platform queue job through the authenticated API`)
      .option('--token <token>', 'JWT access token (or CMDB_ACCESS_TOKEN)')
      .action(async (queueName: string, jobId: string, options: { token?: string }) => {
        try {
          const { url, headers } = apiAccess(options.token);
          const path = `${url}/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}${command === 'retry' ? '/retry' : ''}`;
          if (method === 'post') await axios.post(path, {}, { headers });
          else await axios.delete(path, { headers });
          console.log(`Job ${jobId} ${command === 'retry' ? 'retried' : 'cancelled'}`);
          process.exit(0);
        } catch (error) {
          reportApiFailure(error);
        }
      });
  }

  jobsCmd.command('stats [queueName]')
    .description('Unavailable: global queue stats require a tenant-authorized API')
    .action(() => {
      logger.error(GLOBAL_CLI_REFUSAL);
      process.exit(1);
    });
  return jobsCmd;
}
