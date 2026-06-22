#!/usr/bin/env node
// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Command } from 'commander';
import chalk from 'chalk';
import { DiscoveryCommand } from './commands/discovery.command';
import { CICommand } from './commands/ci.command';
import { QueryCommand } from './commands/query.command';
import { AnalyticsCommand } from './commands/analytics.command';
import { DataMartCommand } from './commands/datamart.command';
import { ConnectorListCommand } from './commands/connector-list.command';
import { ConnectorInstallCommand } from './commands/connector-install.command';
import { ConnectorConfigCommand } from './commands/connector-config.command';
import { ConnectorRunCommand } from './commands/connector-run.command';
import { createWorkerCommand } from './commands/worker.command';
import { createJobsCommand } from './commands/jobs.command';

/**
 * CMDB CLI - Command-line interface for CMDB platform
 */
class CMDBCli {
  private program: Command;
  private apiUrl: string;
  private apiKey?: string;

  constructor() {
    this.program = new Command();
    this.apiUrl = process.env['CMDB_API_URL'] || 'http://localhost:3000/api/v1';
    this.apiKey = process.env['CMDB_API_KEY'];

    this.setupProgram();
    this.registerCommands();
  }

  /**
   * Setup the commander program
   */
  private setupProgram(): void {
    this.program
      .name('cmdb')
      .description('CMDB Platform Command-Line Interface')
      .version('1.0.0')
      .option('-u, --url <url>', 'API server URL', this.apiUrl)
      .option('-k, --key <key>', 'API authentication key', this.apiKey)
      .hook('preAction', (thisCommand) => {
        // Update API URL and key from command options
        const options = thisCommand.opts();
        if (options['url']) this.apiUrl = options['url'];
        if (options['key']) this.apiKey = options['key'];
      });

    // Add global error handler
    this.program.exitOverride();
    this.program.configureOutput({
      outputError: (str: string, write: (str: string) => void) => {
        write(chalk.red(str));
      },
    });
  }

  /**
   * Register all command groups
   */
  private registerCommands(): void {
    // Discovery commands
    const discoveryCommand = new DiscoveryCommand(this.apiUrl, this.apiKey);
    discoveryCommand.register(this.program);

    // CI commands
    const ciCommand = new CICommand(this.apiUrl, this.apiKey);
    ciCommand.register(this.program);

    // Query commands
    const queryCommand = new QueryCommand(this.apiUrl, this.apiKey);
    queryCommand.register(this.program);

    // Analytics commands
    const analyticsCommand = new AnalyticsCommand(this.apiUrl, this.apiKey);
    analyticsCommand.register(this.program);

    // Data mart commands
    const dataMartCommand = new DataMartCommand(this.apiUrl, this.apiKey);
    dataMartCommand.register(this.program);

    // Connector commands (single shared parent command to avoid shadowing)
    const connectorCommand = new Command('connector').description('Manage connectors');
    new ConnectorListCommand(this.apiUrl, this.apiKey).register(connectorCommand);
    new ConnectorInstallCommand(this.apiUrl, this.apiKey).register(connectorCommand);
    new ConnectorConfigCommand(this.apiUrl, this.apiKey).register(connectorCommand);
    new ConnectorRunCommand(this.apiUrl, this.apiKey).register(connectorCommand);
    this.program.addCommand(connectorCommand);

    // Worker commands
    this.program.addCommand(createWorkerCommand());

    // Jobs commands
    this.program.addCommand(createJobsCommand());

    // Config command
    this.program
      .command('config')
      .description('Display current configuration')
      .action(() => {
        this.showConfig();
      });

    // Health check command
    this.program
      .command('health')
      .description('Check API server health')
      .action(async () => {
        await this.checkHealth();
      });
  }

  /**
   * Show current configuration
   */
  private showConfig(): void {
    console.log(chalk.cyan('\nCMDB CLI Configuration:'));
    console.log(`  API URL: ${chalk.bold(this.apiUrl)}`);
    console.log(`  API Key: ${this.apiKey ? chalk.green('Set') : chalk.yellow('Not set')}`);
    console.log(chalk.gray('\nEnvironment Variables:'));
    console.log(`  CMDB_API_URL: ${process.env['CMDB_API_URL'] || chalk.gray('not set')}`);
    console.log(`  CMDB_API_KEY: ${process.env['CMDB_API_KEY'] ? chalk.green('set') : chalk.gray('not set')}`);
  }

  /**
   * Check API server health
   */
  private async checkHealth(): Promise<void> {
    const ora = (await import('ora')).default;
    const axios = (await import('axios')).default;

    const spinner = ora('Checking API server health...').start();

    try {
      const response = await axios.get(`${this.apiUrl}/cmdb-health`, {
        timeout: 5000,
      });

      spinner.succeed(chalk.green('API server is healthy'));
      console.log(chalk.cyan('\nServer Status:'));
      console.log(`  Status: ${chalk.green(response.data.status)}`);
      console.log(`  Version: ${response.data.version}`);
      console.log(`  Uptime: ${response.data.uptime}s`);
    } catch (error: any) {
      spinner.fail(chalk.red('API server is unreachable'));

      if (error.code === 'ECONNREFUSED') {
        console.error(chalk.red(`  Cannot connect to ${this.apiUrl}`));
        console.error(chalk.yellow('  Make sure the API server is running'));
      } else if (error.code === 'ETIMEDOUT') {
        console.error(chalk.red('  Connection timeout'));
      } else {
        console.error(chalk.red(`  Error: ${error.message}`));
      }
      process.exit(1);
    }
  }

  /**
   * Run the CLI
   */
  async run(): Promise<void> {
    try {
      await this.program.parseAsync(process.argv);
    } catch (error: any) {
      // Handle commander errors
      if (error.code === 'commander.help' || error.code === 'commander.helpDisplayed') {
        // Help was displayed, exit normally
        process.exit(0);
      } else if (error.code === 'commander.version') {
        // Version was displayed, exit normally
        process.exit(0);
      } else {
        console.error(chalk.red(`\nError: ${error.message}`));
        process.exit(1);
      }
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  const cli = new CMDBCli();
  await cli.run();
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
  });
}

export { CMDBCli };
