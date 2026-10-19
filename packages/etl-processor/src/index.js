"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncIncidentsJobConfig = exports.processSyncIncidentsToDatamart = exports.syncCostsJobConfig = exports.processSyncCostsToDatamart = exports.syncCIsJobConfig = exports.processSyncCIsToDatamart = exports.IncidentSyncWorker = exports.CostValidationWorker = exports.CISyncWorker = exports.V3ETLWorkerManager = exports.getV3ETLWorkerManager = exports.V3ETLScheduler = exports.getV3ETLScheduler = exports.ETLScheduler = exports.getETLScheduler = exports.ETLWorkerManager = exports.DimensionTransformer = exports.CITransformer = exports.processFullRefreshJob = exports.FullRefreshJob = exports.processChangeDetectionJob = exports.ChangeDetectionJob = exports.processReconciliationJob = exports.ReconciliationJob = exports.processNeo4jToPostgresJob = exports.Neo4jToPostgresJob = void 0;
exports.getETLWorkerManager = getETLWorkerManager;
exports.initializeETLWorkers = initializeETLWorkers;
exports.initializeV3ETL = initializeV3ETL;
exports.shutdownETLWorkers = shutdownETLWorkers;
exports.shutdownV3ETL = shutdownV3ETL;
const bullmq_1 = require("bullmq");
const database_1 = require("@cmdb/database");
const common_1 = require("@cmdb/common");
const neo4j_to_postgres_job_1 = require("./jobs/neo4j-to-postgres.job");
const reconciliation_job_1 = require("./jobs/reconciliation.job");
const change_detection_job_1 = require("./jobs/change-detection.job");
const full_refresh_job_1 = require("./jobs/full-refresh.job");
var neo4j_to_postgres_job_2 = require("./jobs/neo4j-to-postgres.job");
Object.defineProperty(exports, "Neo4jToPostgresJob", { enumerable: true, get: function () { return neo4j_to_postgres_job_2.Neo4jToPostgresJob; } });
Object.defineProperty(exports, "processNeo4jToPostgresJob", { enumerable: true, get: function () { return neo4j_to_postgres_job_2.processNeo4jToPostgresJob; } });
var reconciliation_job_2 = require("./jobs/reconciliation.job");
Object.defineProperty(exports, "ReconciliationJob", { enumerable: true, get: function () { return reconciliation_job_2.ReconciliationJob; } });
Object.defineProperty(exports, "processReconciliationJob", { enumerable: true, get: function () { return reconciliation_job_2.processReconciliationJob; } });
var change_detection_job_2 = require("./jobs/change-detection.job");
Object.defineProperty(exports, "ChangeDetectionJob", { enumerable: true, get: function () { return change_detection_job_2.ChangeDetectionJob; } });
Object.defineProperty(exports, "processChangeDetectionJob", { enumerable: true, get: function () { return change_detection_job_2.processChangeDetectionJob; } });
var full_refresh_job_2 = require("./jobs/full-refresh.job");
Object.defineProperty(exports, "FullRefreshJob", { enumerable: true, get: function () { return full_refresh_job_2.FullRefreshJob; } });
Object.defineProperty(exports, "processFullRefreshJob", { enumerable: true, get: function () { return full_refresh_job_2.processFullRefreshJob; } });
var ci_transformer_1 = require("./transformers/ci-transformer");
Object.defineProperty(exports, "CITransformer", { enumerable: true, get: function () { return ci_transformer_1.CITransformer; } });
var dimension_transformer_1 = require("./transformers/dimension-transformer");
Object.defineProperty(exports, "DimensionTransformer", { enumerable: true, get: function () { return dimension_transformer_1.DimensionTransformer; } });
class ETLWorkerManager {
    workers = [];
    neo4jClient = (0, database_1.getNeo4jClient)();
    postgresClient = (0, database_1.getPostgresClient)();
    redisClient = (0, database_1.getRedisClient)();
    workerConnection;
    async startWorkers() {
        return this.start();
    }
    async start() {
        common_1.logger.info('Starting ETL workers...');
        try {
            const workerConnection = this.redisClient.getConnection().duplicate({ maxRetriesPerRequest: null });
            this.workerConnection = workerConnection;
            const syncWorker = new bullmq_1.Worker(database_1.QUEUE_NAMES._ETL_SYNC, (0, common_1.codedProcessor)('etl-sync', {
                cisProcessed: 'count', relationshipsProcessed: 'count', recordsInserted: 'count',
                recordsUpdated: 'count', errors: 'count', durationMs: 'count', completedAt: 'timestamp',
            }, async (job) => {
                common_1.logger.info('Processing Neo4j to PostgreSQL sync job', { jobId: job.id });
                return (0, neo4j_to_postgres_job_1.processNeo4jToPostgresJob)(job, this.neo4jClient, this.postgresClient);
            }), {
                connection: workerConnection,
                concurrency: 2,
                limiter: {
                    max: 10,
                    duration: 60000
                }
            });
            syncWorker.on('completed', (job, result) => {
                common_1.logger.info('Sync job completed', {
                    _jobId: job.id,
                    _cisProcessed: result.cisProcessed,
                    _durationMs: result.durationMs
                });
            });
            syncWorker.on('failed', (job, error) => {
                common_1.logger.error('Sync job failed', {
                    _jobId: job?.id,
                    _error: error.message
                });
            });
            this.workers.push(syncWorker);
            const reconciliationWorker = new bullmq_1.Worker(database_1.QUEUE_NAMES._ETL_RECONCILIATION, (0, common_1.codedProcessor)('etl-reconciliation', {
                _cisChecked: 'count', _conflictsDetected: 'count', _conflictsResolved: 'count',
                _manualReviewRequired: 'count', _durationMs: 'count', _completedAt: 'timestamp',
            }, async (job) => {
                common_1.logger.info('Processing reconciliation job', { jobId: job.id });
                return (0, reconciliation_job_1.processReconciliationJob)(job, this.neo4jClient, this.postgresClient);
            }), {
                connection: workerConnection,
                concurrency: 1,
                limiter: {
                    max: 5,
                    duration: 60000
                }
            });
            reconciliationWorker.on('completed', (job, result) => {
                common_1.logger.info('Reconciliation job completed', {
                    _jobId: job.id,
                    _cisChecked: result._cisChecked,
                    _conflictsDetected: result._conflictsDetected,
                    _conflictsResolved: result._conflictsResolved
                });
            });
            reconciliationWorker.on('failed', (job, error) => {
                common_1.logger.error('Reconciliation job failed', {
                    _jobId: job?.id,
                    _error: error.message
                });
            });
            this.workers.push(reconciliationWorker);
            const changeDetectionWorker = new bullmq_1.Worker(database_1.QUEUE_NAMES._ETL_CHANGE_DETECTION, (0, common_1.codedProcessor)('etl-change-detection', {
                cisChecked: 'count', changesDetected: 'count', changesRecorded: 'count',
                durationMs: 'count', completedAt: 'timestamp',
            }, async (job) => {
                common_1.logger.info('Processing change detection job', { jobId: job.id });
                return (0, change_detection_job_1.processChangeDetectionJob)(job, this.neo4jClient, this.postgresClient);
            }), {
                connection: workerConnection,
                concurrency: 3,
                limiter: {
                    max: 20,
                    duration: 60000
                }
            });
            changeDetectionWorker.on('completed', (job, result) => {
                common_1.logger.info('Change detection job completed', {
                    _jobId: job.id,
                    _cisChecked: result.cisChecked,
                    _changesDetected: result.changesDetected
                });
            });
            changeDetectionWorker.on('failed', (job, error) => {
                common_1.logger.error('Change detection job failed', {
                    _jobId: job?.id,
                    _error: error.message
                });
            });
            this.workers.push(changeDetectionWorker);
            const fullRefreshWorker = new bullmq_1.Worker(database_1.QUEUE_NAMES._ETL_FULL_REFRESH, (0, common_1.codedProcessor)('etl-full-refresh', {
                cisProcessed: 'count', relationshipsProcessed: 'count', dimensionsCreated: 'count',
                factsCreated: 'count', durationMs: 'count', completedAt: 'timestamp', stagesCompleted: 'stages',
            }, async (job) => {
                common_1.logger.info('Processing full refresh job', { jobId: job.id });
                return (0, full_refresh_job_1.processFullRefreshJob)(job, this.neo4jClient, this.postgresClient);
            }), {
                connection: workerConnection,
                concurrency: 1,
                limiter: {
                    max: 1,
                    duration: 300000
                }
            });
            fullRefreshWorker.on('completed', (job, result) => {
                common_1.logger.info('Full refresh job completed', {
                    jobId: job.id,
                    cisProcessed: result.cisProcessed,
                    dimensionsCreated: result.dimensionsCreated,
                    factsCreated: result.factsCreated,
                    durationMs: result.durationMs
                });
            });
            fullRefreshWorker.on('failed', (job, error) => {
                common_1.logger.error('Full refresh job failed', {
                    jobId: job?.id,
                    error: error.message
                });
            });
            this.workers.push(fullRefreshWorker);
            this.workers.forEach(worker => {
                worker.on('active', (job) => {
                    common_1.logger.debug('Job started', {
                        _jobId: job.id,
                        _queue: job.queueName
                    });
                });
                worker.on('progress', (job, progress) => {
                    common_1.logger.debug('Job progress', {
                        _jobId: job.id,
                        _progress: `${progress}%`
                    });
                });
                worker.on('stalled', (jobId) => {
                    common_1.logger.warn('Job stalled', { jobId });
                });
                worker.on('failed', (job, error) => {
                    if (job)
                        void common_1.JobErrorHandler.handleJobFailure(job, error).catch(() => {
                            common_1.logger.error('ETL dead-letter handling failed', { code: 'ERR_INTERNAL' });
                        });
                });
                worker.on('error', (error) => {
                    common_1.logger.error('Worker error', { error });
                });
            });
            common_1.logger.info(`Started ${this.workers.length} ETL workers successfully`, {
                _queues: this.workers.map(w => w.name)
            });
        }
        catch (error) {
            await Promise.allSettled(this.workers.map(worker => worker.close()));
            this.workers = [];
            await this.workerConnection?.quit().catch(() => undefined);
            this.workerConnection = undefined;
            common_1.logger.error('Failed to start ETL workers', { code: 'ERR_INTERNAL' });
            throw error;
        }
    }
    async stopWorkers() {
        return this.stop();
    }
    async stop() {
        common_1.logger.info('Stopping ETL workers...');
        try {
            await Promise.all(this.workers.map(async (worker) => {
                await worker.close();
                common_1.logger.info('Worker stopped', { queue: worker.name });
            }));
            this.workers = [];
            await this.workerConnection?.quit();
            this.workerConnection = undefined;
            common_1.logger.info('All ETL workers stopped successfully');
        }
        catch (error) {
            common_1.logger.error('Error stopping ETL workers', { error });
            throw error;
        }
    }
    async getAllWorkerStatuses() {
        return this.getHealthStatus();
    }
    async getHealthStatus() {
        const status = {
            healthy: true,
            workers: []
        };
        for (const worker of this.workers) {
            const isRunning = await worker.isRunning();
            const workerStatus = {
                name: worker.name,
                running: isRunning,
                concurrency: worker.opts.concurrency || 1
            };
            status.workers.push(workerStatus);
            if (!isRunning) {
                status.healthy = false;
            }
        }
        return status;
    }
    async pauseWorkers() {
        common_1.logger.info('Pausing all ETL workers...');
        await Promise.all(this.workers.map(w => w.pause()));
        common_1.logger.info('All workers paused');
    }
    async resumeWorkers() {
        common_1.logger.info('Resuming all ETL workers...');
        await Promise.all(this.workers.map(w => w.resume()));
        common_1.logger.info('All workers resumed');
    }
}
exports.ETLWorkerManager = ETLWorkerManager;
let workerManager = null;
function getETLWorkerManager() {
    if (!workerManager) {
        workerManager = new ETLWorkerManager();
    }
    return workerManager;
}
var etl_scheduler_1 = require("./schedulers/etl-scheduler");
Object.defineProperty(exports, "getETLScheduler", { enumerable: true, get: function () { return etl_scheduler_1.getETLScheduler; } });
Object.defineProperty(exports, "ETLScheduler", { enumerable: true, get: function () { return etl_scheduler_1.ETLScheduler; } });
const v3_etl_scheduler_1 = require("./schedulers/v3-etl-scheduler");
Object.defineProperty(exports, "getV3ETLScheduler", { enumerable: true, get: function () { return v3_etl_scheduler_1.getV3ETLScheduler; } });
Object.defineProperty(exports, "V3ETLScheduler", { enumerable: true, get: function () { return v3_etl_scheduler_1.V3ETLScheduler; } });
const v3_etl_worker_1 = require("./workers/v3-etl.worker");
Object.defineProperty(exports, "getV3ETLWorkerManager", { enumerable: true, get: function () { return v3_etl_worker_1.getV3ETLWorkerManager; } });
Object.defineProperty(exports, "V3ETLWorkerManager", { enumerable: true, get: function () { return v3_etl_worker_1.V3ETLWorkerManager; } });
Object.defineProperty(exports, "CISyncWorker", { enumerable: true, get: function () { return v3_etl_worker_1.CISyncWorker; } });
Object.defineProperty(exports, "CostValidationWorker", { enumerable: true, get: function () { return v3_etl_worker_1.CostValidationWorker; } });
Object.defineProperty(exports, "IncidentSyncWorker", { enumerable: true, get: function () { return v3_etl_worker_1.IncidentSyncWorker; } });
var sync_cis_to_datamart_job_1 = require("./jobs/sync-cis-to-datamart.job");
Object.defineProperty(exports, "processSyncCIsToDatamart", { enumerable: true, get: function () { return sync_cis_to_datamart_job_1.processSyncCIsToDatamart; } });
Object.defineProperty(exports, "syncCIsJobConfig", { enumerable: true, get: function () { return sync_cis_to_datamart_job_1.syncCIsJobConfig; } });
var sync_costs_to_datamart_job_1 = require("./jobs/sync-costs-to-datamart.job");
Object.defineProperty(exports, "processSyncCostsToDatamart", { enumerable: true, get: function () { return sync_costs_to_datamart_job_1.processSyncCostsToDatamart; } });
Object.defineProperty(exports, "syncCostsJobConfig", { enumerable: true, get: function () { return sync_costs_to_datamart_job_1.syncCostsJobConfig; } });
var sync_incidents_to_datamart_job_1 = require("./jobs/sync-incidents-to-datamart.job");
Object.defineProperty(exports, "processSyncIncidentsToDatamart", { enumerable: true, get: function () { return sync_incidents_to_datamart_job_1.processSyncIncidentsToDatamart; } });
Object.defineProperty(exports, "syncIncidentsJobConfig", { enumerable: true, get: function () { return sync_incidents_to_datamart_job_1.syncIncidentsJobConfig; } });
async function initializeETLWorkers() {
    const manager = getETLWorkerManager();
    await manager.startWorkers();
    return manager;
}
async function initializeV3ETL() {
    common_1.logger.info('[initializeV3ETL] Starting v3.0 ETL pipeline...');
    const scheduler = (0, v3_etl_scheduler_1.getV3ETLScheduler)();
    const workerManager = (0, v3_etl_worker_1.getV3ETLWorkerManager)();
    await scheduler.start();
    await workerManager.start();
    common_1.logger.info('[initializeV3ETL] v3.0 ETL pipeline started successfully');
    return { scheduler, workerManager };
}
async function shutdownETLWorkers() {
    if (workerManager) {
        await workerManager.stopWorkers();
        workerManager = null;
    }
}
async function shutdownV3ETL() {
    common_1.logger.info('[shutdownV3ETL] Stopping v3.0 ETL pipeline...');
    const scheduler = (0, v3_etl_scheduler_1.getV3ETLScheduler)();
    const workerManager = (0, v3_etl_worker_1.getV3ETLWorkerManager)();
    await scheduler.stop();
    await workerManager.stop();
    common_1.logger.info('[shutdownV3ETL] v3.0 ETL pipeline stopped');
}
//# sourceMappingURL=index.js.map