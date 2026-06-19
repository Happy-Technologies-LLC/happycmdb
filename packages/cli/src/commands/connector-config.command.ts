import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';

/**
 * Connector Configuration Command
 * Manage connector configurations
 */
export class ConnectorConfigCommand {
  private apiUrl: string;
  private apiKey?: string;

  constructor(apiUrl: string, apiKey?: string) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }

  /**
   * Register connector config commands
   */
  register(program: Command): void {
    const config = program
      .command('connector')
      .description('Manage connectors')
      .command('config')
      .description('Manage connector configurations');

    // Create configuration (interactive)
    config
      .command('create')
      .description('Create a new connector configuration (interactive)')
      .option('-t, --type <type>', 'Connector type')
      .option('-n, --name <name>', 'Configuration name')
      .option('--non-interactive', 'Non-interactive mode (requires all options)')
      .option('--connection <json>', 'Connection config as JSON string')
      .option('--resources <resources>', 'Comma-separated resource IDs to enable')
      .action(async (options) => {
        await this.createConfig(options);
      });

    // List configurations
    config
      .command('list')
      .description('List all connector configurations')
      .option('-t, --type <type>', 'Filter by connector type')
      .option('--enabled', 'Show only enabled configurations')
      .action(async (options) => {
        await this.listConfigs(options);
      });

    // Show configuration details
    config
      .command('show <name>')
      .description('Show configuration details')
      .action(async (name) => {
        await this.showConfig(name);
      });

    // Edit configuration
    config
      .command('edit <name>')
      .description('Edit a configuration')
      .option('--name <newName>', 'Update configuration name')
      .option('--description <desc>', 'Update description')
      .option('--connection <json>', 'Update connection config')
      .option('--enable', 'Enable configuration')
      .option('--disable', 'Disable configuration')
      .option('--schedule <cron>', 'Update schedule (cron expression)')
      .option('--schedule-enable', 'Enable schedule')
      .option('--schedule-disable', 'Disable schedule')
      .action(async (name, options) => {
        await this.editConfig(name, options);
      });

    // Delete configuration
    config
      .command('delete <name>')
      .description('Delete a configuration')
      .option('-f, --force', 'Force deletion without confirmation')
      .action(async (name, options) => {
        await this.deleteConfig(name, options);
      });

    // Test connection
    config
      .command('test <name>')
      .description('Test connector connection')
      .action(async (name) => {
        await this.testConnection(name);
      });

    // Enable/disable configuration
    config
      .command('enable <name>')
      .description('Enable a configuration')
      .action(async (name) => {
        await this.toggleConfig(name, true);
      });

    config
      .command('disable <name>')
      .description('Disable a configuration')
      .action(async (name) => {
        await this.toggleConfig(name, false);
      });

    // Resource management
    config
      .command('resources <name>')
      .description('Manage enabled resources for a configuration')
      .option('--list', 'List enabled resources')
      .option('--add <resources>', 'Add resources (comma-separated)')
      .option('--remove <resources>', 'Remove resources (comma-separated)')
      .action(async (name, options) => {
        await this.manageResources(name, options);
      });
  }

  /**
   * Create configuration
   */
  private async createConfig(options: any): Promise<void> {
    console.log(chalk.cyan('\n╔══════════════════════════════════════════╗'));
    console.log(chalk.cyan('║') + chalk.bold('  Create Connector Configuration        ') + chalk.cyan('║'));
    console.log(chalk.cyan('╚══════════════════════════════════════════╝\n'));

    // For now, we'll use a simplified non-interactive approach
    // In a full implementation, we'd use inquirer for interactive prompts
    if (!options.nonInteractive) {
      console.log(chalk.yellow('Interactive mode not yet implemented.'));
      console.log(chalk.gray('Please use --non-interactive mode with all required options:\n'));
      console.log(chalk.gray('  --type <type>           Connector type'));
      console.log(chalk.gray('  --name <name>           Configuration name'));
      console.log(chalk.gray('  --connection <json>     Connection config as JSON'));
      console.log(chalk.gray('  --resources <list>      Comma-separated resource IDs (optional)\n'));
      console.log(chalk.gray('Example:'));
      console.log(
        chalk.gray(
          '  happycmdb connector config create --non-interactive --type vmware-vsphere --name my-vcenter --connection \'{"host":"vcenter.local","username":"admin","password":"pass"}\''
        )
      );
      return;
    }

    if (!options.type || !options.name || !options.connection) {
      console.error(chalk.red('Error: --type, --name, and --connection are required in non-interactive mode'));
      return;
    }

    const spinner = ora('Creating configuration...').start();

    try {
      let connectionData;
      try {
        connectionData = JSON.parse(options.connection);
      } catch {
        spinner.fail(chalk.red('Invalid JSON in --connection'));
        return;
      }

      const data: any = {
        name: options.name,
        connectorType: options.type,
        connection: connectionData,
      };

      if (options.resources) {
        data.enabledResources = options.resources.split(',').map((r: string) => r.trim());
      }

      const response = await axios.post(`${this.apiUrl}/connector-configs`, data, {
        headers: this.getHeaders(),
      });

      const config = response.data;
      spinner.succeed(chalk.green('Configuration created successfully!'));

      console.log(chalk.cyan('\nConfiguration Details:'));
      console.log(`  ID: ${chalk.bold(config.id)}`);
      console.log(`  Name: ${chalk.bold(config.name)}`);
      console.log(`  Type: ${config.connectorType}`);
      console.log(`  Enabled: ${config.enabled ? chalk.green('Yes') : chalk.gray('No')}`);

      if (config.enabledResources && config.enabledResources.length > 0) {
        console.log(`  Resources: ${config.enabledResources.length} enabled`);
      }

      console.log(chalk.cyan('\nNext steps:'));
      console.log(`  1. Test connection: ${chalk.yellow(`happycmdb connector config test ${config.name}`)}`);
      console.log(`  2. Run connector: ${chalk.yellow(`happycmdb connector run ${config.name}`)}`);
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to create configuration'));
      this.handleError(error);
    }
  }

  /**
   * List configurations
   */
  private async listConfigs(options: any): Promise<void> {
    const spinner = ora('Fetching configurations...').start();

    try {
      const params: any = {};
      if (options.type) params.connectorType = options.type;
      if (options.enabled !== undefined) params.enabled = true;

      const response = await axios.get(`${this.apiUrl}/connector-configs`, {
        params,
        headers: this.getHeaders(),
      });

      const configs = response.data;
      spinner.succeed(chalk.green(`Found ${configs.length} configurations`));

      if (configs.length === 0) {
        console.log(chalk.yellow('\nNo configurations found'));
        console.log(chalk.gray('Create one with: happycmdb connector config create'));
        return;
      }

      console.log(chalk.cyan('\n╔═══════════════════════════════════════════════════════════════════════╗'));
      console.log(chalk.cyan('║') + chalk.bold('  Name                Type                  Enabled  Schedule     ') + chalk.cyan('║'));
      console.log(chalk.cyan('╠═══════════════════════════════════════════════════════════════════════╣'));

      configs.forEach((config: any) => {
        const name = (config.name || '').padEnd(19).substring(0, 19);
        const type = (config.connectorType || '').padEnd(21).substring(0, 21);
        const enabled = config.enabled ? chalk.green('Yes') : chalk.gray('No ');
        const schedule = config.scheduleEnabled
          ? chalk.green('Enabled ')
          : config.schedule
          ? chalk.gray('Disabled')
          : chalk.gray('None    ');

        console.log(
          chalk.cyan('║') + `  ${chalk.bold(name)} ${type} ${enabled}      ${schedule}   ` + chalk.cyan('║')
        );
      });

      console.log(chalk.cyan('╚═══════════════════════════════════════════════════════════════════════╝'));
      console.log(chalk.gray(`\nTotal: ${configs.length} configurations`));
      console.log(chalk.gray('Run "happycmdb connector config show <name>" for details'));
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch configurations'));
      this.handleError(error);
    }
  }

  /**
   * Show configuration details
   */
  private async showConfig(name: string): Promise<void> {
    const spinner = ora('Fetching configuration...').start();

    try {
      // Find config by name
      const response = await axios.get(`${this.apiUrl}/connector-configs`, {
        params: { name },
        headers: this.getHeaders(),
      });

      const configs = response.data;
      if (configs.length === 0) {
        spinner.fail(chalk.red(`Configuration "${name}" not found`));
        return;
      }

      const config = configs[0];
      spinner.succeed(chalk.green('Configuration details retrieved'));

      console.log(chalk.cyan('\n╔═══════════════════════════════════════╗'));
      console.log(chalk.cyan('║') + chalk.bold('  Configuration Details              ') + chalk.cyan('║'));
      console.log(chalk.cyan('╚═══════════════════════════════════════╝\n'));

      console.log(chalk.cyan('Basic Information:'));
      console.log(`  ID: ${chalk.bold(config.id)}`);
      console.log(`  Name: ${chalk.bold(config.name)}`);
      console.log(`  Type: ${config.connectorType}`);
      console.log(`  Enabled: ${config.enabled ? chalk.green('Yes') : chalk.gray('No')}`);

      if (config.description) {
        console.log(`  Description: ${config.description}`);
      }

      console.log(chalk.cyan('\nScheduling:'));
      if (config.schedule) {
        console.log(`  Schedule: ${config.schedule}`);
        console.log(`  Enabled: ${config.scheduleEnabled ? chalk.green('Yes') : chalk.gray('No')}`);
      } else {
        console.log(chalk.gray('  No schedule configured'));
      }

      console.log(chalk.cyan('\nConnection:'));
      Object.entries(config.connection || {}).forEach(([key, value]) => {
        // Mask sensitive values
        const displayValue =
          key.toLowerCase().includes('password') || key.toLowerCase().includes('secret')
            ? chalk.gray('********')
            : value;
        console.log(`  ${key}: ${displayValue}`);
      });

      console.log(chalk.cyan('\nResources:'));
      if (config.enabledResources && config.enabledResources.length > 0) {
        console.log(chalk.green(`  ${config.enabledResources.length} resources enabled:`));
        config.enabledResources.forEach((resource: string) => {
          console.log(`    - ${resource}`);
        });
      } else {
        console.log(chalk.gray('  Using default resources'));
      }

      console.log(chalk.cyan('\nError Handling:'));
      console.log(`  Max Retries: ${config.maxRetries || 3}`);
      console.log(`  Retry Delay: ${config.retryDelaySeconds || 300}s`);
      console.log(`  Continue on Error: ${config.continueOnError ? chalk.yellow('Yes') : chalk.gray('No')}`);

      console.log(chalk.cyan('\nNotifications:'));
      if (config.notificationChannels && config.notificationChannels.length > 0) {
        console.log(`  Channels: ${config.notificationChannels.join(', ')}`);
        console.log(`  On Success: ${config.notificationOnSuccess ? chalk.green('Yes') : chalk.gray('No')}`);
        console.log(`  On Failure: ${config.notificationOnFailure ? chalk.green('Yes') : chalk.gray('No')}`);
      } else {
        console.log(chalk.gray('  No notification channels configured'));
      }

      console.log(chalk.cyan('\nMetadata:'));
      console.log(`  Created: ${new Date(config.createdAt).toLocaleString()}`);
      console.log(`  Updated: ${new Date(config.updatedAt).toLocaleString()}`);
      if (config.createdBy) {
        console.log(`  Created By: ${config.createdBy}`);
      }
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch configuration'));
      this.handleError(error);
    }
  }

  /**
   * Edit configuration
   */
  private async editConfig(name: string, options: any): Promise<void> {
    const spinner = ora('Updating configuration...').start();

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

      if (options.name) data.name = options.name;
      if (options.description) data.description = options.description;
      if (options.connection) {
        try {
          data.connection = JSON.parse(options.connection);
        } catch {
          spinner.fail(chalk.red('Invalid JSON in --connection'));
          return;
        }
      }
      if (options.enable) data.enabled = true;
      if (options.disable) data.enabled = false;
      if (options.schedule) data.schedule = options.schedule;
      if (options.scheduleEnable) data.scheduleEnabled = true;
      if (options.scheduleDisable) data.scheduleEnabled = false;

      if (Object.keys(data).length === 0) {
        spinner.fail(chalk.red('No updates specified'));
        return;
      }

      await axios.put(`${this.apiUrl}/connector-configs/${configId}`, data, {
        headers: this.getHeaders(),
      });

      spinner.succeed(chalk.green('Configuration updated successfully'));
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to update configuration'));
      this.handleError(error);
    }
  }

  /**
   * Delete configuration
   */
  private async deleteConfig(name: string, options: any): Promise<void> {
    if (!options.force) {
      console.log(chalk.yellow('\nWarning: This will permanently delete the configuration'));
      console.log(chalk.yellow(`Use ${chalk.bold('--force')} to confirm deletion`));
      return;
    }

    const spinner = ora('Deleting configuration...').start();

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

      await axios.delete(`${this.apiUrl}/connector-configs/${configId}`, {
        headers: this.getHeaders(),
      });

      spinner.succeed(chalk.green('Configuration deleted successfully'));
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to delete configuration'));
      this.handleError(error);
    }
  }

  /**
   * Test connection
   */
  private async testConnection(name: string): Promise<void> {
    const spinner = ora('Testing connection...').start();

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

      const response = await axios.post(
        `${this.apiUrl}/connector-configs/${configId}/test`,
        {},
        { headers: this.getHeaders() }
      );

      const result = response.data;

      if (result.success) {
        spinner.succeed(chalk.green('Connection test successful!'));
        if (result.message) {
          console.log(chalk.cyan(`  ${result.message}`));
        }
        if (result.details) {
          console.log(chalk.cyan('\n  Connection Details:'));
          Object.entries(result.details).forEach(([key, value]) => {
            console.log(`    ${key}: ${value}`);
          });
        }
      } else {
        spinner.fail(chalk.red('Connection test failed'));
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
      spinner.fail(chalk.red('Connection test failed'));
      this.handleError(error);
    }
  }

  /**
   * Toggle configuration enabled/disabled
   */
  private async toggleConfig(name: string, enabled: boolean): Promise<void> {
    const action = enabled ? 'Enabling' : 'Disabling';
    const spinner = ora(`${action} configuration...`).start();

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
      const endpoint = enabled ? 'enable' : 'disable';

      await axios.post(`${this.apiUrl}/connector-configs/${configId}/${endpoint}`, {}, { headers: this.getHeaders() });

      spinner.succeed(chalk.green(`Configuration ${enabled ? 'enabled' : 'disabled'} successfully`));
    } catch (error: any) {
      spinner.fail(chalk.red(`Failed to ${enabled ? 'enable' : 'disable'} configuration`));
      this.handleError(error);
    }
  }

  /**
   * Manage resources
   */
  private async manageResources(name: string, options: any): Promise<void> {
    const spinner = ora('Managing resources...').start();

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

      const config = findResponse.data[0];
      const configId = config.id;

      if (options.list) {
        spinner.succeed(chalk.green('Enabled resources retrieved'));
        console.log(chalk.cyan('\nEnabled Resources:'));
        if (config.enabledResources && config.enabledResources.length > 0) {
          config.enabledResources.forEach((resource: string) => {
            console.log(`  - ${resource}`);
          });
        } else {
          console.log(chalk.gray('  Using default resources'));
        }
        return;
      }

      let updatedResources = [...(config.enabledResources || [])];

      if (options.add) {
        const toAdd = options.add.split(',').map((r: string) => r.trim());
        updatedResources = [...new Set([...updatedResources, ...toAdd])];
      }

      if (options.remove) {
        const toRemove = options.remove.split(',').map((r: string) => r.trim());
        updatedResources = updatedResources.filter((r: string) => !toRemove.includes(r));
      }

      await axios.put(
        `${this.apiUrl}/connector-configs/${configId}/resources`,
        { enabledResources: updatedResources },
        { headers: this.getHeaders() }
      );

      spinner.succeed(chalk.green('Resources updated successfully'));
      console.log(chalk.cyan(`\n  ${updatedResources.length} resources enabled`));
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to manage resources'));
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
