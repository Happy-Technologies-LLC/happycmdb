import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
interface PublicRun {
  id: string;
  config_name: string;
  connector_type: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  resource_id: string | null;
  duration_ms: number | null;
  records_extracted: number;
  records_transformed: number;
  records_loaded: number;
  records_failed: number;
  triggered_by: string;
}

function runRow(payload: unknown): PublicRun {
  if (!payload || typeof payload !== 'object' || !('id' in payload) ||
      typeof payload.id !== 'string') throw new Error('Unexpected connector run response');
  const row = payload as Record<string, unknown>;
  const text = (key: string): string => typeof row[key] === 'string' ? row[key] as string : '';
  const count = (key: string): number => typeof row[key] === 'number' ? row[key] as number : 0;
  return {
    id: payload.id, config_name: text('config_name'), connector_type: text('connector_type'),
    status: text('status'), started_at: text('started_at'),
    completed_at: text('completed_at') || null, resource_id: text('resource_id') || null,
    duration_ms: count('duration_ms'), records_extracted: count('records_extracted'),
    records_transformed: count('records_transformed'), records_loaded: count('records_loaded'),
    records_failed: count('records_failed'), triggered_by: text('triggered_by'),
  };
}

function runRows(payload: unknown): PublicRun[] {
  if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data)) {
    throw new Error('Unexpected connector run response');
  }
  return payload.data.map(runRow);
}

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

  private async configIdByName(name: string): Promise<string | undefined> {
    let offset = 0;
    while (true) {
      const response = await axios.get(`${this.apiUrl}/connector-configs`, {
        params: { search: name, limit: 100, offset },
        headers: this.getHeaders(),
      });
      const payload: unknown = response.data;
      if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data)) {
        throw new Error('Unexpected connector configuration response');
      }
      for (const row of payload.data) {
        if (row && typeof row === 'object' && row.name === name && typeof row.id === 'string') return row.id;
      }
      if (payload.data.length < 100) return undefined;
      offset += payload.data.length;
    }
  }

  /**
   * Register connector run commands
   */
  register(connector: Command): void {

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
  private async runConnector(name: string, options: { resource?: string; wait?: boolean; timeout?: string }): Promise<void> {
    const spinner = ora('Starting connector run...').start();
    try {
      const configId = await this.configIdByName(name);
      if (!configId) {
        spinner.fail(chalk.red('Configuration not found'));
        return;
      }
      const response = await axios.post(`${this.apiUrl}/connector-configs/${configId}/run`,
        options.resource ? { resource_id: options.resource } : {}, { headers: this.getHeaders() });
      const run = runRow(response.data.data);
      spinner.succeed(chalk.green('Connector run started'));
      console.log(`  Run ID: ${run.id}`);
      console.log(`  Configuration: ${run.config_name}`);
      console.log(`  Status: ${this.colorizeStatus(run.status)}`);
      console.log(`  Started: ${run.started_at}`);
      if (options.wait) await this.waitForCompletion(run.id, Number(options.timeout ?? 300));
    } catch (error) {
      spinner.fail(chalk.red('Failed to start connector run'));
      this.handleError(error);
    }
  }

  /**
   * List connector runs
   */
  private async listRuns(name?: string, options?: { limit?: string; status?: string; type?: string }): Promise<void> {
    const spinner = ora('Fetching connector runs...').start();
    try {
      const params: Record<string, unknown> = { limit: options?.limit ?? 20 };
      if (name) {
        const id = await this.configIdByName(name);
        if (!id) {
          spinner.fail(chalk.red('Configuration not found'));
          return;
        }
        params['config_id'] = id;
      }
      if (options?.status) params['status'] = options.status.toLowerCase();
      if (options?.type) params['connector_type'] = options.type;
      const response = await axios.get(`${this.apiUrl}/connector-configs/runs/all`, { params, headers: this.getHeaders() });
      const runs = runRows(response.data);
      spinner.succeed(chalk.green(`Found ${runs.length} runs`));
      for (const run of runs) {
        console.log(`${run.id}  ${run.config_name}  ${this.colorizeStatus(run.status)}  ${run.records_loaded} loaded`);
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to fetch runs'));
      this.handleError(error);
    }
  }

  /**
   * Get run status
   */
  private async getRunStatus(runId: string, options: { watch?: boolean }): Promise<void> {
    if (options.watch) return this.watchRun(runId);
    const spinner = ora('Fetching run status...').start();
    try {
      const response = await axios.get(`${this.apiUrl}/connector-configs/runs/${runId}`, { headers: this.getHeaders() });
      const run = runRow(response.data.data);
      spinner.succeed(chalk.green('Run status retrieved'));
      console.log(`  Run ID: ${run.id}`);
      console.log(`  Configuration: ${run.config_name}`);
      console.log(`  Connector Type: ${run.connector_type}`);
      console.log(`  Status: ${this.colorizeStatus(run.status)}`);
      console.log(`  Started: ${run.started_at}`);
      if (run.completed_at) console.log(`  Completed: ${run.completed_at}`);
      console.log(`  Extracted: ${run.records_extracted}`);
      console.log(`  Transformed: ${run.records_transformed}`);
      console.log(`  Loaded: ${run.records_loaded}`);
      console.log(`  Failed: ${run.records_failed}`);
      console.log(`  Triggered By: ${run.triggered_by}`);
    } catch (error) {
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
        const response = await axios.get(`${this.apiUrl}/connector-configs/runs/${runId}`, {
          headers: this.getHeaders(),
        });

        const run = runRow(response.data.data);

        // Only update display if status changed
        if (run.status !== previousStatus) {
          const timestamp = new Date().toLocaleTimeString();
          console.log(
            `[${timestamp}] Status: ${this.colorizeStatus(run.status)} | Records: ${run.records_loaded} loaded`
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
          console.log(`  Records Loaded: ${chalk.bold(run.records_loaded)}`);
          if (run.duration_ms) console.log(`  Duration: ${Math.round(run.duration_ms / 1000)}s`);
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
        const response = await axios.get(`${this.apiUrl}/connector-configs/runs/${runId}`, {
          headers: this.getHeaders(),
        });

        const run = runRow(response.data.data);

        // Update spinner text
        spinner.text = `Running... (${run.records_loaded} records loaded)`;

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
          console.log(`  Records Loaded: ${chalk.bold.green(run.records_loaded)}`);
          console.log(`  Duration: ${Math.round((run.duration_ms ?? 0) / 1000)}s`);
        } else if (run.status === 'failed') {
          clearInterval(checkInterval);
          spinner.fail(chalk.red('Run failed'));
          // Run failures expose status only; raw errors are not public data.
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
      await axios.post(`${this.apiUrl}/connector-configs/runs/${runId}/cancel`, {}, { headers: this.getHeaders() });

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
      const configId = await this.configIdByName(name);
      if (!configId) {
        spinner.fail(chalk.red('Configuration not found'));
        return;
      }

      const endpoint = options.resource
        ? `${this.apiUrl}/connector-configs/${configId}/resources/${options.resource}/metrics`
        : `${this.apiUrl}/connector-configs/${configId}/metrics`;

      const response = await axios.get(endpoint, {
        headers: this.getHeaders(),
      });

      const payload: unknown = response.data.data;
      if (!payload || typeof payload !== 'object') throw new Error('Unexpected metrics response');
      const metrics = payload as Record<string, unknown>;
      const number = (key: string) => typeof metrics[key] === 'number' ? metrics[key] as number : 0;
      spinner.succeed(chalk.green('Metrics retrieved'));
      console.log(`  Total Runs: ${number('total_runs')}`);
      console.log(`  Successful: ${number('successful_runs')}`);
      console.log(`  Failed: ${number('failed_runs')}`);
      console.log(`  Success Rate: ${number('success_rate')}%`);
      console.log(`  Avg Duration: ${Math.round(number('avg_duration_ms') / 1000)}s`);
      console.log(`  Records Extracted: ${number('total_records_extracted')}`);
      console.log(`  Records Loaded: ${number('total_records_loaded')}`);
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
        return chalk.gray('UNKNOWN');
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
  private handleError(error: unknown): void {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    const message = axios.isAxiosError(error) ? error.response?.data?.error : undefined;
    if (status === 409 && message === 'Connector credential reference unavailable') {
      console.error(chalk.red('  Connector credential reference unavailable'));
      return;
    }
    console.error(chalk.red(status === 404 ? '  Not found' : '  Connector request failed'));
  }
}
