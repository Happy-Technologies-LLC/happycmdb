// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery Engine Package
 *
 * Provides discovery orchestrator and workers for multi-cloud CI discovery
 */

import { DiscoveryOrchestrator as DiscoveryOrchestratorClass } from './orchestrator/discovery-orchestrator';

export { DiscoveryOrchestrator } from './orchestrator/discovery-orchestrator';
export { SSHDiscoveryWorker } from './workers/ssh-discovery.worker';
export { NmapDiscoveryWorker } from './workers/nmap-discovery.worker';
export { ActiveDirectoryDiscoveryWorker } from './workers/active-directory-discovery.worker';
export { InternalAPIClient, getInternalAPIClient } from './api/internal-api-client';

// Export ITIL enrichment module
export { ITILEnricher, ITILClassifier, LifecycleDetector } from './enrichment';

// Provider-keyed discovery job scheduler (cron schedules for ssh/nmap, backed by BullMQ
// repeatable jobs). Exported under a distinct name because `getDiscoveryScheduler` below is
// a long-standing alias for the orchestrator, not this class.
export { DiscoveryScheduler, getDiscoveryScheduler as getDiscoveryJobScheduler } from './schedulers/discovery-scheduler';

// Export singleton getters for orchestrator (alias as scheduler for compatibility)
let orchestratorInstance: DiscoveryOrchestratorClass | null = null;

export function getDiscoveryOrchestrator(): DiscoveryOrchestratorClass {
  if (!orchestratorInstance) {
    orchestratorInstance = new DiscoveryOrchestratorClass();
  }
  return orchestratorInstance;
}

// Alias for backward compatibility
export const getDiscoveryScheduler = getDiscoveryOrchestrator;

// Worker manager is the orchestrator
export const getDiscoveryWorkerManager = getDiscoveryOrchestrator;
