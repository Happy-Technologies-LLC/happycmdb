import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';

/**
 * Connector Run Command
 * Run connectors and view run history
 */
export class ConnectorRunCommand {
  private apiUrl: string;
  private apiKey?: string;

  constructor(apiUrl: string, apiKey?: string) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }

  /**
   * Register connector run commands
   */
  register(program: Command): void {
    const connector = program
      .command('connector')
      .description('Manage connectors');

    // Run connector
    connector
      .command('run <name>')
      .description('Run a connector configuration')
      .option('-r, --resource <id>', 'Run specific resource only')
      .option('--wait', 'Wait for completion and show progress')
      .option('--timeout <seconds>', 'Timeout for --wait (default: 300)', '300')
      .action(async (name, options) => {
        await this.runConnector(name, options);
      });

    // List runs
    connector
      .command('runs')
      .description('List connector runs')
      .argument('[name]', 'Filter by configuration name')
      .option('-s, --status <status>', 'Filter by status: queued, running, completed, failed, cancelled')
      .option('-t, --type <type>', 'Filter by connector type')
      .option('--limit <limit>', 'Limit number of results', '20')
      .action(async (name, options) => {
        await this.listRuns(name, options);
      });

    // Get run status
    connector
      .command('run-status <runId>')
      .description('Get status of a specific run')
      .option('--watch', 'Watch run progress in real-time')
      .action(async (runId, options) => {
        await this.getRunStatus(runId, options);
      });

    // Cancel run
    connector
      .command('cancel <runId>')
      .description('Cancel a running connector job')
      .action(async (runId) => {
        await this.cancelRun(runId);
      });

    // View run metrics
    connector
      .command('metrics <name>')
      .description('View metrics for a connector configuration')
      .option('--resource <id>', 'Show metrics for specific resource')
      .action(async (name, options) => {
        await this.viewMetrics(name, options);
      });
  }

  /**
   * Run connector
   */
  private async runConnector(name: string, options: any): Promise<void> {
    console.log(chalk.cyan(`\nTriggering connector run: ${chalk.bold(name)}`));
    if (options.resource) {
      console.log(chalk.gray(`Resource: ${options.resource}`));
    }

    const spinner = ora('Starting connector run...').start();

    try {
      // Find config by name
      const findResponse = await axios.get(`${this.apiUrl}/connector-configs`, {
        params: { name },
        headers: this.getHeaders(),
      });

      if (findResponse.data.length === 0) {
        spinner.fail(chalk.red(`Configuration "${name}" not found`));
        return;
      }

      const configId = findResponse.data[0].id;

      const data: any = {};
      if (options.resource) {
        data.resourceId = options.resource;
      }

      const response = await axios.post(`${this.apiUrl}/connector-configs/${configId}/run`, data, {
        headers: this.getHeaders(),
      });

      const run = response.data;
      spinner.succeed(chalk.green('Connector run started!'));

      console.log(chalk.cyan('\nRun Details:'));
      console.log(`  Run ID: ${chalk.bold(run.id)}`);
      console.log(`  Configuration: ${run.configName}`);
      console.log(`  Connector Type: ${run.connectorType}`);
      console.log(`  Status: ${this.colorizeStatus(run.status)}`);
      console.log(`  Started: ${new Date(run.startedAt).toLocaleString()}`);

      if (run.jobId) {
        console.log(`  Job ID: ${run.jobId}`);
      }

      console.log(chalk.cyan('\nMonitoring:'));
      console.log(`  Check status: ${chalk.yellow(`happycmdb connector run-status ${run.id}`)}`);
      console.log(`  Watch progress: ${chalk.yellow(`happycmdb connector run-status ${run.id} --watch`)}`);

      // Wait for completion if requested
      if (options.wait) {
        await this.waitForCompletion(run.id, parseInt(options.timeout, 10));
      }
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to start connector run'));
      this.handleError(error);
    }
  }

  /**
   * List connector runs
   */
  private async listRuns(name?: string, options?: any): Promise<void> {
    const spinner = ora('Fetching connector runs...').start();

    try {
      const params: any = {
        limit: options?.limit || 20,
      };

      if (name) {
        // Find config ID by name
        const findResponse = await axios.get(`${this.apiUrl}/connector-configs`, {
          params: { name },
          headers: this.getHeaders(),
        });

        if (findResponse.data.length > 0) {
          params.configId = findResponse.data[0].id;
        }
      }

      if (options?.status) params.status = options.status.toUpperCase();
      if (options?.type) params.connectorType = options.type;

      const response = await axios.get(`${this.apiUrl}/connector-runs`, {
        params,
        headers: this.getHeaders(),
      });

      const runs = response.data;
      spinner.succeed(chalk.green(`Found ${runs.length} runs`));

      if (runs.length === 0) {
        console.log(chalk.yellow('\nNo connector runs found'));
        return;
      }

      console.log(chalk.cyan('\n╔═══════════════════════════════════════════════════════════════════════════════════╗'));
      console.log(chalk.cyan('║') + chalk.bold(' Run ID                Config Name          Status      Records     Duration') + chalk.cyan('║'));
      console.log(chalk.cyan('╠═══════════════════════════════════════════════════════════════════════════════════╣'));

      runs.forEach((run: any) => {
        const id = (run.id || '').substring(0, 21).padEnd(21);
        const configName = (run.configName || '').padEnd(20).substring(0, 20);
        const status = this.colorizeStatus(run.status).padEnd(11);
        const records = (run.recordsLoaded || 0).toString().padStart(7);
        const duration = run.durationMs ? `${Math.round(run.durationMs / 1000)}s`.padStart(8) : '        ';

        console.log(chalk.cyan('║') + ` ${id} ${configName} ${status} ${records}    ${duration}` + chalk.cyan('║'));
      });

      console.log(chalk.cyan('╚═══════════════════════════════════════════════════════════════════════════════════╝'));
      console.log(chalk.gray(`\nTotal: ${runs.length} runs`));
      console.log(chalk.gray('Run "happycmdb connector run-status <runId>" for details'));
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch runs'));
      this.handleError(error);
    }
  }

  /**
   * Get run status
   */
  private async getRunStatus(runId: string, options: any): Promise<void> {
    if (options.watch) {
      await this.watchRun(runId);
      return;
    }

    const spinner = ora('Fetching run status...').start();

    try {
      const response = await axios.get(`${this.apiUrl}/connector-runs/${runId}`, {
        headers: this.getHeaders(),
      });

      const run = response.data;
      spinner.succeed(chalk.green('Run status retrieved'));

      console.log(chalk.cyan('\n╔════════════════════════════════════════╗'));
      console.log(chalk.cyan('║') + chalk.bold('  Connector Run Details               ') + chalk.cyan('║'));
      console.log(chalk.cyan('╚════════════════════════════════════════╝\n'));

      console.log(chalk.cyan('Basic Information:'));
      console.log(`  Run ID: ${chalk.bold(run.id)}`);
      console.log(`  Configuration: ${chalk.bold(run.configName)}`);
      console.log(`  Connector Type: ${run.connectorType}`);
      console.log(`  Status: ${this.colorizeStatus(run.status)}`);

      if (run.resourceId) {
        console.log(`  Resource: ${run.resourceId}`);
      }

      console.log(chalk.cyan('\nTiming:'));
      console.log(`  Started: ${new Date(run.startedAt).toLocaleString()}`);
      if (run.completedAt) {
        console.log(`  Completed: ${new Date(run.completedAt).toLocaleString()}`);
        console.log(`  Duration: ${Math.round(run.durationMs / 1000)}s`);
      } else {
        const elapsed = Date.now() - new Date(run.startedAt).getTime();
        console.log(`  Elapsed: ${Math.round(elapsed / 1000)}s`);
      }

      console.log(chalk.cyan('\nRecords:'));
      console.log(`  Extracted: ${chalk.bold(run.recordsExtracted || 0)}`);
      console.log(`  Transformed: ${chalk.bold(run.recordsTransformed || 0)}`);
      console.log(`  Loaded: ${chalk.bold.green(run.recordsLoaded || 0)}`);
      if (run.recordsFailed > 0) {
        console.log(`  Failed: ${chalk.bold.red(run.recordsFailed)}`);
      }

      console.log(chalk.cyan('\nExecution:'));
      console.log(`  Triggered By: ${run.triggeredBy}`);
      if (run.triggeredByUser) {
        console.log(`  User: ${run.triggeredByUser}`);
      }
      if (run.jobId) {
        console.log(`  Job ID: ${run.jobId}`);
      }

      if (run.errorMessage) {
        console.log(chalk.cyan('\nError:'));
        console.log(chalk.red(`  ${run.errorMessage}`));
      }

      if (run.errors && run.errors.length > 0) {
        console.log(chalk.cyan('\nErrors:'));
        run.errors.slice(0, 5).forEach((error: any) => {
          console.log(chalk.red(`  - ${typeof error === 'string' ? error : error.message}`));
        });
        if (run.errors.length > 5) {
          console.log(chalk.gray(`  ... and ${run.errors.length - 5} more errors`));
        }
      }
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch run status'));
      this.handleError(error);
    }
  }

  /**
   * Watch run progress in real-time
   */
  private async watchRun(runId: string): Promise<void> {
    console.log(chalk.cyan(`\nWatching run: ${chalk.bold(runId)}`));
    console.log(chalk.gray('Press Ctrl+C to stop watching\n'));

    let previousStatus = '';

    const intervalId = setInterval(async () => {
      try {
        const response = await axios.get(`${this.apiUrl}/connector-runs/${runId}`, {
          headers: this.getHeaders(),
        });

        const run = response.data;

        // Only update display if status changed
        if (run.status !== previousStatus) {
          const timestamp = new Date().toLocaleTimeString();
          console.log(
            `[${timestamp}] Status: ${this.colorizeStatus(run.status)} | Records: ${run.recordsLoaded || 0} loaded`
          );
          previousStatus = run.status;
        }

        // Stop watching if completed or failed
        if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
          clearInterval(intervalId);
          console.log(chalk.cyan('\n════════════════════════════════════'));
          console.log(chalk.cyan('  Run finished'));
          console.log(chalk.cyan('════════════════════════════════════'));
          console.log(`  Status: ${this.colorizeStatus(run.status)}`);
          console.log(`  Records Loaded: ${chalk.bold(run.recordsLoaded || 0)}`);
          if (run.durationMs) {
            console.log(`  Duration: ${Math.round(run.durationMs / 1000)}s`);
          }
          if (run.errorMessage) {
            console.log(chalk.red(`  Error: ${run.errorMessage}`));
          }
        }
      } catch (error: any) {
        clearInterval(intervalId);
        console.error(chalk.red('\nFailed to fetch run status'));
        this.handleError(error);
      }
    }, 2000); // Poll every 2 seconds
  }

  /**
   * Wait for run completion
   */
  private async waitForCompletion(runId: string, timeoutSeconds: number): Promise<void> {
    console.log(chalk.cyan('\nWaiting for completion...'));

    const startTime = Date.now();
    const spinner = ora('Running...').start();

    const checkInterval = setInterval(async () => {
      try {
        const response = await axios.get(`${this.apiUrl}/connector-runs/${runId}`, {
          headers: this.getHeaders(),
        });

        const run = response.data;

        // Update spinner text
        spinner.text = `Running... (${run.recordsLoaded || 0} records loaded)`;

        // Check timeout
        const elapsed = (Date.now() - startTime) / 1000;
        if (elapsed > timeoutSeconds) {
          clearInterval(checkInterval);
          spinner.warn(chalk.yellow('Timeout reached - run still in progress'));
          console.log(chalk.gray(`  Check status: happycmdb connector run-status ${runId}`));
          return;
        }

        // Check completion
        if (run.status === 'completed') {
          clearInterval(checkInterval);
          spinner.succeed(chalk.green('Run completed successfully!'));
          console.log(chalk.cyan('\nResults:'));
          console.log(`  Records Loaded: ${chalk.bold.green(run.recordsLoaded || 0)}`);
          console.log(`  Duration: ${Math.round(run.durationMs / 1000)}s`);
        } else if (run.status === 'failed') {
          clearInterval(checkInterval);
          spinner.fail(chalk.red('Run failed'));
          if (run.errorMessage) {
            console.error(chalk.red(`  Error: ${run.errorMessage}`));
          }
        } else if (run.status === 'cancelled') {
          clearInterval(checkInterval);
          spinner.warn(chalk.yellow('Run was cancelled'));
        }
      } catch (error: any) {
        clearInterval(checkInterval);
        spinner.fail(chalk.red('Failed to check run status'));
        this.handleError(error);
      }
    }, 2000); // Poll every 2 seconds
  }

  /**
   * Cancel run
   */
  private async cancelRun(runId: string): Promise<void> {
    const spinner = ora('Cancelling run...').start();

    try {
      await axios.post(`${this.apiUrl}/connector-runs/${runId}/cancel`, {}, { headers: this.getHeaders() });

      spinner.succeed(chalk.green('Run cancelled successfully'));
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to cancel run'));
      this.handleError(error);
    }
  }

  /**
   * View metrics
   */
  private async viewMetrics(name: string, options: any): Promise<void> {
    const spinner = ora('Fetching metrics...').start();

    try {
      // Find config by name
      const findResponse = await axios.get(`${this.apiUrl}/connector-configs`, {
        params: { name },
        headers: this.getHeaders(),
      });

      if (findResponse.data.length === 0) {
        spinner.fail(chalk.red(`Configuration "${name}" not found`));
        return;
      }

      const configId = findResponse.data[0].id;

      const endpoint = options.resource
        ? `${this.apiUrl}/connector-configs/${configId}/resources/${options.resource}/metrics`
        : `${this.apiUrl}/connector-configs/${configId}/metrics`;

      const response = await axios.get(endpoint, {
        headers: this.getHeaders(),
      });

      const metrics = response.data;
      spinner.succeed(chalk.green('Metrics retrieved'));

      console.log(chalk.cyan('\n╔═══════════════════════════════════════╗'));
      console.log(chalk.cyan('║') + chalk.bold('  Connector Metrics                  ') + chalk.cyan('║'));
      console.log(chalk.cyan('╚═══════════════════════════════════════╝\n'));

      console.log(chalk.cyan('Overall Statistics:'));
      console.log(`  Total Runs: ${chalk.bold(metrics.totalRuns || 0)}`);
      console.log(`  Successful: ${chalk.bold.green(metrics.successfulRuns || 0)}`);
      console.log(`  Failed: ${chalk.bold.red(metrics.failedRuns || 0)}`);
      console.log(`  Success Rate: ${chalk.bold((metrics.successRate || 0).toFixed(1))}%`);

      if (metrics.avgDurationMs) {
        console.log(`  Avg Duration: ${Math.round(metrics.avgDurationMs / 1000)}s`);
      }

      if (metrics.totalRecordsProcessed) {
        console.log(`  Total Records: ${chalk.bold(metrics.totalRecordsProcessed)}`);
      }

      if (metrics.resourceMetrics && metrics.resourceMetrics.length > 0) {
        console.log(chalk.cyan('\nResource Metrics:'));
        metrics.resourceMetrics.forEach((resource: any) => {
          console.log(`\n  ${chalk.bold(resource.resourceId)}:`);
          console.log(`    Records Extracted: ${resource.totalRecordsExtracted || 0}`);
          console.log(`    Records Loaded: ${resource.totalRecordsLoaded || 0}`);
          console.log(`    Success Rate: ${(resource.successRate || 0).toFixed(1)}%`);
          if (resource.avgExtractionTimeMs) {
            console.log(`    Avg Extraction Time: ${Math.round(resource.avgExtractionTimeMs)}ms`);
          }
        });
      }
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch metrics'));
      this.handleError(error);
    }
  }

  /**
   * Colorize status text
   */
  private colorizeStatus(status: string): string {
    if (!status) return chalk.gray('UNKNOWN');

    switch (status.toLowerCase()) {
      case 'completed':
        return chalk.green('COMPLETED');
      case 'running':
        return chalk.blue('RUNNING  ');
      case 'failed':
        return chalk.red('FAILED   ');
      case 'queued':
        return chalk.yellow('QUEUED   ');
      case 'cancelled':
        return chalk.gray('CANCELLED');
      default:
        return status.toUpperCase();
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
