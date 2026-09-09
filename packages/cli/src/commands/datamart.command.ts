import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';

/**
 * Data mart command handlers for ETL and data synchronization operations
 */
export class DataMartCommand {
  private apiUrl: string;
  private apiKey?: string;

  constructor(apiUrl: string, apiKey?: string) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }

  /**
   * Register data mart commands
   */
  register(program: Command): void {
    const datamart = program
      .command('datamart')
      .description('Data mart ETL and synchronization operations');

    // Data mart status
    datamart
      .command('status')
      .description('Check data mart health and statistics')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        await this.getStatus(options);
      });

    // Manual sync
    datamart
      .command('sync')
      .description('Trigger manual ETL synchronization from Neo4j to PostgreSQL')
      .option('--batch-size <size>', 'Batch size for processing', '100')
      .option('--incremental', 'Perform incremental sync (only changed CIs)')
      .option('--since <date>', 'Sync CIs changed since date (ISO 8601 format)')
      .option('--types <types>', 'Comma-separated CI types to sync')
      .option('--wait', 'Wait for job completion')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        await this.triggerSync(options);
      });

    // Reconciliation
    datamart
      .command('reconcile')
      .description('Run data reconciliation to detect inconsistencies')
      .option('--ci-ids <ids>', 'Comma-separated CI IDs to reconcile')
      .option('--strategy <strategy>', 'Conflict resolution strategy: neo4j-wins, postgres-wins, newest-wins, manual', 'manual')
      .option('--auto-resolve', 'Automatically resolve conflicts based on strategy')
      .option('--max-age <hours>', 'Maximum data age in hours', '24')
      .option('--wait', 'Wait for job completion')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        await this.runReconciliation(options);
      });

    // Full refresh
    datamart
      .command('refresh')
      .description('Perform full data mart refresh (complete resync)')
      .option('--batch-size <size>', 'Batch size for processing', '100')
      .option('--types <types>', 'Comma-separated CI types to refresh')
      .option('--confirm', 'Confirm full refresh (required)')
      .option('--wait', 'Wait for job completion')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        await this.fullRefresh(options);
      });

    // Validate data integrity
    datamart
      .command('validate')
      .description('Validate data integrity between Neo4j and PostgreSQL')
      .option('--check-counts', 'Check record counts match')
      .option('--check-relationships', 'Check relationship integrity')
      .option('--check-orphans', 'Check for orphaned records')
      .option('--sample-size <size>', 'Sample size for validation', '100')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        await this.validateDataIntegrity(options);
      });

    // Job status
    datamart
      .command('job-status <jobId>')
      .description('Check status of a specific ETL job')
      .option('--json', 'Output as JSON')
      .action(async (jobId, options) => {
        await this.getJobStatus(jobId, options);
      });

    // List recent jobs
    datamart
      .command('jobs')
      .description('List recent ETL jobs')
      .option('--limit <limit>', 'Number of jobs to display', '10')
      .option('--status <status>', 'Filter by status: completed, failed, active, waiting')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        await this.listJobs(options);
      });
  }

  /**
   * Get data mart status
   */
  private async getStatus(options: any): Promise<void> {
    const spinner = ora('Checking data mart status...').start();

    try {
      const [healthResponse, statsResponse] = await Promise.all([
        axios.get(`${this.apiUrl}/datamart/health`, {
          headers: this.getHeaders(),
        }),
        axios.get(`${this.apiUrl}/datamart/stats`, {
          headers: this.getHeaders(),
        }),
      ]);

      spinner.succeed(chalk.green('Data mart status retrieved'));

      if (options.json) {
        console.log(JSON.stringify({
          health: healthResponse.data,
          stats: statsResponse.data,
        }, null, 2));
        return;
      }

      const health = healthResponse.data;
      const stats = statsResponse.data.data;

      console.log(chalk.cyan('\nData Mart Status'));
      console.log(chalk.cyan('='.repeat(50)));

      console.log(`\n${chalk.bold('Health:')}`);
      console.log(`  Status: ${this.colorizeHealth(health.status)}`);
      console.log(`  Neo4j: ${this.colorizeHealth(health.neo4j)}`);
      console.log(`  PostgreSQL: ${this.colorizeHealth(health.postgres)}`);
      console.log(`  Last Sync: ${health.lastSync ? new Date(health.lastSync).toLocaleString() : 'Never'}`);

      if (stats) {
        console.log(`\n${chalk.bold('Statistics:')}`);
        console.log(`  Total CIs in Neo4j: ${chalk.bold(stats.neo4j_ci_count || 'N/A')}`);
        console.log(`  Total CIs in PostgreSQL: ${chalk.bold(stats.postgres_ci_count || 'N/A')}`);
        console.log(`  Total Relationships: ${chalk.bold(stats.relationship_count || 'N/A')}`);
        console.log(`  Last ETL Duration: ${stats.last_etl_duration_ms ? `${stats.last_etl_duration_ms}ms` : 'N/A'}`);

        if (stats.sync_lag_seconds !== undefined) {
          const lagColor = stats.sync_lag_seconds > 3600 ? chalk.red : stats.sync_lag_seconds > 300 ? chalk.yellow : chalk.green;
          console.log(`  Sync Lag: ${lagColor(this.formatDuration(stats.sync_lag_seconds))}`);
        }
      }

    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch data mart status'));
      this.handleError(error);
    }
  }

  /**
   * Trigger ETL sync
   */
  private async triggerSync(options: any): Promise<void> {
    const spinner = ora('Triggering ETL sync job...').start();

    try {
      const jobData: any = {
        batchSize: parseInt(options.batchSize),
        fullRefresh: !options.incremental,
      };

      if (options.incremental && options.since) {
        jobData.incrementalSince = options.since;
      }

      if (options.types) {
        jobData.ciTypes = options.types.split(',').map((t: string) => t.trim());
      }

      const response = await axios.post(
        `${this.apiUrl}/datamart/sync`,
        jobData,
        {
          headers: this.getHeaders(),
        }
      );

      const jobId = response.data.jobId;

      spinner.succeed(chalk.green(`ETL sync job triggered: ${jobId}`));

      console.log(chalk.cyan('\nJob Details:'));
      console.log(`  Job ID: ${chalk.bold(jobId)}`);
      console.log(`  Type: ${options.incremental ? 'Incremental' : 'Full'} Sync`);
      console.log(`  Batch Size: ${options.batchSize}`);

      if (options.types) {
        console.log(`  CI Types: ${options.types}`);
      }

      if (options.wait) {
        await this.waitForJob(jobId);
      } else {
        console.log(chalk.gray(`\n  Use 'cmdb datamart job-status ${jobId}' to check progress`));
      }

    } catch (error: any) {
      spinner.fail(chalk.red('Failed to trigger sync job'));
      this.handleError(error);
    }
  }

  /**
   * Run reconciliation
   */
  private async runReconciliation(options: any): Promise<void> {
    const spinner = ora('Starting data reconciliation...').start();

    try {
      const jobData: any = {
        conflictStrategy: options.strategy,
        autoResolve: options.autoResolve || false,
        maxAgeHours: parseInt(options.maxAge),
      };

      if (options.ciIds) {
        jobData.ciIds = options.ciIds.split(',').map((id: string) => id.trim());
      }

      const response = await axios.post(
        `${this.apiUrl}/datamart/reconcile`,
        jobData,
        {
          headers: this.getHeaders(),
        }
      );

      const jobId = response.data.jobId;

      spinner.succeed(chalk.green(`Reconciliation job started: ${jobId}`));

      console.log(chalk.cyan('\nReconciliation Details:'));
      console.log(`  Job ID: ${chalk.bold(jobId)}`);
      console.log(`  Strategy: ${options.strategy}`);
      console.log(`  Auto-resolve: ${options.autoResolve ? chalk.green('Yes') : chalk.yellow('No')}`);
      console.log(`  Max Age: ${options.maxAge} hours`);

      if (options.ciIds) {
        const ciCount = options.ciIds.split(',').length;
        console.log(`  CI Count: ${ciCount}`);
      } else {
        console.log(`  Scope: ${chalk.bold('All CIs')}`);
      }

      if (options.wait) {
        await this.waitForJob(jobId);
      } else {
        console.log(chalk.gray(`\n  Use 'cmdb datamart job-status ${jobId}' to check progress`));
      }

    } catch (error: any) {
      spinner.fail(chalk.red('Failed to start reconciliation'));
      this.handleError(error);
    }
  }

  /**
   * Full data mart refresh
   */
  private async fullRefresh(options: any): Promise<void> {
    if (!options.confirm) {
      console.log(chalk.yellow('\nWARNING: Full refresh will resynchronize all data from Neo4j to PostgreSQL'));
      console.log(chalk.yellow('This operation may take a long time and impact performance.'));
      console.log(chalk.yellow('\nUse --confirm to proceed with full refresh'));
      return;
    }

    const spinner = ora('Starting full data mart refresh...').start();

    try {
      const jobData: any = {
        batchSize: parseInt(options.batchSize),
        fullRefresh: true,
      };

      if (options.types) {
        jobData.ciTypes = options.types.split(',').map((t: string) => t.trim());
      }

      const response = await axios.post(
        `${this.apiUrl}/datamart/sync`,
        jobData,
        {
          headers: this.getHeaders(),
        }
      );

      const jobId = response.data.jobId;

      spinner.succeed(chalk.green(`Full refresh job started: ${jobId}`));

      console.log(chalk.cyan('\nRefresh Details:'));
      console.log(`  Job ID: ${chalk.bold(jobId)}`);
      console.log(`  Batch Size: ${options.batchSize}`);

      if (options.types) {
        console.log(`  CI Types: ${options.types}`);
      } else {
        console.log(`  Scope: ${chalk.bold('All CI types')}`);
      }

      if (options.wait) {
        await this.waitForJob(jobId);
      } else {
        console.log(chalk.gray(`\n  Use 'cmdb datamart job-status ${jobId}' to check progress`));
      }

    } catch (error: any) {
      spinner.fail(chalk.red('Failed to start full refresh'));
      this.handleError(error);
    }
  }

  /**
   * Validate data integrity
   */
  private async validateDataIntegrity(options: any): Promise<void> {
    const spinner = ora('Validating data integrity...').start();

    try {
      const params: any = {
        checkCounts: options.checkCounts || true,
        checkRelationships: options.checkRelationships || false,
        checkOrphans: options.checkOrphans || false,
        sampleSize: parseInt(options.sampleSize),
      };

      const response = await axios.get(`${this.apiUrl}/datamart/validate`, {
        params,
        headers: this.getHeaders(),
      });

      spinner.succeed(chalk.green('Data integrity validation completed'));

      if (options.json) {
        console.log(JSON.stringify(response.data, null, 2));
        return;
      }

      const validation = response.data.data;

      console.log(chalk.cyan('\nData Integrity Validation'));
      console.log(chalk.cyan('='.repeat(50)));

      console.log(`\n${chalk.bold('Overall Status:')}`);
      console.log(`  ${this.colorizeValidation(validation.status)}`);

      if (validation.counts) {
        console.log(`\n${chalk.bold('Record Counts:')}`);
        console.log(`  Neo4j CIs: ${validation.counts.neo4j_cis}`);
        console.log(`  PostgreSQL CIs: ${validation.counts.postgres_cis}`);
        const diff = Math.abs(validation.counts.neo4j_cis - validation.counts.postgres_cis);
        const diffColor = diff === 0 ? chalk.green : diff < 10 ? chalk.yellow : chalk.red;
        console.log(`  Difference: ${diffColor(diff)}`);
      }

      if (validation.relationships && options.checkRelationships) {
        console.log(`\n${chalk.bold('Relationships:')}`);
        console.log(`  Neo4j Relationships: ${validation.relationships.neo4j_count}`);
        console.log(`  PostgreSQL Relationships: ${validation.relationships.postgres_count}`);
        console.log(`  Missing in PostgreSQL: ${chalk.yellow(validation.relationships.missing_in_postgres || 0)}`);
      }

      if (validation.orphans && options.checkOrphans) {
        console.log(`\n${chalk.bold('Orphaned Records:')}`);
        console.log(`  Orphaned CIs in PostgreSQL: ${validation.orphans.count > 0 ? chalk.red(validation.orphans.count) : chalk.green(0)}`);
        if (validation.orphans.count > 0 && validation.orphans.sample) {
          console.log(`  Sample IDs: ${validation.orphans.sample.slice(0, 5).join(', ')}`);
        }
      }

      if (validation.issues && validation.issues.length > 0) {
        console.log(chalk.red(`\n${chalk.bold('Issues Found:')}`));
        validation.issues.forEach((issue: string, index: number) => {
          console.log(`  ${index + 1}. ${issue}`);
        });
      }

      if (validation.recommendations && validation.recommendations.length > 0) {
        console.log(chalk.yellow(`\n${chalk.bold('Recommendations:')}`));
        validation.recommendations.forEach((rec: string, index: number) => {
          console.log(`  ${index + 1}. ${rec}`);
        });
      }

    } catch (error: any) {
      spinner.fail(chalk.red('Validation failed'));
      this.handleError(error);
    }
  }

  /**
   * Get job status
   */
  private async getJobStatus(jobId: string, options: any): Promise<void> {
    const spinner = ora('Fetching job status...').start();

    try {
      const response = await axios.get(`${this.apiUrl}/jobs/etl/${jobId}`, {
        headers: this.getHeaders(),
      });

      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(response.data, null, 2));
        return;
      }

      const job = response.data;

      console.log(chalk.cyan('\nJob Status'));
      console.log(chalk.cyan('='.repeat(50)));
      console.log(`\n  Job ID: ${chalk.bold(job.id)}`);
      console.log(`  Name: ${job.name}`);
      console.log(`  Status: ${this.colorizeJobStatus(job.state)}`);
      console.log(`  Progress: ${job.progress ? `${job.progress}%` : 'N/A'}`);

      if (job.data) {
        console.log(`\n${chalk.bold('  Configuration:')}`);
        Object.entries(job.data).forEach(([key, value]) => {
          console.log(`    ${key}: ${value}`);
        });
      }

      if (job.returnvalue) {
        console.log(`\n${chalk.bold('  Results:')}`);
        console.log(`    CIs Processed: ${job.returnvalue.cisProcessed || 'N/A'}`);
        console.log(`    Records Inserted: ${job.returnvalue.recordsInserted || 'N/A'}`);
        console.log(`    Records Updated: ${job.returnvalue.recordsUpdated || 'N/A'}`);
        console.log(`    Errors: ${job.returnvalue.errors || 0}`);
        console.log(`    Duration: ${job.returnvalue.durationMs ? `${job.returnvalue.durationMs}ms` : 'N/A'}`);
      }

      if (job.failedReason) {
        console.log(chalk.red(`\n  Failure Reason: ${job.failedReason}`));
      }

      console.log(`\n  Created: ${new Date(job.timestamp).toLocaleString()}`);
      if (job.processedOn) {
        console.log(`  Processed: ${new Date(job.processedOn).toLocaleString()}`);
      }
      if (job.finishedOn) {
        console.log(`  Finished: ${new Date(job.finishedOn).toLocaleString()}`);
      }

    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch job status'));
      this.handleError(error);
    }
  }

  /**
   * List recent jobs
   */
  private async listJobs(options: any): Promise<void> {
    const spinner = ora('Fetching recent jobs...').start();

    try {
      const params: any = {
        limit: parseInt(options.limit),
      };

      if (options.status) {
        params.status = options.status;
      }

      const response = await axios.get(`${this.apiUrl}/jobs/etl`, {
        params,
        headers: this.getHeaders(),
      });

      spinner.succeed(chalk.green(`Found ${response.data.length} jobs`));

      if (options.json) {
        console.log(JSON.stringify(response.data, null, 2));
        return;
      }

      const jobs = response.data;

      if (jobs.length === 0) {
        console.log(chalk.yellow('\nNo jobs found'));
        return;
      }

      console.log(chalk.cyan('\nRecent ETL Jobs'));
      console.log(chalk.cyan('='.repeat(80)));

      console.log(chalk.gray('\n  ' + 'Job ID'.padEnd(25) + 'Name'.padEnd(25) + 'Status'.padEnd(15) + 'Created'));
      console.log(chalk.gray('  ' + '-'.repeat(78)));

      jobs.forEach((job: any) => {
        const id = job.id.substring(0, 23).padEnd(25);
        const name = job.name.substring(0, 23).padEnd(25);
        const status = this.colorizeJobStatus(job.state).padEnd(23);
        const created = new Date(job.timestamp).toLocaleString().substring(0, 20);
        console.log(`  ${id}${name}${status}${created}`);
      });

    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch jobs'));
      this.handleError(error);
    }
  }

  /**
   * Wait for job completion with progress updates
   */
  private async waitForJob(jobId: string): Promise<void> {
    const spinner = ora('Waiting for job completion...').start();

    try {
      let isComplete = false;
      let attempts = 0;
      const maxAttempts = 120; // 10 minutes with 5-second intervals

      while (!isComplete && attempts < maxAttempts) {
        await this.sleep(5000);
        attempts++;

        const response = await axios.get(`${this.apiUrl}/jobs/etl/${jobId}`, {
          headers: this.getHeaders(),
        });

        const job = response.data;

        if (job.progress !== undefined) {
          spinner.text = `Job progress: ${Math.round(job.progress)}%`;
        }

        if (job.state === 'completed') {
          isComplete = true;
          spinner.succeed(chalk.green('Job completed successfully'));

          if (job.returnvalue) {
            console.log(chalk.cyan('\nJob Results:'));
            console.log(`  CIs Processed: ${job.returnvalue.cisProcessed || 'N/A'}`);
            console.log(`  Records Inserted: ${job.returnvalue.recordsInserted || 'N/A'}`);
            console.log(`  Records Updated: ${job.returnvalue.recordsUpdated || 'N/A'}`);
            console.log(`  Errors: ${job.returnvalue.errors || 0}`);
            console.log(`  Duration: ${job.returnvalue.durationMs ? `${(job.returnvalue.durationMs / 1000).toFixed(2)}s` : 'N/A'}`);
          }
        } else if (job.state === 'failed') {
          isComplete = true;
          spinner.fail(chalk.red('Job failed'));
          console.error(chalk.red(`  Reason: ${job.failedReason || 'Unknown error'}`));
        }
      }

      if (!isComplete) {
        spinner.warn(chalk.yellow('Job still running (timeout reached)'));
        console.log(chalk.gray(`  Use 'cmdb datamart job-status ${jobId}' to check status`));
      }

    } catch (error: any) {
      spinner.fail(chalk.red('Error while waiting for job'));
      this.handleError(error);
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Format duration in seconds to human-readable format
   */
  private formatDuration(seconds: number): string {
    if (seconds < 60) {
      return `${seconds}s`;
    } else if (seconds < 3600) {
      return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    }
  }

  /**
   * Colorize health status
   */
  private colorizeHealth(status: string): string {
    switch (status.toLowerCase()) {
      case 'healthy':
      case 'connected':
      case 'ok':
        return chalk.green(status);
      case 'degraded':
      case 'warning':
        return chalk.yellow(status);
      case 'unhealthy':
      case 'disconnected':
      case 'error':
        return chalk.red(status);
      default:
        return status;
    }
  }

  /**
   * Colorize validation status
   */
  private colorizeValidation(status: string): string {
    switch (status.toLowerCase()) {
      case 'valid':
      case 'passed':
        return chalk.green(status.toUpperCase());
      case 'warning':
        return chalk.yellow(status.toUpperCase());
      case 'invalid':
      case 'failed':
        return chalk.red(status.toUpperCase());
      default:
        return status;
    }
  }

  /**
   * Colorize job status
   */
  private colorizeJobStatus(status: string): string {
    switch (status.toLowerCase()) {
      case 'completed':
        return chalk.green(status);
      case 'active':
      case 'running':
        return chalk.blue(status);
      case 'waiting':
      case 'delayed':
        return chalk.yellow(status);
      case 'failed':
        return chalk.red(status);
      default:
        return status;
    }
  }

  /**
   * Get request headers
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  /**
   * Handle API errors
   */
  private handleError(error: any): void {
    if (error.response) {
      console.error(chalk.red(`  Error: ${error.response.data.message || error.response.statusText}`));
      console.error(chalk.red(`  Status: ${error.response.status}`));
    } else if (error.request) {
      console.error(chalk.red('  Error: No response from server'));
    } else {
      console.error(chalk.red(`  Error: ${error.message}`));
    }
  }
}
