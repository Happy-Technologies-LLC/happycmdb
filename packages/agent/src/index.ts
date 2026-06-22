#!/usr/bin/env node
// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import * as os from 'os';
import * as schedule from 'node-schedule';
import { SystemInfoCollector } from './collectors/system-info.collector';
import { ProcessCollector } from './collectors/process.collector';
import { NetworkCollector } from './collectors/network.collector';
import { Reporter, ReportPayload } from './reporter';

/**
 * Agent configuration
 */
interface AgentConfig {
  _apiUrl: string;
  apiKey?: string;
  agentId?: string;
  collectInterval?: string; // Cron format: '*/5 * * * *' for every 5 minutes
  collectSystemInfo?: boolean;
  collectProcesses?: boolean;
  collectNetwork?: boolean;
  maxProcesses?: number;
}

/**
 * CMDB Discovery Agent
 * Lightweight agent for collecting system information and reporting to API server
 */
class CMDBAgent {
  private config: Required<AgentConfig>;
  private reporter: Reporter;
  private systemInfoCollector: SystemInfoCollector;
  private processCollector: ProcessCollector;
  private networkCollector: NetworkCollector;
  private scheduledJob?: schedule.Job;

  constructor(config: AgentConfig) {
    this.config = {
      _apiUrl: config._apiUrl,
      apiKey: config.apiKey || '',
      agentId: config.agentId || this.generateAgentId(),
      collectInterval: config.collectInterval || '*/5 * * * *', // Default: every 5 minutes
      collectSystemInfo: config.collectSystemInfo ?? true,
      collectProcesses: config.collectProcesses ?? true,
      collectNetwork: config.collectNetwork ?? true,
      maxProcesses: config.maxProcesses || 100,
    };

    this.reporter = new Reporter({
      _apiUrl: this.config._apiUrl,
      apiKey: this.config.apiKey,
    });

    this.systemInfoCollector = new SystemInfoCollector();
    this.processCollector = new ProcessCollector(this.config.maxProcesses);
    this.networkCollector = new NetworkCollector();
  }

  /**
   * Generate unique agent ID based on hostname and MAC address
   */
  private generateAgentId(): string {
    const hostname = os.hostname();
    const interfaces = os.networkInterfaces();

    // Find first non-internal MAC address
    let mac = '';
    for (const addresses of Object.values(interfaces)) {
      if (!addresses) continue;
      const nonInternal = addresses.find(addr => !addr.internal && addr.mac !== '00:00:00:00:00:00');
      if (nonInternal) {
        mac = nonInternal.mac;
        break;
      }
    }

    return `${hostname}-${mac}`.replace(/:/g, '');
  }

  /**
   * Collect all enabled data types
   */
  async collectData(): Promise<ReportPayload['_data']> {
    const data: ReportPayload['_data'] = {};

    try {
      if (this.config.collectSystemInfo) {
        console.log('Collecting system information...');
        data.systemInfo = await this.systemInfoCollector.collect();
      }

      if (this.config.collectProcesses) {
        console.log('Collecting process information...');
        data.processes = await this.processCollector.collect();
      }

      if (this.config.collectNetwork) {
        console.log('Collecting network information...');
        data.network = await this.networkCollector.collect();
      }
    } catch (error) {
      console.error('Error during data collection:', error);
    }

    return data;
  }

  /**
   * Execute collection and reporting cycle
   */
  async execute(): Promise<boolean> {
    console.log(`[${new Date().toISOString()}] Starting collection cycle...`);

    try {
      const data = await this.collectData();

      const payload: ReportPayload = {
        agentId: this.config.agentId,
        _hostname: os.hostname(),
        _timestamp: new Date(),
        _data: data,
      };

      console.log('Sending report to API server...');
      const success = await this.reporter.send(payload);

      if (success) {
        console.log('Collection cycle completed successfully');
      } else {
        console.error('Collection cycle failed - report not sent');
      }

      return success;
    } catch (error) {
      console.error('Error during collection cycle:', error);
      return false;
    }
  }

  /**
   * Start scheduled collection
   */
  start(): void {
    console.log('CMDB Discovery Agent starting...');
    console.log(`Agent ID: ${this.config.agentId}`);
    console.log(`API URL: ${this.config._apiUrl}`);
    console.log(`Collection interval: ${this.config.collectInterval}`);

    // Run immediately on start
    this.execute().catch(error => {
      console.error('Initial collection failed:', error);
    });

    // Schedule periodic collection
    this.scheduledJob = schedule.scheduleJob(this.config.collectInterval, () => {
      this.execute().catch(error => {
        console.error('Scheduled collection failed:', error);
      });
    });

    console.log('Agent started successfully');
  }

  /**
   * Stop scheduled collection
   */
  stop(): void {
    console.log('Stopping agent...');

    if (this.scheduledJob) {
      this.scheduledJob.cancel();
      this.scheduledJob = undefined;
    }

    console.log('Agent stopped');
  }

  /**
   * Run once and exit
   */
  async runOnce(): Promise<void> {
    console.log('Running one-time collection...');
    await this.execute();
    console.log('One-time collection complete');
  }
}

/**
 * Main entry point
 */
async function main() {
  // Load configuration from environment variables or config file
  const config: AgentConfig = {
    _apiUrl: process.env['CMDB_API_URL'] || 'http://localhost:3000/api/agent/report',
    apiKey: process.env['CMDB_API_KEY'],
    agentId: process.env['CMDB_AGENT_ID'],
    collectInterval: process.env['CMDB_COLLECT_INTERVAL'] || '*/5 * * * *',
    collectSystemInfo: process.env['CMDB_COLLECT_SYSTEM'] !== 'false',
    collectProcesses: process.env['CMDB_COLLECT_PROCESSES'] !== 'false',
    collectNetwork: process.env['CMDB_COLLECT_NETWORK'] !== 'false',
  };

  const agent = new CMDBAgent(config);

  // Handle command line arguments
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'once') {
    // Run once and exit
    await agent.runOnce();
    process.exit(0);
  } else {
    // Start scheduled collection
    agent.start();

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\nReceived SIGINT, shutting down gracefully...');
      agent.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\nReceived SIGTERM, shutting down gracefully...');
      agent.stop();
      process.exit(0);
    });
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { CMDBAgent };
export type { AgentConfig };
