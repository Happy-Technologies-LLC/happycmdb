import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
interface PublicConfig {
  id: string;
  name: string;
  connector_type: string;
  description: string | null;
  enabled: boolean;
  schedule: string | null;
  schedule_enabled: boolean;
  enabled_resources: string[] | null;
  max_retries: number;
  retry_delay_seconds: number;
  continue_on_error: boolean;
  notification_on_success: boolean;
  notification_on_failure: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

function configRow(payload: unknown): PublicConfig {
  if (!payload || typeof payload !== 'object' || !('id' in payload) ||
      !('name' in payload) || !('connector_type' in payload) ||
      typeof payload.id !== 'string' || typeof payload.name !== 'string' ||
      typeof payload.connector_type !== 'string') {
    throw new Error('Unexpected connector response');
  }
  const row = payload as Record<string, unknown>;
  return {
    id: payload.id, name: payload.name, connector_type: payload.connector_type,
    description: typeof row['description'] === 'string' ? row['description'] : null,
    enabled: row['enabled'] === true,
    schedule: typeof row['schedule'] === 'string' ? row['schedule'] : null,
    schedule_enabled: row['schedule_enabled'] === true,
    enabled_resources: Array.isArray(row['enabled_resources']) ? row['enabled_resources'].filter((v): v is string => typeof v === 'string') : null,
    max_retries: typeof row['max_retries'] === 'number' ? row['max_retries'] : 0,
    retry_delay_seconds: typeof row['retry_delay_seconds'] === 'number' ? row['retry_delay_seconds'] : 0,
    continue_on_error: row['continue_on_error'] === true,
    notification_on_success: row['notification_on_success'] === true,
    notification_on_failure: row['notification_on_failure'] === true,
    created_at: typeof row['created_at'] === 'string' ? row['created_at'] : '',
    updated_at: typeof row['updated_at'] === 'string' ? row['updated_at'] : '',
    created_by: typeof row['created_by'] === 'string' ? row['created_by'] : null,
  };
}

function configRows(payload: unknown): PublicConfig[] {
  if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data)) {
    throw new Error('Unexpected connector response');
  }
  return payload.data.map(configRow);
}

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

  private async findConfig(name: string): Promise<PublicConfig | undefined> {
    let offset = 0;
    while (true) {
      const response = await axios.get(`${this.apiUrl}/connector-configs`, {
        params: { search: name, limit: 100, offset },
        headers: this.getHeaders(),
      });
      const rows = configRows(response.data);
      const match = rows.find(row => row.name === name);
      if (match || rows.length < 100) return match;
      offset += rows.length;
    }
  }

  /**
   * Register connector config commands
   */
  register(connector: Command): void {
    const config = connector
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
          '  happycmdb connector config create --non-interactive --type vmware-vsphere --name my-vcenter --connection <private-json>'
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

      const data: Record<string, unknown> = {
        name: options.name,
        connector_type: options.type,
        connection: connectionData,
      };

      if (options.resources) {
        data['enabled_resources'] = options.resources.split(',').map((r: string) => r.trim());
      }

      const response = await axios.post(`${this.apiUrl}/connector-configs`, data, {
        headers: this.getHeaders(),
      });

      const config = configRow(response.data.data);
      spinner.succeed(chalk.green('Configuration created successfully!'));

      console.log(chalk.cyan('\nConfiguration Details:'));
      console.log(`  ID: ${chalk.bold(config.id)}`);
      console.log(`  Name: ${chalk.bold(config.name)}`);
      console.log(`  Type: ${config.connector_type}`);
      console.log(`  Enabled: ${config.enabled ? chalk.green('Yes') : chalk.gray('No')}`);

      if (config.enabled_resources && config.enabled_resources.length > 0) {
        console.log(`  Resources: ${config.enabled_resources.length} enabled`);
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
      if (options.type) params.connector_type = options.type;
      if (options.enabled !== undefined) params.enabled = true;

      const response = await axios.get(`${this.apiUrl}/connector-configs`, {
        params,
        headers: this.getHeaders(),
      });

      const configs = configRows(response.data);
      spinner.succeed(chalk.green(`Found ${configs.length} configurations`));

      if (configs.length === 0) {
        console.log(chalk.yellow('\nNo configurations found'));
        console.log(chalk.gray('Create one with: happycmdb connector config create'));
        return;
      }

      console.log(chalk.cyan('\n╔═══════════════════════════════════════════════════════════════════════╗'));
      console.log(chalk.cyan('║') + chalk.bold('  Name                Type                  Enabled  Schedule     ') + chalk.cyan('║'));
      console.log(chalk.cyan('╠═══════════════════════════════════════════════════════════════════════╣'));

      configs.forEach(config => {
        const name = config.name.padEnd(19).substring(0, 19);
        const type = config.connector_type.padEnd(21).substring(0, 21);
        const enabled = config.enabled ? chalk.green('Yes') : chalk.gray('No ');
        const schedule = config.schedule_enabled
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
      const config = await this.findConfig(name);
      if (!config) {
        spinner.fail(chalk.red('Configuration not found'));
        return;
      }
      spinner.succeed(chalk.green('Configuration details retrieved'));
      console.log(chalk.cyan('\nConfiguration Details:'));
      console.log(`  ID: ${config.id}`);
      console.log(`  Name: ${config.name}`);
      console.log(`  Type: ${config.connector_type}`);
      console.log(`  Enabled: ${config.enabled ? 'Yes' : 'No'}`);
      if (config.description) console.log(`  Description: ${config.description}`);
      console.log(`  Schedule: ${config.schedule ?? 'None'}`);
      console.log(`  Schedule Enabled: ${config.schedule_enabled ? 'Yes' : 'No'}`);
      console.log(chalk.gray('  Connection settings: write-only'));
      console.log(`  Resources: ${config.enabled_resources?.length ?? 0} enabled`);
      console.log(`  Max Retries: ${config.max_retries}`);
      console.log(`  Retry Delay: ${config.retry_delay_seconds}s`);
      console.log(`  Continue on Error: ${config.continue_on_error ? 'Yes' : 'No'}`);
      console.log(`  Notify on Success: ${config.notification_on_success ? 'Yes' : 'No'}`);
      console.log(`  Notify on Failure: ${config.notification_on_failure ? 'Yes' : 'No'}`);
      console.log(`  Created: ${config.created_at}`);
      console.log(`  Updated: ${config.updated_at}`);
      if (config.created_by) console.log(`  Created By: ${config.created_by}`);
    } catch (error) {
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
      const config = await this.findConfig(name);
      if (!config) {
        spinner.fail(chalk.red('Configuration not found'));
        return;
      }
      const configId = config.id;
      const data: Record<string, unknown> = {};

      if (options.name) data['name'] = options.name;
      if (options.description) data['description'] = options.description;
      if (options.connection) {
        try {
          data['connection'] = JSON.parse(options.connection);
        } catch {
          spinner.fail(chalk.red('Invalid JSON in --connection'));
          return;
        }
      }
      if (options.enable) data['enabled'] = true;
      if (options.disable) data['enabled'] = false;
      if (options.schedule) data['schedule'] = options.schedule;
      if (options.scheduleEnable) data['schedule_enabled'] = true;
      if (options.scheduleDisable) data['schedule_enabled'] = false;

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
      const config = await this.findConfig(name);
      if (!config) {
        spinner.fail(chalk.red('Configuration not found'));
        return;
      }
      const configId = config.id;

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
      const config = await this.findConfig(name);
      if (!config) {
        spinner.fail(chalk.red('Configuration not found'));
        return;
      }
      const configId = config.id;

      const response = await axios.post(
        `${this.apiUrl}/connector-configs/${configId}/test`,
        {},
        { headers: this.getHeaders() }
      );

      const result = response.data;

      if (result.success === true) {
        spinner.succeed(chalk.green('Connection test successful'));
      } else {
        spinner.fail(chalk.red('Connection test failed'));
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
      const config = await this.findConfig(name);
      if (!config) {
        spinner.fail(chalk.red('Configuration not found'));
        return;
      }
      const configId = config.id;
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
      const config = await this.findConfig(name);
      if (!config) {
        spinner.fail(chalk.red('Configuration not found'));
        return;
      }
      const configId = config.id;

      if (options.list) {
        spinner.succeed(chalk.green('Enabled resources retrieved'));
        console.log(chalk.cyan('\nEnabled Resources:'));
        if (config.enabled_resources && config.enabled_resources.length > 0) {
          config.enabled_resources.forEach(resource => {
            console.log(`  - ${resource}`);
          });
        } else {
          console.log(chalk.gray('  Using default resources'));
        }
        return;
      }

      let updatedResources = [...(config.enabled_resources || [])];

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
        { enabled_resources: updatedResources },
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
  private handleError(error: unknown): void {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    const message = axios.isAxiosError(error) ? error.response?.data?.message : undefined;
    if (status === 409 && message === 'Connector credential reference unavailable') {
      console.error(chalk.red('  Connector credential reference unavailable'));
      return;
    }
    console.error(chalk.red(status === 404 ? '  Configuration not found' : '  Connector request failed'));
  }
}
