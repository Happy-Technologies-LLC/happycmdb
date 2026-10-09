// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * AI/ML Engine - Main Entry Point
 */

export * from './types/anomaly.types';
export * from './types/impact.types';
export * from './types/architecture.types';
export * from './engines/anomaly-detection-engine';
export * from './engines/impact-prediction-engine';
export * from './engines/configuration-drift-detector';
export * from './engines/architecture-optimization-engine';

import { logger } from '@cmdb/common';
// System job: discovery/update events carry no request organization.
import { UNSCOPED_CI_ACCESS } from '@cmdb/database';
import { createEventConsumer, KAFKA_TOPICS, CONSUMER_GROUPS } from '@cmdb/event-processor';
import { getAnomalyDetectionEngine } from './engines/anomaly-detection-engine';
import { getConfigurationDriftDetector } from './engines/configuration-drift-detector';

/**
 * Start ML engines with event stream integration
 */
export async function startMLEngines(): Promise<void> {
  logger.info('Starting ML engines...');

  const anomalyEngine = getAnomalyDetectionEngine();
  const driftDetector = getConfigurationDriftDetector();

  // Impact engine available but not used in event stream integration yet
  // Can be accessed via: getImpactPredictionEngine()

  // Load configurations
  await anomalyEngine.loadConfiguration();

  // Set up event consumers
  const consumer = createEventConsumer(CONSUMER_GROUPS.ANALYTICS_PROCESSOR);
  await consumer.connect();
  await consumer.subscribe([
    KAFKA_TOPICS.CI_EVENTS,
    KAFKA_TOPICS.CI_CHANGES,
  ]);

  // Handle CI discovered events - create baseline
  consumer.on('ci.discovered', async (event: any) => {
    try {
      logger.debug('Creating baseline for new CI', { ci_id: event.ci_id });
      await driftDetector.createBaseline(event.ci_id, 'configuration', 'auto-baseline', UNSCOPED_CI_ACCESS);
    } catch (error) {
      logger.error('Failed to create baseline', { ci_id: event.ci_id, error });
    }
  });

  // Handle CI updated events - check for drift
  consumer.on('ci.updated', async (event: any) => {
    try {
      logger.debug('Checking for drift', { ci_id: event.ci_id });
      const driftResult = await driftDetector.detectDrift(event.ci_id, UNSCOPED_CI_ACCESS);

      if (driftResult.has_drift && driftResult.drift_score > 50) {
        logger.warn('Significant drift detected', {
          ci_id: event.ci_id,
          drift_score: driftResult.drift_score,
          drifted_fields: driftResult.drifted_fields.length,
        });
      }
    } catch (error) {
      logger.debug('Drift detection skipped (no baseline)', { ci_id: event.ci_id });
    }
  });

  // Start consumer
  await consumer.run();

  // Schedule periodic anomaly detection (every hour)
  setInterval(async () => {
    try {
      logger.info('Running scheduled anomaly detection');
      const anomalies = await anomalyEngine.detectAnomalies();
      logger.info('Anomaly detection completed', { anomalies_found: anomalies.length });
    } catch (error) {
      logger.error('Anomaly detection failed', { error });
    }
  }, 60 * 60 * 1000); // 1 hour

  logger.info('ML engines started');

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down ML engines...');
    await consumer.disconnect();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down ML engines...');
    await consumer.disconnect();
    process.exit(0);
  });
}

// Start engines if executed directly
if (require.main === module) {
  startMLEngines().catch(error => {
    logger.error('Failed to start ML engines', { error });
    process.exit(1);
  });
}
