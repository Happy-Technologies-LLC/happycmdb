import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';

/**
 * CI (Configuration Item) command handlers
 */
export class CICommand {
  private apiUrl: string;
  private apiKey?: string;

  constructor(apiUrl: string, apiKey?: string) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }

  /**
   * Register CI commands
   */
  register(program: Command): void {
    const ci = program
      .command('ci')
      .description('Manage Configuration Items (CIs)');

    // List CIs
    ci.command('list')
      .description('List configuration items')
      .option('-t, --type <type>', 'Filter by CI type (server, database, application, etc.)')
      .option('-s, --status <status>', 'Filter by status (active, inactive, maintenance)')
      .option('--limit <limit>', 'Limit number of results', '20')
      .option('--offset <offset>', 'Offset for pagination', '0')
      .action(async (options) => {
        await this.listCIs(options);
      });

    // Get CI details
    ci.command('get <ciId>')
      .description('Get details of a specific CI')
      .option('--relationships', 'Include CI relationships')
      .action(async (ciId, options) => {
        await this.getCIDetails(ciId, options);
      });

    // Create CI
    ci.command('create')
      .description('Create a new CI')
      .requiredOption('-i, --id <id>', 'Unique CI identifier')
      .requiredOption('-t, --type <type>', 'CI type (server, database, application, etc.)')
      .requiredOption('-n, --name <name>', 'CI name')
      .option('-s, --status <status>', 'CI status (active, inactive, maintenance)')
      .option('-e, --environment <environment>', 'CI environment (production, staging, development)')
      .option('-d, --description <description>', 'CI description')
      .option('--attributes <json>', 'CI metadata as JSON string')
      .action(async (options) => {
        await this.createCI(options);
      });

    // Update CI
    ci.command('update <ciId>')
      .description('Update an existing CI')
      .option('-n, --name <name>', 'New CI name')
      .option('-d, --description <description>', 'New description')
      .option('-s, --status <status>', 'New status')
      .option('--attributes <json>', 'Updated attributes as JSON string')
      .action(async (ciId, options) => {
        await this.updateCI(ciId, options);
      });

    // Delete CI
    ci.command('delete <ciId>')
      .description('Delete a CI')
      .option('-f, --force', 'Force deletion without confirmation')
      .action(async (ciId, options) => {
        await this.deleteCI(ciId, options);
      });

    // Add relationship
    ci.command('relate')
      .description('Create a relationship between two CIs')
      .requiredOption('--from <ciId>', 'Source CI ID')
      .requiredOption('--to <ciId>', 'Target CI ID')
      .requiredOption('--type <type>', 'Relationship type (depends_on, connects_to, runs_on, etc.)')
      .action(async (options) => {
        await this.createRelationship(options);
      });

    // List relationships
    ci.command('relationships <ciId>')
      .description('List all relationships for a CI')
      .option('--direction <direction>', 'Filter by direction: inbound, outbound, both', 'both')
      .action(async (ciId, options) => {
        await this.listRelationships(ciId, options);
      });

    // Search CIs
    ci.command('search <query>')
      .description('Search for CIs by name or attributes')
      .option('-t, --type <type>', 'Filter by CI type')
      .option('--limit <limit>', 'Limit number of results', '20')
      .action(async (query, options) => {
        await this.searchCIs(query, options);
      });
  }

  /**
   * List CIs
   */
  private async listCIs(options: any): Promise<void> {
    const spinner = ora('Fetching CIs...').start();

    try {
      const params: any = {
        _limit: options.limit,
        _offset: options.offset,
      };

      if (options.type) params.type = options.type;
      if (options.status) params.status = options.status;

      const response = await axios.get(`${this.apiUrl}/cis`, {
        params,
        headers: this.getHeaders(),
      });

      spinner.succeed(chalk.green(`Found ${response.data.total} CIs`));

      if (response.data.items.length === 0) {
        console.log(chalk.yellow('\nNo CIs found'));
        return;
      }

      console.log(chalk.cyan('\nConfiguration Items:'));
      response.data.items.forEach((ci: any) => {
        console.log(`\n  ${chalk.bold(ci.name)} (${ci.id})`);
        console.log(`    Type: ${ci.type}`);
        console.log(`    Status: ${this.colorizeStatus(ci.status)}`);
        if (ci.description) {
          console.log(`    Description: ${ci.description}`);
        }
      });

      if (response.data.total > response.data.items.length) {
        const remaining = response.data.total - (parseInt(options.offset) + response.data.items.length);
        console.log(chalk.gray(`\n  ... and ${remaining} more`));
      }
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch CIs'));
      this.handleError(error);
    }
  }

  /**
   * Get CI details
   */
  private async getCIDetails(ciId: string, options: any): Promise<void> {
    const spinner = ora('Fetching CI details...').start();

    try {
      const params: any = {};
      if (options.relationships) params.includeRelationships = true;

      const response = await axios.get(`${this.apiUrl}/cis/${ciId}`, {
        params,
        headers: this.getHeaders(),
      });

      spinner.succeed(chalk.green('CI details retrieved'));

      const ci = response.data;
      console.log(chalk.cyan('\nCI Details:'));
      console.log(`  ID: ${chalk.bold(ci.id)}`);
      console.log(`  Name: ${chalk.bold(ci.name)}`);
      console.log(`  Type: ${ci.type}`);
      console.log(`  Status: ${this.colorizeStatus(ci.status)}`);

      if (ci.description) {
        console.log(`  Description: ${ci.description}`);
      }

      if (ci.attributes && Object.keys(ci.attributes).length > 0) {
        console.log(chalk.cyan('\n  Attributes:'));
        Object.entries(ci.attributes).forEach(([key, value]) => {
          console.log(`    ${key}: ${value}`);
        });
      }

      if (options.relationships && ci.relationships) {
        console.log(chalk.cyan('\n  Relationships:'));
        console.log(`    Inbound: ${ci.relationships.inbound?.length || 0}`);
        console.log(`    Outbound: ${ci.relationships.outbound?.length || 0}`);
      }

      console.log(`\n  Created: ${new Date(ci.createdAt).toLocaleString()}`);
      console.log(`  Updated: ${new Date(ci.updatedAt).toLocaleString()}`);
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch CI details'));
      this.handleError(error);
    }
  }

  /**
   * Create CI
   */
  private async createCI(options: any): Promise<void> {
    const spinner = ora('Creating CI...').start();

    try {
      const data: any = {
        id: options.id,
        name: options.name,
        type: options.type,
      };

      if (options.status) data.status = options.status;
      if (options.environment) data.environment = options.environment;

      const metadata: Record<string, any> = {};
      if (options.attributes) {
        try {
          Object.assign(metadata, JSON.parse(options.attributes));
        } catch {
          spinner.fail(chalk.red('Invalid JSON in --attributes'));
          return;
        }
      }
      if (options.description) metadata.description = options.description;
      if (Object.keys(metadata).length > 0) data.metadata = metadata;

      const response = await axios.post(`${this.apiUrl}/cis`, data, {
        headers: this.getHeaders(),
      });

      spinner.succeed(chalk.green('CI created successfully'));
      console.log(chalk.cyan('\nCI Details:'));
      console.log(`  ID: ${chalk.bold(response.data.id)}`);
      console.log(`  Name: ${response.data.name}`);
      console.log(`  Type: ${response.data.type}`);
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to create CI'));
      this.handleError(error);
    }
  }

  /**
   * Update CI
   */
  private async updateCI(ciId: string, options: any): Promise<void> {
    const spinner = ora('Updating CI...').start();

    try {
      const data: any = {};

      if (options.name) data.name = options.name;
      if (options.description) data.description = options.description;
      if (options.status) data.status = options.status;
      if (options.attributes) {
        try {
          data.attributes = JSON.parse(options.attributes);
        } catch {
          spinner.fail(chalk.red('Invalid JSON in --attributes'));
          return;
        }
      }

      if (Object.keys(data).length === 0) {
        spinner.fail(chalk.red('No updates specified'));
        return;
      }

      await axios.put(`${this.apiUrl}/cis/${ciId}`, data, {
        headers: this.getHeaders(),
      });

      spinner.succeed(chalk.green('CI updated successfully'));
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to update CI'));
      this.handleError(error);
    }
  }

  /**
   * Delete CI
   */
  private async deleteCI(ciId: string, options: any): Promise<void> {
    if (!options.force) {
      console.log(chalk.yellow('Warning: This will permanently delete the CI'));
      console.log(chalk.yellow('Use --force to confirm deletion'));
      return;
    }

    const spinner = ora('Deleting CI...').start();

    try {
      await axios.delete(`${this.apiUrl}/cis/${ciId}`, {
        headers: this.getHeaders(),
      });

      spinner.succeed(chalk.green('CI deleted successfully'));
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to delete CI'));
      this.handleError(error);
    }
  }

  /**
   * Create relationship
   */
  private async createRelationship(options: any): Promise<void> {
    const spinner = ora('Creating relationship...').start();

    try {
      const data = {
        from_id: options.from,
        to_id: options.to,
        type: options.type,
      };

      const response = await axios.post(`${this.apiUrl}/relationships`, data, {
        headers: this.getHeaders(),
      });

      spinner.succeed(chalk.green('Relationship created successfully'));
      console.log(chalk.cyan('\nRelationship Details:'));
      console.log(`  ID: ${chalk.bold(response.data.id)}`);
      console.log(`  From: ${options.from}`);
      console.log(`  To: ${options.to}`);
      console.log(`  Type: ${options.type}`);
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to create relationship'));
      this.handleError(error);
    }
  }

  /**
   * List relationships
   */
  private async listRelationships(ciId: string, options: any): Promise<void> {
    const spinner = ora('Fetching relationships...').start();

    try {
      const response = await axios.get(`${this.apiUrl}/cis/${ciId}/relationships`, {
        params: { direction: options.direction },
        headers: this.getHeaders(),
      });

      spinner.succeed(chalk.green('Relationships retrieved'));

      const { inbound, outbound } = response.data;

      if (options.direction !== 'outbound' && inbound?.length > 0) {
        console.log(chalk.cyan('\nInbound Relationships:'));
        inbound.forEach((rel: any) => {
          console.log(`  ${rel.fromCi.name} --[${rel.type}]--> ${ciId}`);
        });
      }

      if (options.direction !== 'inbound' && outbound?.length > 0) {
        console.log(chalk.cyan('\nOutbound Relationships:'));
        outbound.forEach((rel: any) => {
          console.log(`  ${ciId} --[${rel.type}]--> ${rel.toCi.name}`);
        });
      }

      if ((!inbound || inbound.length === 0) && (!outbound || outbound.length === 0)) {
        console.log(chalk.yellow('\nNo relationships found'));
      }
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch relationships'));
      this.handleError(error);
    }
  }

  /**
   * Search CIs
   */
  private async searchCIs(query: string, options: any): Promise<void> {
    const spinner = ora('Searching CIs...').start();

    try {
      const response = await axios.post(
        `${this.apiUrl}/cis/search`,
        { query, limit: parseInt(options.limit, 10) },
        {
          headers: this.getHeaders(),
        }
      );

      spinner.succeed(chalk.green(`Found ${response.data.length} matching CIs`));

      if (response.data.length === 0) {
        console.log(chalk.yellow('\nNo CIs found matching your search'));
        return;
      }

      console.log(chalk.cyan('\nSearch Results:'));
      response.data.forEach((ci: any) => {
        console.log(`\n  ${chalk.bold(ci.name)} (${ci.id})`);
        console.log(`    Type: ${ci.type}`);
        console.log(`    Status: ${this.colorizeStatus(ci.status)}`);
      });
    } catch (error: any) {
      spinner.fail(chalk.red('Search failed'));
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
      case 'active':
        return chalk.green(status);
      case 'inactive':
        return chalk.gray(status);
      case 'maintenance':
        return chalk.yellow(status);
      case 'failed':
        return chalk.red(status);
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
