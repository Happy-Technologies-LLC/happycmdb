import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';

/**
 * Connector Install Command
 * Install, update, and uninstall connectors
 */
export class ConnectorInstallCommand {
  private apiUrl: string;
  private apiKey?: string;

  constructor(apiUrl: string, apiKey?: string) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }

  /**
   * Register connector install commands
   */
  register(program: Command): void {
    const connector = program
      .command('connector')
      .description('Manage connectors');

    // Install connector
    connector
      .command('install <type>')
      .description('Install a connector from registry')
      .argument('[version]', 'Specific version to install (default: latest)')
      .option('--skip-deps', 'Skip dependency installation')
      .action(async (type, version, options) => {
        await this.installConnector(type, version, options);
      });

    // Update connector
    connector
      .command('update [type]')
      .description('Update connector to latest version')
      .option('--all', 'Update all installed connectors')
      .option('--version <version>', 'Update to specific version')
      .action(async (type, options) => {
        if (options.all) {
          await this.updateAllConnectors();
        } else if (type) {
          await this.updateConnector(type, options.version);
        } else {
          console.error(chalk.red('Error: Please specify a connector type or use --all'));
          process.exit(1);
        }
      });

    // Uninstall connector
    connector
      .command('uninstall <type>')
      .description('Uninstall a connector')
      .option('-f, --force', 'Force uninstall without confirmation')
      .action(async (type, options) => {
        await this.uninstallConnector(type, options);
      });

    // Check for outdated connectors
    connector
      .command('outdated')
      .description('Check for connector updates')
      .action(async () => {
        await this.checkOutdated();
      });

    // Verify connector installation
    connector
      .command('verify <type>')
      .description('Verify connector installation integrity')
      .action(async (type) => {
        await this.verifyConnector(type);
      });

    // Repair connector
    connector
      .command('repair <type>')
      .description('Repair a broken connector installation')
      .action(async (type) => {
        await this.repairConnector(type);
      });

    // Refresh registry cache
    connector
      .command('cache')
      .description('Manage connector registry cache')
      .option('--refresh', 'Refresh registry cache')
      .option('--clear', 'Clear registry cache')
      .action(async (options) => {
        if (options.refresh) {
          await this.refreshCache();
        } else if (options.clear) {
          await this.clearCache();
        } else {
          console.error(chalk.red('Error: Please specify --refresh or --clear'));
          process.exit(1);
        }
      });
  }

  /**
   * Install connector
   */
  private async installConnector(type: string, version?: string, options?: any): Promise<void> {
    console.log(chalk.cyan(`\nInstalling connector: ${chalk.bold(type)}`));
    if (version) {
      console.log(chalk.gray(`Version: ${version}`));
    }

    const spinner = ora('Starting installation...').start();

    try {
      const data: any = { connectorType: type };
      if (version) data.version = version;
      if (options?.skipDeps) data.skipDependencies = true;

      const response = await axios.post(`${this.apiUrl}/connectors/install`, data, {
        headers: this.getHeaders(),
      });

      const result = response.data;

      if (result.success) {
        spinner.succeed(chalk.green('Connector installed successfully!'));

        console.log(chalk.cyan('\nInstallation Details:'));
        console.log(`  Type: ${chalk.bold(result.connector.connectorType)}`);
        console.log(`  Name: ${result.connector.name}`);
        console.log(`  Version: ${chalk.bold(result.connector.installedVersion)}`);
        console.log(`  Path: ${result.connector.installPath}`);

        if (result.connector.resources && result.connector.resources.length > 0) {
          console.log(chalk.cyan(`\n  Resources (${result.connector.resources.length}):`));
          result.connector.resources.slice(0, 5).forEach((resource: any) => {
            console.log(`    - ${resource.name}`);
          });
          if (result.connector.resources.length > 5) {
            console.log(chalk.gray(`    ... and ${result.connector.resources.length - 5} more`));
          }
        }

        console.log(chalk.green('\nNext steps:'));
        console.log(`  1. Create a configuration: ${chalk.yellow(`happycmdb connector config create`)}`);
        console.log(`  2. View connector details: ${chalk.yellow(`happycmdb connector info ${type}`)}`);
      } else {
        spinner.fail(chalk.red('Installation failed'));
        if (result.message) {
          console.error(chalk.red(`  ${result.message}`));
        }
        if (result.errors && result.errors.length > 0) {
          console.error(chalk.red('\n  Errors:'));
          result.errors.forEach((err: string) => {
            console.error(chalk.red(`    - ${err}`));
          });
        }
      }
    } catch (error: any) {
      spinner.fail(chalk.red('Installation failed'));
      this.handleError(error);
    }
  }

  /**
   * Update connector
   */
  private async updateConnector(type: string, version?: string): Promise<void> {
    console.log(chalk.cyan(`\nUpdating connector: ${chalk.bold(type)}`));

    const spinner = ora('Checking for updates...').start();

    try {
      const data: any = { connectorType: type };
      if (version) data.version = version;

      const response = await axios.put(`${this.apiUrl}/connectors/${type}/update`, data, {
        headers: this.getHeaders(),
      });

      const result = response.data;

      if (result.success) {
        spinner.succeed(chalk.green('Connector updated successfully!'));

        console.log(chalk.cyan('\nUpdate Details:'));
        console.log(`  Type: ${chalk.bold(result.connector.connectorType)}`);
        console.log(`  Previous Version: ${chalk.gray(result.previousVersion)}`);
        console.log(`  New Version: ${chalk.bold.green(result.newVersion)}`);

        if (result.message) {
          console.log(chalk.cyan(`\n  ${result.message}`));
        }
      } else {
        spinner.fail(chalk.red('Update failed'));
        if (result.message) {
          console.error(chalk.red(`  ${result.message}`));
        }
      }
    } catch (error: any) {
      spinner.fail(chalk.red('Update failed'));
      this.handleError(error);
    }
  }

  /**
   * Update all connectors
   */
  private async updateAllConnectors(): Promise<void> {
    console.log(chalk.cyan('\nUpdating all connectors...'));

    const spinner = ora('Fetching installed connectors...').start();

    try {
      // Get all installed connectors
      const installedResponse = await axios.get(`${this.apiUrl}/connectors/installed`, {
        headers: this.getHeaders(),
      });

      const connectors = installedResponse.data;
      spinner.succeed(chalk.green(`Found ${connectors.length} installed connectors`));

      if (connectors.length === 0) {
        console.log(chalk.yellow('No connectors to update'));
        return;
      }

      let updated = 0;
      let failed = 0;
      let skipped = 0;

      for (const connector of connectors) {
        const type = connector.connectorType || connector.connector_type;
        const currentVersion = connector.installedVersion || connector.installed_version;
        const latestVersion = connector.latestAvailableVersion || connector.latest_available_version;

        if (currentVersion === latestVersion) {
          console.log(chalk.gray(`  ${type}: Already up to date (${currentVersion})`));
          skipped++;
          continue;
        }

        console.log(chalk.cyan(`\n  Updating ${type} (${currentVersion} → ${latestVersion})...`));

        try {
          const response = await axios.put(
            `${this.apiUrl}/connectors/${type}/update`,
            { connectorType: type },
            { headers: this.getHeaders() }
          );

          if (response.data.success) {
            console.log(chalk.green(`    ✓ Updated successfully`));
            updated++;
          } else {
            console.log(chalk.red(`    ✗ Update failed: ${response.data.message}`));
            failed++;
          }
        } catch (error: any) {
          console.log(chalk.red(`    ✗ Update failed: ${error.message}`));
          failed++;
        }
      }

      console.log(chalk.cyan('\n═══════════════════════════════'));
      console.log(chalk.cyan('  Update Summary'));
      console.log(chalk.cyan('═══════════════════════════════'));
      console.log(chalk.green(`  Updated: ${updated}`));
      console.log(chalk.gray(`  Skipped: ${skipped}`));
      if (failed > 0) {
        console.log(chalk.red(`  Failed: ${failed}`));
      }
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch connectors'));
      this.handleError(error);
    }
  }

  /**
   * Uninstall connector
   */
  private async uninstallConnector(type: string, options: any): Promise<void> {
    if (!options.force) {
      console.log(chalk.yellow('\nWarning: This will permanently uninstall the connector'));
      console.log(chalk.yellow('All configurations using this connector will be affected'));
      console.log(chalk.yellow(`\nUse ${chalk.bold('--force')} to confirm uninstallation`));
      return;
    }

    const spinner = ora(`Uninstalling connector: ${type}...`).start();

    try {
      const response = await axios.delete(`${this.apiUrl}/connectors/${type}`, {
        headers: this.getHeaders(),
      });

      const result = response.data;

      if (result.success) {
        spinner.succeed(chalk.green('Connector uninstalled successfully'));
        if (result.message) {
          console.log(chalk.gray(`  ${result.message}`));
        }
      } else {
        spinner.fail(chalk.red('Uninstall failed'));
        if (result.message) {
          console.error(chalk.red(`  ${result.message}`));
        }
      }
    } catch (error: any) {
      spinner.fail(chalk.red('Uninstall failed'));
      this.handleError(error);
    }
  }

  /**
   * Check for outdated connectors
   */
  private async checkOutdated(): Promise<void> {
    const spinner = ora('Checking for updates...').start();

    try {
      const response = await axios.get(`${this.apiUrl}/connectors/installed`, {
        headers: this.getHeaders(),
      });

      const connectors = response.data;
      const outdated = connectors.filter((c: any) => {
        const current = c.installedVersion || c.installed_version;
        const latest = c.latestAvailableVersion || c.latest_available_version;
        return current && latest && current !== latest;
      });

      spinner.succeed(
        outdated.length > 0
          ? chalk.yellow(`Found ${outdated.length} outdated connectors`)
          : chalk.green('All connectors are up to date')
      );

      if (outdated.length === 0) {
        return;
      }

      console.log(chalk.cyan('\n╔═════════════════════════════════════════════════════════════╗'));
      console.log(chalk.cyan('║') + chalk.bold('  Type                Current      Latest       Update   ') + chalk.cyan('║'));
      console.log(chalk.cyan('╠═════════════════════════════════════════════════════════════╣'));

      outdated.forEach((connector: any) => {
        const type = (connector.connectorType || connector.connector_type || '').padEnd(19).substring(0, 19);
        const current = (connector.installedVersion || connector.installed_version || '').padEnd(12).substring(0, 12);
        const latest = (connector.latestAvailableVersion || connector.latest_available_version || '')
          .padEnd(12)
          .substring(0, 12);

        console.log(
          chalk.cyan('║') +
            `  ${chalk.bold(type)} ${chalk.gray(current)} ${chalk.green(latest)} ${chalk.yellow('Available')} ` +
            chalk.cyan('║')
        );
      });

      console.log(chalk.cyan('╚═════════════════════════════════════════════════════════════╝'));
      console.log(chalk.gray('\nUpdate with: happycmdb connector update <type>'));
      console.log(chalk.gray('Update all: happycmdb connector update --all'));
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to check for updates'));
      this.handleError(error);
    }
  }

  /**
   * Verify connector installation
   */
  private async verifyConnector(type: string): Promise<void> {
    const spinner = ora(`Verifying connector: ${type}...`).start();

    try {
      const response = await axios.post(
        `${this.apiUrl}/connectors/${type}/verify`,
        {},
        { headers: this.getHeaders() }
      );

      const result = response.data;

      if (result.success) {
        spinner.succeed(chalk.green('Connector verified successfully'));
        console.log(chalk.cyan('\n  All checks passed'));
      } else {
        spinner.fail(chalk.red('Verification failed'));
        if (result.errors && result.errors.length > 0) {
          console.error(chalk.red('\n  Issues found:'));
          result.errors.forEach((err: string) => {
            console.error(chalk.red(`    - ${err}`));
          });
        }
      }
    } catch (error: any) {
      spinner.fail(chalk.red('Verification failed'));
      this.handleError(error);
    }
  }

  /**
   * Repair connector
   */
  private async repairConnector(type: string): Promise<void> {
    console.log(chalk.cyan(`\nRepairing connector: ${chalk.bold(type)}`));
    const spinner = ora('Starting repair...').start();

    try {
      const response = await axios.post(
        `${this.apiUrl}/connectors/${type}/repair`,
        {},
        { headers: this.getHeaders() }
      );

      const result = response.data;

      if (result.success) {
        spinner.succeed(chalk.green('Connector repaired successfully'));
        if (result.message) {
          console.log(chalk.gray(`  ${result.message}`));
        }
      } else {
        spinner.fail(chalk.red('Repair failed'));
        if (result.message) {
          console.error(chalk.red(`  ${result.message}`));
        }
      }
    } catch (error: any) {
      spinner.fail(chalk.red('Repair failed'));
      this.handleError(error);
    }
  }

  /**
   * Refresh registry cache
   */
  private async refreshCache(): Promise<void> {
    const spinner = ora('Refreshing connector registry cache...').start();

    try {
      const response = await axios.post(
        `${this.apiUrl}/connectors/registry/refresh`,
        {},
        { headers: this.getHeaders() }
      );

      spinner.succeed(chalk.green('Registry cache refreshed successfully'));
      if (response.data.count !== undefined) {
        console.log(chalk.gray(`  Cached ${response.data.count} connectors`));
      }
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to refresh cache'));
      this.handleError(error);
    }
  }

  /**
   * Clear registry cache
   */
  private async clearCache(): Promise<void> {
    const spinner = ora('Clearing connector registry cache...').start();

    try {
      await axios.delete(`${this.apiUrl}/connectors/registry/cache`, {
        headers: this.getHeaders(),
      });

      spinner.succeed(chalk.green('Registry cache cleared successfully'));
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to clear cache'));
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
