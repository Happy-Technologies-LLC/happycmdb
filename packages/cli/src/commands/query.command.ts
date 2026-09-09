import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';

/**
 * Query command handlers for advanced CMDB queries
 */
export class QueryCommand {
  private apiUrl: string;
  private apiKey?: string;

  constructor(apiUrl: string, apiKey?: string) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }

  /**
   * Register query commands
   */
  register(program: Command): void {
    const query = program
      .command('query')
      .alias('q')
      .description('Execute advanced queries on CMDB data');

    // Execute raw query
    query
      .command('exec <queryString>')
      .description('Execute a query using CMDB query language')
      .option('--format <format>', 'Output format: json, table, csv', 'table')
      .option('--limit <limit>', 'Limit number of results', '50')
      .action(async (queryString, options) => {
        await this.executeQuery(queryString, options);
      });

    // Find CIs by attributes
    query
      .command('find')
      .description('Find CIs matching specific attributes')
      .option('-t, --type <type>', 'CI type filter')
      .option('-a, --attribute <attr=value>', 'Attribute filter (can be used multiple times)', this.collectAttributes, [])
      .option('--operator <operator>', 'Logical operator for multiple attributes: AND, OR', 'AND')
      .option('--limit <limit>', 'Limit number of results', '50')
      .action(async (options) => {
        await this.findByAttributes(options);
      });

    // Dependency chain query
    query
      .command('dependencies <ciId>')
      .description('Get full dependency chain for a CI')
      .option('--depth <depth>', 'Maximum depth to traverse', '5')
      .option('--direction <direction>', 'Direction: upstream, downstream, both', 'both')
      .option('--type <type>', 'Filter by relationship type')
      .action(async (ciId, options) => {
        await this.getDependencies(ciId, options);
      });

    // Impact analysis
    query
      .command('impact <ciId>')
      .description('Analyze impact if CI fails or changes')
      .option('--depth <depth>', 'Maximum depth to analyze', '5')
      .option('--format <format>', 'Output format: json, tree', 'tree')
      .action(async (ciId, options) => {
        await this.impactAnalysis(ciId, options);
      });

    // Topology query
    query
      .command('topology')
      .description('Query infrastructure topology')
      .option('--root <ciId>', 'Root CI to start from')
      .option('--type <type>', 'Filter by CI type')
      .option('--depth <depth>', 'Maximum depth', '3')
      .action(async (options) => {
        await this.getTopology(options);
      });

    // Saved queries
    query
      .command('list-saved')
      .description('List saved queries')
      .action(async () => {
        await this.listSavedQueries();
      });

    query
      .command('save <name> <queryString>')
      .description('Save a query for later use')
      .option('-d, --description <description>', 'Query description')
      .action(async (name, queryString, options) => {
        await this.saveQuery(name, queryString, options);
      });

    query
      .command('run-saved <name>')
      .description('Execute a saved query')
      .option('--format <format>', 'Output format: json, table, csv', 'table')
      .action(async (name, options) => {
        await this.runSavedQuery(name, options);
      });
  }

  /**
   * Execute a query
   */
  private async executeQuery(queryString: string, options: any): Promise<void> {
    const spinner = ora('Executing query...').start();

    try {
      const response = await axios.post(
        `${this.apiUrl}/query/execute`,
        {
          _query: queryString,
          _limit: options.limit,
        },
        {
          headers: this.getHeaders(),
        }
      );

      spinner.succeed(chalk.green(`Query executed: ${response.data.length} results`));

      this.formatOutput(response.data, options.format);
    } catch (error: any) {
      spinner.fail(chalk.red('Query execution failed'));
      this.handleError(error);
    }
  }

  /**
   * Find CIs by attributes
   */
  private async findByAttributes(options: any): Promise<void> {
    const spinner = ora('Searching CIs...').start();

    try {
      const filters: any = {};

      if (options.type) {
        filters.type = options.type;
      }

      if (options.attribute && options.attribute.length > 0) {
        filters.attributes = options.attribute.reduce((acc: any, attr: string) => {
          const [key, value] = attr.split('=');
          if (key) {
            acc[key] = value;
          }
          return acc;
        }, {});
        filters.operator = options.operator;
      }

      const response = await axios.post(
        `${this.apiUrl}/query/find`,
        {
          filters,
          _limit: options.limit,
        },
        {
          headers: this.getHeaders(),
        }
      );

      spinner.succeed(chalk.green(`Found ${response.data.length} matching CIs`));

      if (response.data.length === 0) {
        console.log(chalk.yellow('\nNo CIs found matching criteria'));
        return;
      }

      console.log(chalk.cyan('\nMatching CIs:'));
      response.data.forEach((ci: any) => {
        console.log(`\n  ${chalk.bold(ci.name)} (${ci.id})`);
        console.log(`    Type: ${ci.type}`);
        console.log(`    Status: ${ci.status}`);
      });
    } catch (error: any) {
      spinner.fail(chalk.red('Search failed'));
      this.handleError(error);
    }
  }

  /**
   * Get dependency chain
   */
  private async getDependencies(ciId: string, options: any): Promise<void> {
    const spinner = ora('Analyzing dependencies...').start();

    try {
      const response = await axios.get(
        `${this.apiUrl}/cis/${ciId}/dependencies`,
        {
          params: { depth: options.depth },
          headers: this.getHeaders(),
        }
      );

      spinner.succeed(chalk.green('Dependency analysis complete'));

      this.printDependencyTree(response.data);
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to analyze dependencies'));
      this.handleError(error);
    }
  }

  /**
   * Impact analysis
   */
  private async impactAnalysis(ciId: string, options: any): Promise<void> {
    const spinner = ora('Analyzing impact...').start();

    try {
      const response = await axios.get(
        `${this.apiUrl}/cis/${ciId}/impact`,
        {
          params: { depth: options.depth },
          headers: this.getHeaders(),
        }
      );

      spinner.succeed(chalk.green('Impact analysis complete'));

      if (options.format === 'json') {
        console.log(JSON.stringify(response.data, null, 2));
      } else {
        this.printImpactTree(response.data);
      }
    } catch (error: any) {
      spinner.fail(chalk.red('Impact analysis failed'));
      this.handleError(error);
    }
  }

  /**
   * Get topology
   */
  private async getTopology(options: any): Promise<void> {
    const spinner = ora('Fetching topology...').start();

    try {
      const params: any = {
        _depth: options.depth,
      };

      if (options.root) params.root = options.root;
      if (options.type) params.type = options.type;

      const response = await axios.get(`${this.apiUrl}/query/topology`, {
        params,
        headers: this.getHeaders(),
      });

      spinner.succeed(chalk.green('Topology retrieved'));

      console.log(chalk.cyan('\nInfrastructure Topology:'));
      console.log(`  Total CIs: ${response.data.nodes?.length || 0}`);
      console.log(`  Total Relationships: ${response.data.edges?.length || 0}`);

      if (response.data.nodes && response.data.nodes.length > 0) {
        console.log(chalk.cyan('\nNodes by Type:'));
        const typeCount = response.data.nodes.reduce((acc: any, node: any) => {
          acc[node.type] = (acc[node.type] || 0) + 1;
          return acc;
        }, {});

        Object.entries(typeCount).forEach(([type, count]) => {
          console.log(`    ${type}: ${count}`);
        });
      }
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch topology'));
      this.handleError(error);
    }
  }

  /**
   * List saved queries
   */
  private async listSavedQueries(): Promise<void> {
    const spinner = ora('Fetching saved queries...').start();

    try {
      const response = await axios.get(`${this.apiUrl}/query/saved`, {
        headers: this.getHeaders(),
      });

      spinner.succeed(chalk.green(`Found ${response.data.length} saved queries`));

      if (response.data.length === 0) {
        console.log(chalk.yellow('\nNo saved queries'));
        return;
      }

      console.log(chalk.cyan('\nSaved Queries:'));
      response.data.forEach((query: any) => {
        console.log(`\n  ${chalk.bold(query.name)}`);
        if (query.description) {
          console.log(`    Description: ${query.description}`);
        }
        console.log(`    Created: ${new Date(query.createdAt).toLocaleString()}`);
      });
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to fetch saved queries'));
      this.handleError(error);
    }
  }

  /**
   * Save a query
   */
  private async saveQuery(name: string, queryString: string, options: any): Promise<void> {
    const spinner = ora('Saving query...').start();

    try {
      await axios.post(
        `${this.apiUrl}/query/saved`,
        {
          name,
          _query: queryString,
          _description: options.description,
        },
        {
          headers: this.getHeaders(),
        }
      );

      spinner.succeed(chalk.green(`Query "${name}" saved successfully`));
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to save query'));
      this.handleError(error);
    }
  }

  /**
   * Run a saved query
   */
  private async runSavedQuery(name: string, options: any): Promise<void> {
    const spinner = ora('Executing saved query...').start();

    try {
      const response = await axios.get(
        `${this.apiUrl}/query/saved/${name}/execute`,
        {
          headers: this.getHeaders(),
        }
      );

      spinner.succeed(chalk.green(`Query executed: ${response.data.length} results`));

      this.formatOutput(response.data, options.format);
    } catch (error: any) {
      spinner.fail(chalk.red('Failed to execute saved query'));
      this.handleError(error);
    }
  }

  /**
   * Collect attributes from multiple --attribute flags
   */
  private collectAttributes(value: string, previous: string[]): string[] {
    return previous.concat([value]);
  }

  /**
   * Format output based on format option
   */
  private formatOutput(data: any[], format: string): void {
    if (format === 'json') {
      console.log(JSON.stringify(data, null, 2));
    } else if (format === 'csv') {
      if (data.length === 0) return;
      const keys = Object.keys(data[0]);
      console.log(keys.join(','));
      data.forEach(row => {
        console.log(keys.map(key => row[key]).join(','));
      });
    } else {
      // Table format
      if (data.length === 0) {
        console.log(chalk.yellow('\nNo results'));
        return;
      }

      console.log(chalk.cyan('\nResults:'));
      data.forEach(item => {
        console.log(`\n  ${chalk.bold(item.name || item.id)}`);
        Object.entries(item).forEach(([key, value]) => {
          if (key !== 'name' && key !== 'id') {
            console.log(`    ${key}: ${value}`);
          }
        });
      });
    }
  }

  /**
   * Print dependency tree
   */
  private printDependencyTree(data: any, prefix: string = ''): void {
    if (!data) return;

    console.log(chalk.cyan('\nDependency Tree:'));
    this.printTreeNode(data, prefix);
  }

  /**
   * Print tree node recursively
   */
  private printTreeNode(node: any, prefix: string = ''): void {
    console.log(`${prefix}${chalk.bold(node.name || node.id)} [${node.type}]`);

    if (node.children && node.children.length > 0) {
      node.children.forEach((child: any, index: number) => {
        const isLast = index === node.children.length - 1;
        const childPrefix = prefix + (isLast ? '  └─ ' : '  ├─ ');
        const nextPrefix = prefix + (isLast ? '     ' : '  │  ');
        console.log(`${childPrefix}${child.relationship}`);
        this.printTreeNode(child, nextPrefix);
      });
    }
  }

  /**
   * Print impact tree
   */
  private printImpactTree(data: any): void {
    console.log(chalk.cyan('\nImpact Analysis:'));
    console.log(`  Root CI: ${chalk.bold(data.root.name)}`);
    console.log(`  Total Affected CIs: ${chalk.bold(data.affectedCount)}`);

    if (data.critical && data.critical.length > 0) {
      console.log(chalk.red('\n  Critical Dependencies:'));
      data.critical.forEach((ci: any) => {
        console.log(`    - ${ci.name} [${ci.type}]`);
      });
    }

    if (data.affected && data.affected.length > 0) {
      console.log(chalk.yellow('\n  Affected CIs:'));
      data.affected.forEach((ci: any) => {
        console.log(`    - ${ci.name} [${ci.type}]`);
      });
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
