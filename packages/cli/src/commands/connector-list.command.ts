import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';

/**
 * Connector List Command
 * List available connectors from registry
 */
export class ConnectorListCommand {
  private apiUrl: string;
  private apiKey?: string;

  constructor(apiUrl: string, apiKey?: string) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }

  /**
   * Register connector list commands
   */
  register(program: Command): void {
    const connector = program
      .command('connector')
      .description('Manage connectors');

    // List available connectors from registry
    connector
      .command('list')
      .description('List available connectors from registry')
      .option('-c, --category <category>', 'Filter by category: discovery, connector')
      .option('-s, --search <query>', 'Search connectors by name or description')
      .option('--verified', 'Show only verified connectors')
      .option('--installed', 'Show only installed connectors')
      .action(async (options) => {
        await this.listConnectors(options);
      });

    // Show installed connectors
    connector
      .command('installed')
      .description('List installed connectors')
      .option('-c, --category <category>', 'Filter by category: discovery, connector')
      .option('--enabled', 'Show only enabled connectors')
      .action(async (options) => {
        await this.listInstalled(options);
      });

    // Show connector info/details
    connector
      .command('info <type>')
      .description('Show detailed information about a connector')
      .option('--registry', 'Show info from registry (not installed)')
      .action(async (type, options) => {
        await this.showConnectorInfo(type, options);
      });

    // Search connectors
    connector
      .command('search <query>')
      .description('Search connectors in registry')
      .option('-c, --category <category>', 'Filter by category')
      .option('--verified', 'Only verified connectors')
      .action(async (query, options) => {
        await this.searchConnectors(query, options);
      });
  }

  /**
   * List available connectors from registry
   */
  private async listConnectors(options: any): Promise<void> {
    const spinner = ora('Fetching connector catalog...').start();

    try {
      const params: any = {};

      if (options.category) {
        params.category = options.category.toUpperCase();
      }
      if (options.search) {
        params.search = options.search;
      }
      if (options.verified) {
        params.verifiedOnly = true;
      }

      const endpoint = options.installed
        ? `${this.apiUrl}/connectors/installed`
        : `${this.apiUrl}/connectors/registry`;

      const response = await axios.get(endpoint, {
        params,
        headers: this.getHeaders(),
      });

      const connectors = response.data;
      spinner.succeed(chalk.green(`Found ${connectors.length} connectors`));

      if (connectors.length === 0) {
        console.log(chalk.yellow('\nNo connectors found'));
        return;
      }

      // Display as table
      this.displayConnectorTable(connectors);
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch connectors'));
      this.handleError(error);
    }
  }

  /**
   * List installed connectors
   */
  private async listInstalled(options: any): Promise<void> {
    const spinner = ora('Fetching installed connectors...').start();

    try {
      const params: any = {};

      if (options.category) {
        params.category = options.category.toUpperCase();
      }
      if (options.enabled !== undefined) {
        params.enabled = true;
      }

      const response = await axios.get(`${this.apiUrl}/connectors/installed`, {
        params,
        headers: this.getHeaders(),
      });

      const connectors = response.data;
      spinner.succeed(chalk.green(`Found ${connectors.length} installed connectors`));

      if (connectors.length === 0) {
        console.log(chalk.yellow('\nNo installed connectors found'));
        console.log(chalk.gray('Install connectors with: happycmdb connector install <type>'));
        return;
      }

      // Display installed connectors
      this.displayInstalledTable(connectors);
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch installed connectors'));
      this.handleError(error);
    }
  }

  /**
   * Show detailed connector information
   */
  private async showConnectorInfo(type: string, options: any): Promise<void> {
    const spinner = ora('Fetching connector details...').start();

    try {
      const endpoint = options.registry
        ? `${this.apiUrl}/connectors/registry/${type}`
        : `${this.apiUrl}/connectors/installed/${type}`;

      const response = await axios.get(endpoint, {
        headers: this.getHeaders(),
      });

      const connector = response.data;
      spinner.succeed(chalk.green('Connector details retrieved'));

      console.log(chalk.cyan('\nConnector Details:'));
      console.log(`  Type: ${chalk.bold(connector.connectorType || connector.connector_type)}`);
      console.log(`  Name: ${chalk.bold(connector.name)}`);
      console.log(`  Category: ${this.categorizeBadge(connector.category)}`);

      if (connector.description) {
        console.log(`  Description: ${connector.description}`);
      }

      if (connector.verified !== undefined) {
        console.log(`  Verified: ${connector.verified ? chalk.green('Yes') : chalk.gray('No')}`);
      }

      // Version information
      if (options.registry) {
        console.log(`  Latest Version: ${chalk.bold(connector.latestVersion || connector.latest_version)}`);
        if (connector.versions && connector.versions.length > 0) {
          console.log(`  Available Versions: ${connector.versions.length}`);
        }
      } else {
        console.log(`  Installed Version: ${chalk.bold(connector.installedVersion || connector.installed_version)}`);
        if (connector.latestAvailableVersion) {
          const updateAvailable = connector.installedVersion !== connector.latestAvailableVersion;
          console.log(
            `  Latest Available: ${chalk.bold(connector.latestAvailableVersion)}${
              updateAvailable ? chalk.yellow(' (update available)') : ''
            }`
          );
        }
        console.log(`  Enabled: ${connector.enabled ? chalk.green('Yes') : chalk.gray('No')}`);
        console.log(`  Install Path: ${connector.installPath || connector.install_path}`);
      }

      // Metadata
      if (connector.author) {
        console.log(`  Author: ${connector.author}`);
      }
      if (connector.license) {
        console.log(`  License: ${connector.license}`);
      }
      if (connector.homepage) {
        console.log(`  Homepage: ${connector.homepage}`);
      }

      // Resources
      if (connector.resources && connector.resources.length > 0) {
        console.log(chalk.cyan('\n  Resources:'));
        connector.resources.forEach((resource: any) => {
          const enabledMark = resource.enabledByDefault ? chalk.green('✓') : ' ';
          console.log(`    ${enabledMark} ${resource.name} (${resource.id})`);
          if (resource.ciType) {
            console.log(`      CI Type: ${resource.ciType}`);
          }
        });
      }

      // Capabilities
      if (connector.capabilities) {
        const caps = connector.capabilities;
        console.log(chalk.cyan('\n  Capabilities:'));
        console.log(`    Extraction: ${this.boolBadge(caps.extraction)}`);
        console.log(`    Relationships: ${this.boolBadge(caps.relationships)}`);
        console.log(`    Incremental: ${this.boolBadge(caps.incremental)}`);
        console.log(`    Bidirectional: ${this.boolBadge(caps.bidirectional)}`);
      }

      // Statistics (for installed)
      if (!options.registry && connector.totalRuns !== undefined) {
        console.log(chalk.cyan('\n  Statistics:'));
        console.log(`    Total Runs: ${connector.totalRuns}`);
        console.log(`    Successful: ${connector.successfulRuns}`);
        console.log(`    Failed: ${connector.failedRuns}`);
        if (connector.lastRunAt) {
          console.log(`    Last Run: ${new Date(connector.lastRunAt).toLocaleString()}`);
          console.log(`    Last Status: ${this.colorizeStatus(connector.lastRunStatus)}`);
        }
      }

      // Tags
      if (connector.tags && connector.tags.length > 0) {
        console.log(chalk.cyan('\n  Tags:'));
        console.log(`    ${connector.tags.join(', ')}`);
      }

      // Installation dates
      if (connector.installedAt) {
        console.log(chalk.cyan('\n  Installation:'));
        console.log(`    Installed: ${new Date(connector.installedAt).toLocaleString()}`);
        console.log(`    Updated: ${new Date(connector.updatedAt).toLocaleString()}`);
      }
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch connector details'));
      this.handleError(error);
    }
  }

  /**
   * Search connectors
   */
  private async searchConnectors(query: string, options: any): Promise<void> {
    const spinner = ora(`Searching for "${query}"...`).start();

    try {
      const params: any = { search: query };

      if (options.category) {
        params.category = options.category.toUpperCase();
      }
      if (options.verified) {
        params.verifiedOnly = true;
      }

      const response = await axios.get(`${this.apiUrl}/connectors/registry`, {
        params,
        headers: this.getHeaders(),
      });

      const connectors = response.data;
      spinner.succeed(chalk.green(`Found ${connectors.length} matching connectors`));

      if (connectors.length === 0) {
        console.log(chalk.yellow(`\nNo connectors found matching "${query}"`));
        return;
      }

      this.displayConnectorTable(connectors);
    } catch (error: any) {
      spinner.fail(chalk.red('Search failed'));
      this.handleError(error);
    }
  }

  /**
   * Display connectors as table (registry)
   */
  private displayConnectorTable(connectors: any[]): void {
    console.log(chalk.cyan('\n╔════════════════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║') + chalk.bold('  Type                 Name                   Version  Category  Verified') + chalk.cyan('║'));
    console.log(chalk.cyan('╠════════════════════════════════════════════════════════════════════════╣'));

    connectors.forEach((connector: any) => {
      const type = (connector.connectorType || connector.connector_type || '').padEnd(20).substring(0, 20);
      const name = (connector.name || '').padEnd(22).substring(0, 22);
      const version = (connector.latestVersion || connector.latest_version || connector.installedVersion || 'N/A')
        .padEnd(8)
        .substring(0, 8);
      const category = (connector.category || '').padEnd(9).substring(0, 9);
      const verified = connector.verified ? chalk.green('✓') : chalk.gray('-');

      console.log(
        chalk.cyan('║') +
          `  ${chalk.bold(type)} ${name} ${version} ${category} ${verified}     ` +
          chalk.cyan('║')
      );
    });

    console.log(chalk.cyan('╚════════════════════════════════════════════════════════════════════════╝'));
    console.log(chalk.gray(`\nTotal: ${connectors.length} connectors`));
    console.log(chalk.gray('Run "happycmdb connector info <type>" for detailed information'));
  }

  /**
   * Display installed connectors table
   */
  private displayInstalledTable(connectors: any[]): void {
    console.log(chalk.cyan('\n╔═══════════════════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║') + chalk.bold('  Type                 Name                   Version    Enabled  Runs  ') + chalk.cyan('║'));
    console.log(chalk.cyan('╠═══════════════════════════════════════════════════════════════════════════╣'));

    connectors.forEach((connector: any) => {
      const type = (connector.connectorType || connector.connector_type || '').padEnd(20).substring(0, 20);
      const name = (connector.name || '').padEnd(22).substring(0, 22);
      const version = (connector.installedVersion || connector.installed_version || 'N/A')
        .padEnd(10)
        .substring(0, 10);
      const enabled = connector.enabled ? chalk.green('Yes') : chalk.gray('No ');
      const runs = (connector.totalRuns || 0).toString().padStart(4);

      console.log(
        chalk.cyan('║') +
          `  ${chalk.bold(type)} ${name} ${version} ${enabled}      ${runs}  ` +
          chalk.cyan('║')
      );
    });

    console.log(chalk.cyan('╚═══════════════════════════════════════════════════════════════════════════╝'));
    console.log(chalk.gray(`\nTotal: ${connectors.length} installed connectors`));
  }

  /**
   * Category badge
   */
  private categorizeBadge(category: string): string {
    if (category.toLowerCase() === 'discovery') {
      return chalk.blue(category);
    } else if (category.toLowerCase() === 'connector') {
      return chalk.magenta(category);
    }
    return category;
  }

  /**
   * Boolean badge
   */
  private boolBadge(value: boolean): string {
    return value ? chalk.green('Yes') : chalk.gray('No');
  }

  /**
   * Colorize status text
   */
  private colorizeStatus(status: string): string {
    if (!status) return chalk.gray('N/A');

    switch (status.toLowerCase()) {
      case 'completed':
        return chalk.green(status);
      case 'running':
        return chalk.blue(status);
      case 'failed':
        return chalk.red(status);
      case 'queued':
        return chalk.yellow(status);
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
