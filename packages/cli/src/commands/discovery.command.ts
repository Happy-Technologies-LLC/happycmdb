import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';

/**
 * Discovery scan configuration
 */
interface DiscoveryScanConfig {
  targets: string[];
  credentials?: {
    username?: string;
    password?: string;
    sshKey?: string;
  };
}

/**
 * Discovery command handlers
 */
export class DiscoveryCommand {
  private apiUrl: string;
  private apiKey?: string;

  constructor(apiUrl: string, apiKey?: string) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }

  /**
   * Register discovery commands
   */
  register(program: Command): void {
    const discovery = program
      .command('discovery')
      .alias('disc')
      .description('Manage discovery operations');

    // Start discovery scan
    discovery
      .command('scan')
      .description('Start a discovery scan')
      .requiredOption('--provider <provider>', 'Discovery provider: nmap, ssh, snmp, active-directory')
      .option('-t, --targets <targets>', 'Comma-separated list of IP addresses or ranges')
      .option('-f, --file <file>', 'File containing target list (one per line)')
      .option('--type <type>', 'Scan type: quick, full, custom', 'quick')
      .option('-u, --username <username>', 'SSH username for authentication')
      .option('-p, --password <password>', 'SSH password for authentication')
      .option('-k, --key <key>', 'Path to SSH private key')
      .action(async (options) => {
        await this.startScan(options);
      });

    // List discovery scans
    discovery
      .command('list')
      .description('List all discovery scans')
      .option('--status <status>', 'Filter by status: pending, running, completed, failed')
      .option('--limit <limit>', 'Limit number of results', '20')
      .action(async (options) => {
        await this.listScans(options);
      });

    // Get scan details
    discovery
      .command('status <scanId>')
      .description('Get status of a specific discovery scan')
      .action(async (scanId) => {
        await this.getScanStatus(scanId);
      });

    // Cancel scan
    discovery
      .command('cancel <scanId>')
      .description('Cancel a running discovery scan')
      .action(async (scanId) => {
        await this.cancelScan(scanId);
      });

    // Schedule discovery
    discovery
      .command('schedule')
      .description('Schedule a recurring discovery scan')
      .requiredOption('--provider <provider>', 'Discovery provider: nmap, ssh, snmp, active-directory')
      .option('-t, --targets <targets>', 'Comma-separated list of targets')
      .option('--cron <cron>', 'Cron expression for schedule', '0 2 * * *')
      .option('--type <type>', 'Scan type: quick, full, custom', 'quick')
      .action(async (options) => {
        await this.scheduleDiscovery(options);
      });
  }

  /**
   * Start a discovery scan
   */
  private async startScan(options: any): Promise<void> {
    const spinner = ora('Starting discovery scan...').start();

    try {
      // Parse targets
      let targets: string[] = [];
      if (options.targets) {
        targets = options.targets.split(',').map((t: string) => t.trim());
      } else if (options.file) {
        // TODO: Read targets from file
        spinner.fail(chalk.red('File input not yet implemented'));
        return;
      } else {
        spinner.fail(chalk.red('No targets specified. Use --targets or --file'));
        return;
      }

      const config: DiscoveryScanConfig = {
        targets,
      };

      if (options.username || options.password || options.key) {
        config.credentials = {
          username: options.username,
          password: options.password,
          sshKey: options.key,
        };
      }

      const response = await axios.post(
        `${this.apiUrl}/discovery/schedule`,
        { provider: options.provider, config },
        {
          headers: this.getHeaders(),
        }
      );

      const jobId = response.data?.data?.id ?? response.data?.id;
      spinner.succeed(chalk.green('Discovery scan started successfully'));
      console.log(chalk.cyan('\nScan Details:'));
      console.log(`  Job ID: ${chalk.bold(jobId)}`);
      console.log(`  Provider: ${chalk.bold(options.provider)}`);
      console.log(`  Targets: ${chalk.bold(targets.length)}`);
      console.log(`\nMonitor progress with: ${chalk.yellow(`cmdb discovery status ${jobId}`)}`);
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to start discovery scan'));
      this.handleError(error);
    }
  }

  /**
   * List discovery scans
   */
  private async listScans(options: any): Promise<void> {
    const spinner = ora('Fetching discovery scans...').start();

    try {
      const params: any = {
        limit: options.limit,
      };

      if (options.status) {
        params.status = options.status;
      }

      const response = await axios.get(`${this.apiUrl}/discovery/jobs`, {
        params,
        headers: this.getHeaders(),
      });

      spinner.succeed(chalk.green(`Found ${response.data.length} scans`));

      if (response.data.length === 0) {
        console.log(chalk.yellow('\nNo discovery scans found'));
        return;
      }

      console.log(chalk.cyan('\nDiscovery Scans:'));
      response.data.forEach((scan: any) => {
        const status = this.colorizeStatus(scan.status);
        console.log(`\n  ${chalk.bold(scan.id)}`);
        console.log(`    Status: ${status}`);
        console.log(`    Type: ${scan.type}`);
        console.log(`    Targets: ${scan.targetCount}`);
        console.log(`    Started: ${new Date(scan.startedAt).toLocaleString()}`);
        if (scan.completedAt) {
          console.log(`    Completed: ${new Date(scan.completedAt).toLocaleString()}`);
        }
      });
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch discovery scans'));
      this.handleError(error);
    }
  }

  /**
   * Get scan status
   */
  private async getScanStatus(scanId: string): Promise<void> {
    const spinner = ora('Fetching scan status...').start();

    try {
      const response = await axios.get(
        `${this.apiUrl}/discovery/jobs/${scanId}`,
        {
          headers: this.getHeaders(),
        }
      );

      spinner.succeed(chalk.green('Scan status retrieved'));

      const scan = response.data;
      console.log(chalk.cyan('\nScan Details:'));
      console.log(`  ID: ${chalk.bold(scan.id)}`);
      console.log(`  Status: ${this.colorizeStatus(scan.status)}`);
      console.log(`  Type: ${scan.type}`);
      console.log(`  Targets: ${scan.targetCount}`);
      console.log(`  Discovered: ${chalk.bold(scan.discoveredCount || 0)} CIs`);
      console.log(`  Started: ${new Date(scan.startedAt).toLocaleString()}`);

      if (scan.completedAt) {
        console.log(`  Completed: ${new Date(scan.completedAt).toLocaleString()}`);
        const duration = (new Date(scan.completedAt).getTime() - new Date(scan.startedAt).getTime()) / 1000;
        console.log(`  Duration: ${duration}s`);
      }

      if (scan.progress) {
        console.log(`\n  Progress: ${scan.progress.completed}/${scan.progress.total} (${scan.progress.percentage}%)`);
      }
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch scan status'));
      this.handleError(error);
    }
  }

  /**
   * Cancel a scan
   */
  private async cancelScan(scanId: string): Promise<void> {
    const spinner = ora('Cancelling scan...').start();

    try {
      await axios.delete(
        `${this.apiUrl}/discovery/jobs/${scanId}`,
        {
          headers: this.getHeaders(),
        }
      );

      spinner.succeed(chalk.green('Scan cancelled successfully'));
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to cancel scan'));
      this.handleError(error);
    }
  }

  /**
   * Schedule discovery
   */
  private async scheduleDiscovery(options: any): Promise<void> {
    const spinner = ora('Scheduling discovery...').start();

    try {
      const targets = options.targets
        ? options.targets.split(',').map((t: string) => t.trim())
        : [];

      if (targets.length === 0) {
        spinner.fail(chalk.red('No targets specified'));
        return;
      }

      const response = await axios.post(
        `${this.apiUrl}/discovery/schedule`,
        { provider: options.provider, config: { targets } },
        {
          headers: this.getHeaders(),
        }
      );

      const jobId = response.data?.data?.id ?? response.data?.id;
      spinner.succeed(chalk.green('Discovery scheduled successfully'));
      console.log(chalk.cyan('\nSchedule Details:'));
      console.log(`  Job ID: ${chalk.bold(jobId)}`);
      console.log(`  Provider: ${chalk.bold(options.provider)}`);
      console.log(`  Targets: ${chalk.bold(targets.length)}`);
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to schedule discovery'));
      this.handleError(error);
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
   * Colorize status text
   */
  private colorizeStatus(status: string): string {
    switch (status.toLowerCase()) {
      case 'completed':
        return chalk.green(status);
      case 'running':
        return chalk.blue(status);
      case 'failed':
        return chalk.red(status);
      case 'pending':
        return chalk.yellow(status);
      default:
        return status;
    }
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
