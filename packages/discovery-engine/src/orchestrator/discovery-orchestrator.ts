// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/discovery-engine/src/orchestrator/discovery-orchestrator.ts

import { queueManager, QUEUE_NAMES, getPostgresClient, getUnifiedCredentialService } from '@cmdb/database';
import { logger, resolveDiscoveryHost, DISCOVERY_TARGET_REFUSED } from '@cmdb/common';
import { DiscoveredCI, DiscoveryJob } from '@cmdb/common';
import { SSHDiscoveryWorker } from '../workers/ssh-discovery.worker';
import { NmapDiscoveryWorker } from '../workers/nmap-discovery.worker';
import { ActiveDirectoryDiscoveryWorker } from '../workers/active-directory-discovery.worker';
import { getInternalAPIClient } from '../api/internal-api-client';
import { ITILEnricher } from '../enrichment/itil-enricher';
import { TBMEnricher } from '../enrichment/tbm-enricher';
import { BSMEnricher } from '../enrichment/bsm-enricher';
// AI Discovery Integration (Phase 1-3)
import {
  HybridDiscoveryOrchestrator,
  PatternStorageService,
  getDefaultLLMConfig,
} from '@cmdb/ai-discovery';
// Fixed AI discovery failure codes; never publish model or remote error text to BullMQ.
const TERMINAL_AI_DISCOVERY_ERRORS = new Set([
  DISCOVERY_TARGET_REFUSED, 'UNSUPPORTED_PATTERN_PLAN',
  'PATTERN_NOT_ACTIVE', 'PATTERN_STATE_UNAVAILABLE',
]);

export class DiscoveryOrchestrator {
  private apiClient = getInternalAPIClient();
  private postgresClient = getPostgresClient();
  private credentialService = getUnifiedCredentialService(getPostgresClient().pool);
  private itilEnricher = new ITILEnricher();
  private tbmEnricher = new TBMEnricher();
  private bsmEnricher = new BSMEnricher();
  private workersRegistered = false;
  // AI Discovery (Phase 1-3)
  private hybridOrchestrator: HybridDiscoveryOrchestrator | null = null;
  private patternStorage: PatternStorageService | null = null;

  /**
   * Start the discovery orchestrator (registers workers)
   */
  async start(): Promise<void> {
    if (!this.workersRegistered) {
      // Initialize AI discovery if enabled
      this.initializeAIDiscovery();

      this.registerWorkers();
      this.workersRegistered = true;
      logger.info('Discovery orchestrator started');
    }
  }

  /**
   * Initialize AI Discovery components (Phase 1-3)
   */
  private initializeAIDiscovery(): void {
    const aiEnabled = process.env.AI_DISCOVERY_ENABLED === 'true';

    if (!aiEnabled) {
      logger.info('AI Discovery is disabled');
      return;
    }

    try {
      // Initialize pattern storage
      this.patternStorage = new PatternStorageService();

      // Warm up cache with active patterns for better performance
      this.patternStorage.warmupCache().catch((err: Error) => {
        logger.warn('Cache warmup failed (non-critical)', { error: err });
      });

      // Initialize hybrid orchestrator with config from environment
      const llmConfig = getDefaultLLMConfig();
      const hybridConfig = {
        aiEnabled: process.env.AI_DISCOVERY_ENABLED === 'true',
        patternMatchingEnabled: process.env.AI_HYBRID_DISCOVERY_ENABLED !== 'false',
        monthlyBudget: parseFloat(process.env.AI_DISCOVERY_MONTHLY_BUDGET || '100'),
        maxCostPerSession: parseFloat(process.env.AI_DISCOVERY_MAX_COST_PER_SESSION || '0.50'),
        llmConfig,
      };

      this.hybridOrchestrator = new HybridDiscoveryOrchestrator(hybridConfig);

      logger.info('AI Discovery initialized', {
        provider: llmConfig.provider,
        model: llmConfig.model,
        patternMatching: hybridConfig.patternMatchingEnabled,
        monthlyBudget: hybridConfig.monthlyBudget,
      });
    } catch (error) {
      logger.error('Failed to initialize AI Discovery', { error });
      logger.warn('AI Discovery will be disabled');
      this.hybridOrchestrator = null;
      this.patternStorage = null;
    }
  }

  /**
   * Stop the discovery orchestrator
   */
  async stop(): Promise<void> {
    // Workers are managed by queue manager, nothing to do here
    this.workersRegistered = false;
    logger.info('Discovery orchestrator stopped');
  }

  /**
   * Trigger an immediate discovery job
   */
  async triggerDiscovery(
    provider: string,
    config: any,
    _triggeredBy: string
  ): Promise<string> {
    const jobId = `${provider}-${Date.now()}`;
    await this.scheduleDiscovery({
      id: jobId,
      provider: provider as any,
      method: 'agentless',
      status: 'pending',
      config,
      created_at: new Date().toISOString(),
    });
    return jobId;
  }

  /**
   * Trigger discovery from a saved definition
   * Loads the definition, decrypts credentials, and triggers discovery
   */
  async triggerDiscoveryFromDefinition(
    definitionId: string,
    triggeredBy: string
  ): Promise<string> {
    const client = await this.postgresClient.getClient();

    try {
      await client.query('BEGIN');

      // Load the definition
      const definitionResult = await client.query(
        `SELECT
          id,
          name, provider, method, credential_id, config, is_active
        FROM discovery_definitions
        WHERE id = $1`,
        [definitionId]
      );

      if (definitionResult.rows.length === 0) {
        throw new Error(`Discovery definition ${definitionId} not found`);
      }

      const definition = definitionResult.rows[0];

      if (!definition.is_active) {
        throw new Error(`Discovery definition ${definitionId} is not active`);
      }

      // Load and decrypt credentials using unified credential service
      const credential = await this.credentialService.getById(definition.credential_id);

      if (!credential) {
        throw new Error(
          `Credential ${definition.credential_id} not found or inactive`
        );
      }

      logger.info('Loaded credential for discovery', {
        credentialId: definition.credential_id,
        protocol: credential.protocol,
        scope: credential.scope,
        hasCredentials: !!credential.credentials,
        credentialKeys: credential.credentials ? Object.keys(credential.credentials) : []
      });

      // Merge definition config with credentials
      const discoveryConfig = {
        ...(typeof definition.config === 'string'
          ? JSON.parse(definition.config)
          : definition.config),
        credentials: credential.credentials,
      };

      // Generate job ID
      const jobId = `${definition.provider}-${Date.now()}`;

      // Create discovery run record (commented out - table doesn't exist yet)
      // await client.query(
      //   `INSERT INTO cmdb.discovery_runs (
      //     definition_id, job_id, status, triggered_by, trigger_type
      //   ) VALUES ($1, $2, $3, $4, $5)`,
      //   [definitionId, jobId, 'pending', triggeredBy, 'manual']
      // );

      // Update definition last run info
      await client.query(
        `UPDATE discovery_definitions
        SET last_run_at = CURRENT_TIMESTAMP,
            last_run_status = 'pending',
            last_job_id = $1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2`,
        [jobId, definitionId]
      );

      await client.query('COMMIT');

      // Trigger the actual discovery job
      await this.scheduleDiscovery({
        id: jobId,
        provider: definition.provider as any,
        method: definition.method as any,
        status: 'pending',
        config: discoveryConfig,
        created_at: new Date().toISOString(),
      });

      logger.info('Discovery triggered from definition', {
        definitionId,
        definitionName: definition.name,
        jobId,
        provider: definition.provider,
        triggeredBy,
      });

      return jobId;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error triggering discovery from definition', {
        definitionId,
        error,
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Decrypt credentials
   * TODO: Replace with proper encryption service
   */
  private decryptCredentials(encryptedData: Buffer, keyId: string): any {
    try {
      // PLACEHOLDER: In production, use a proper encryption service
      // This is a simplified implementation for demonstration
      // Real implementation should:
      // 1. Retrieve encryption key from key management service (AWS KMS, Azure Key Vault, etc.)
      // 2. Decrypt the data using the retrieved key
      // 3. Parse and return the credentials

      // For now, assume the data is base64-encoded JSON
      const decrypted = Buffer.from(encryptedData).toString('utf-8');
      return JSON.parse(decrypted);
    } catch (error) {
      logger.error('Error decrypting credentials', { keyId, error });
      throw new Error('Failed to decrypt credentials');
    }
  }

  /**
   * Get all worker statuses
   */
  async getAllWorkerStatuses(): Promise<any[]> {
    // Return status for infrastructure protocol discovery workers only
    // Cloud provider discovery (AWS, Azure, GCP) is handled by connector framework in v2.0
    const workers = [
      { name: QUEUE_NAMES._DISCOVERY_SSH, running: this.workersRegistered, concurrency: 5 },
      { name: QUEUE_NAMES._DISCOVERY_NMAP, running: this.workersRegistered, concurrency: 3 },
      { name: 'discovery-active-directory', running: this.workersRegistered, concurrency: 2 },
    ];

    // Add AI discovery worker if initialized (Phase 1-3)
    if (this.hybridOrchestrator) {
      workers.push({
        name: 'discovery-ai',
        running: this.workersRegistered,
        concurrency: 2,
      } as any);
    }

    return workers;
  }

  async scheduleDiscovery(job: DiscoveryJob): Promise<void> {
    const queueName = this.getQueueName(job.provider);
    const queue = queueManager.getQueue(queueName);

    await queue.add(
      'discovery',
      {
        jobId: job.id,
        provider: job.provider,
        config: job.config,
      },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      }
    );

    // Log without sensitive credentials
    const sanitizedJob = {
      id: job.id,
      provider: job.provider,
      method: job.method,
      status: job.status,
      created_at: job.created_at,
      config: this.sanitizeConfig(job.config),
    };
    logger.info('Discovery job scheduled', { job: sanitizedJob });
  }

  /**
   * Sanitize config by redacting sensitive fields
   */
  private sanitizeConfig(config: any): any {
    if (!config) return config;

    const sanitized = { ...config };

    // Redact credentials object
    if (sanitized.credentials) {
      const credKeys = Object.keys(sanitized.credentials);
      sanitized.credentials = credKeys.reduce((acc: any, key: string) => {
        acc[key] = '***REDACTED***';
        return acc;
      }, {});
    }

    // Redact common secret fields
    const secretFields = ['password', 'secret', 'secretKey', 'secretAccessKey', 'apiKey', 'token', 'privateKey'];
    secretFields.forEach(field => {
      if (sanitized[field]) {
        sanitized[field] = '***REDACTED***';
      }
    });

    return sanitized;
  }

  async scheduleRecurringDiscovery(
    provider: string,
    config: any,
    cronPattern: string
  ): Promise<void> {
    const queueName = this.getQueueName(provider);
    const queue = queueManager.getQueue(queueName);

    await queue.add(
      'recurring-discovery',
      { provider, config },
      {
        repeat: {
          pattern: cronPattern,
        },
      }
    );

    logger.info('Recurring discovery scheduled', {
      provider,
      cronPattern,
    });
  }

  registerWorkers(): void {
    // NOTE: Cloud provider workers (AWS, Azure, GCP) were removed in v2.0
    // These are now handled by the connector framework
    // Only infrastructure protocol workers (SSH, NMAP, Active Directory) remain

    // SSH Discovery Worker
    queueManager.registerWorker(
      QUEUE_NAMES._DISCOVERY_SSH,
      async (job) => {
        // Handle both old format (jobId, config) and new format (id, config)
        const jobId = job.data.jobId || job.data.id;
        const config = job.data.config || job.data._config;
        const definition_id = job.data.definition_id;
        const cis: DiscoveredCI[] = [];

        try {
          await job.updateProgress(0);

          if (definition_id) {
            await this.updateDefinitionRunStatus(definition_id, jobId, 'running');
          }

          await job.updateProgress(25);

          const worker = new SSHDiscoveryWorker();

          // Handle various config formats
          const targets = config?.targets || config?.hosts || [];

          if (!Array.isArray(targets) || targets.length === 0) {
            throw new Error('SSH config must include "targets" or "hosts" array');
          }
          // Refuse a mixed batch before making any discovery connection.
          await Promise.all(targets.map(target => resolveDiscoveryHost(target.host)));

          const totalTargets = targets.length;
          let processedTargets = 0;

          for (const target of targets) {
            try {
              const ci = await worker.discoverHost(
                jobId,
                target.host,
                target.username,
                target.privateKeyPath,
                target.password
              );
              cis.push(ci);
              processedTargets++;

              // Update progress during discovery: 25-75%
              const discoveryProgress = 25 + Math.floor((processedTargets / totalTargets) * 50);
              await job.updateProgress(discoveryProgress);
            } catch (error) {
              if (error instanceof Error && error.message === DISCOVERY_TARGET_REFUSED) throw error;
              logger.error('SSH discovery failed for target', { jobId, error });
            }
          }

          // Add discovery_provider field to each CI
          cis.forEach(ci => {
            ci.discovery_provider = 'ssh';
          });

          await job.updateProgress(75);

          await this.persistCIs(cis);

          await job.updateProgress(100);

          if (definition_id) {
            await this.updateDefinitionRunStatus(definition_id, jobId, 'completed', cis.length);
          }

          return { discovered: cis.length };
        } catch (error) {
          if (definition_id) {
            await this.updateDefinitionRunStatus(definition_id, jobId, 'failed', 0, error);
          }
          throw error;
        }
      },
      { concurrency: 5 }
    );

    // Nmap Discovery Worker
    queueManager.registerWorker(
      QUEUE_NAMES._DISCOVERY_NMAP,
      async (job) => {
        const { jobId, config, definition_id } = job.data;

        try {
          await job.updateProgress(0);

          if (definition_id) {
            await this.updateDefinitionRunStatus(definition_id, jobId, 'running');
          }

          await job.updateProgress(25);

          const worker = new NmapDiscoveryWorker();

          await job.updateProgress(50);

          // Handle both single range and multiple targets
          let cis: DiscoveredCI[] = [];
          if (config.targets && Array.isArray(config.targets)) {
            // Multiple targets with optional scan options
            const ranges = config.targets.map((target: string) => ({
              range: target,
              scanType: this.mapScanOptions(config.scanOptions)
            }));
            cis = await worker.scanNetworks(jobId, ranges);
          } else if (config.range) {
            // Single range (legacy)
            cis = await worker.scanNetwork(jobId, config.range);
          } else {
            throw new Error('Nmap config must include either "targets" (array) or "range" (string)');
          }

          // Add discovery_provider field to each CI
          cis.forEach(ci => {
            ci.discovery_provider = 'nmap';
          });

          await job.updateProgress(75);

          await this.persistCIs(cis);

          await job.updateProgress(100);

          if (definition_id) {
            await this.updateDefinitionRunStatus(definition_id, jobId, 'completed', cis.length);
          }

          return { discovered: cis.length };
        } catch (error) {
          if (definition_id) {
            await this.updateDefinitionRunStatus(definition_id, jobId, 'failed', 0, error);
          }
          throw error;
        }
      },
      { concurrency: 3 }
    );

    // AI Discovery Worker (Phase 1-3)
    if (this.hybridOrchestrator) {
      queueManager.registerWorker(
        'discovery-ai',
        async (job) => {
          const jobId = job.data.jobId || job.data.id;
          const config = job.data.config || job.data._config;
          const definition_id = job.data.definition_id;
          const cis: DiscoveredCI[] = [];

          try {
            await job.updateProgress(0);

            if (definition_id) {
              await this.updateDefinitionRunStatus(definition_id, jobId, 'running');
            }

            logger.info('Starting AI discovery', { jobId, config: this.sanitizeConfig(config) });

            await job.updateProgress(10);

            // Extract target from config
            const targetHost = config?.targetHost || config?.host;
            const targetPort = config?.targetPort || config?.port || 22;

            if (!targetHost) {
              throw new Error('AI discovery requires targetHost in config');
            }

            // Prepare discovery context
            const context = {
              targetHost,
              targetPort,
              credentials: config?.credentials,
              scanResult: config?.scanResult, // Optional initial scan data
            };

            await job.updateProgress(25);

            // Execute hybrid discovery (pattern matching + AI)
            const result = await this.hybridOrchestrator!.discover(context);
            if (!result.success || result.error) {
              const error = result.error && TERMINAL_AI_DISCOVERY_ERRORS.has(result.error)
                ? result.error : 'AI discovery failed';
              throw new Error(error);
            }

            await job.updateProgress(75);

            logger.info('AI discovery completed', {
              jobId,
              method: result.method,
              confidence: result.confidence,
              cisFound: result.discoveredCIs.length,
              cost: result.cost,
            });

            // Add discovered CIs
            cis.push(...result.discoveredCIs);

            // Persist CIs to database
            await this.persistCIs(cis);

            await job.updateProgress(100);

            if (definition_id) {
              await this.updateDefinitionRunStatus(definition_id, jobId, 'completed', cis.length);
            }

            return {
              discovered: cis.length,
              method: result.method,
              confidence: result.confidence,
              cost: result.cost,
              sessionId: (result as any).session?.sessionId,
            };
          } catch (error) {
            logger.error('AI discovery failed', { jobId });
            if (definition_id) {
              await this.updateDefinitionRunStatus(definition_id, jobId, 'failed', 0, error);
            }
            throw error;
          }
        },
        { concurrency: 2 } // Lower concurrency for AI (API rate limits)
      );

      logger.info('AI discovery worker registered');
    }

    logger.info('All discovery workers registered');
  }

  /**
   * Map scan options to nmap scan type
   */
  private mapScanOptions(scanOptions?: any): 'quick' | 'port' | 'os' | 'version' {
    if (!scanOptions) {
      return 'quick';
    }

    // If aggressive mode, use OS detection (requires root)
    if (scanOptions.aggressive || scanOptions.osDetection) {
      return 'os';
    }

    // If service detection, use version scan (requires nmap-scripts)
    if (scanOptions.serviceDetection) {
      return 'version';
    }

    // If full port scan specified (scan all 65535 ports)
    if (scanOptions.fullPortScan || scanOptions.portScan) {
      return 'port';
    }

    return 'quick';
  }

  private async persistCIs(cis: DiscoveredCI[]): Promise<void> {
    logger.info(`Persisting ${cis.length} CIs via internal API`, {
      ciIds: cis.map(ci => ci._id),
      baseURL: process.env['CMDB_API_URL'] || 'http://localhost:3000'
    });

    // Enrich CIs with ITIL attributes before persisting
    logger.info('Enriching CIs with ITIL attributes before persistence');
    let enrichedCIs = await this.itilEnricher.enrichWithITIL(cis);
    logger.info(`Successfully enriched ${enrichedCIs.length} CIs with ITIL attributes`);

    // Enrich CIs with TBM attributes
    logger.info('Enriching CIs with TBM cost attributes before persistence');
    enrichedCIs = await this.tbmEnricher.enrichWithTBM(enrichedCIs);
    logger.info(`Successfully enriched ${enrichedCIs.length} CIs with TBM attributes`);

    // Enrich CIs with BSM attributes (v3.0)
    logger.info('Enriching CIs with BSM impact attributes before persistence');
    enrichedCIs = await this.bsmEnricher.enrichWithBSM(enrichedCIs);
    logger.info(`Successfully enriched ${enrichedCIs.length} CIs with BSM attributes`);

    for (const ci of enrichedCIs) {
      try {
        logger.debug('Checking if CI exists', { id: ci._id });

        // Check if CI already exists via API
        const existing = await this.apiClient.getCI(ci._id);

        if (existing) {
          // Update existing CI via API
          logger.debug('CI exists, updating', { id: ci._id });
          await this.apiClient.updateCI(ci._id, ci);
          logger.info('CI updated via API', { id: ci._id, name: ci.name });
        } else {
          // Create new CI via API
          logger.debug('CI does not exist, creating', { id: ci._id });
          await this.apiClient.createCI(ci);
          logger.info('CI created via API', { id: ci._id, name: ci.name, type: ci._type });
        }
      } catch (error) {
        logger.error('Failed to persist CI via API', {
          ciId: ci._id,
          ciName: ci.name,
          ciType: ci._type,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        // Re-throw to fail the job if persistence fails
        throw error;
      }
    }

    logger.info(`Successfully persisted ${cis.length} CIs`);
  }

  private getQueueName(provider: string): string {
    switch (provider) {
      case 'ssh':
        return QUEUE_NAMES._DISCOVERY_SSH;
      case 'nmap':
        return QUEUE_NAMES._DISCOVERY_NMAP;
      case 'active-directory':
        return 'discovery-active-directory';
      // AI Discovery (Phase 1-3)
      case 'ai':
      case 'hybrid':
        return 'discovery-ai';
      // Cloud providers (AWS, Azure, GCP) are handled by connector framework in v2.0
      case 'aws':
      case 'azure':
      case 'gcp':
        throw new Error(`Provider ${provider} is handled by the connector framework, not the discovery system`);
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  /**
   * Update discovery definition run status
   * Called by workers when processing jobs from definitions
   */
  private async updateDefinitionRunStatus(
    definitionId: string,
    jobId: string,
    status: 'running' | 'completed' | 'failed',
    cisDiscovered: number = 0,
    error?: any
  ): Promise<void> {
    const pool = this.postgresClient['pool'];
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Update discovery_runs table (commented out - table doesn't exist yet)
      // if (status === 'running') {
      //   // Create or update the run record when starting
      //   await client.query(
      //     `INSERT INTO discovery_runs (definition_id, job_id, status, triggered_by, trigger_type, started_at)
      //      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      //      ON CONFLICT (job_id) DO UPDATE SET
      //        status = $3,
      //        started_at = CURRENT_TIMESTAMP`,
      //     [definitionId, jobId, status, 'scheduler', 'scheduled']
      //   );
      // } else {
      //   // Update run record when completing or failing
      //   const errorMessage = error ? (error.message || String(error)) : null;
      //   await client.query(
      //     `UPDATE discovery_runs
      //      SET status = $1,
      //          completed_at = CURRENT_TIMESTAMP,
      //          duration_ms = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - started_at)) * 1000,
      //          cis_discovered = $2,
      //          error_message = $3
      //      WHERE job_id = $4`,
      //     [status, cisDiscovered, errorMessage, jobId]
      //   );
      // }

      // Update discovery_definitions table with last run info
      await client.query(
        `UPDATE discovery_definitions
         SET last_run_at = CURRENT_TIMESTAMP,
             last_run_status = $1,
             last_job_id = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [status, jobId, definitionId]
      );

      await client.query('COMMIT');

      logger.debug('Updated definition run status', {
        definitionId,
        jobId,
        status,
        cisDiscovered,
      });
    } catch (updateError) {
      await client.query('ROLLBACK');
      logger.error('Failed to update definition run status', {
        definitionId,
        jobId,
        status,
        error: updateError,
      });
      // Don't throw - we don't want to fail the discovery job if status update fails
    } finally {
      client.release();
    }
  }
}
