// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration Management Service
 * Implements ITIL v4 Configuration Management capabilities
 */

import { ConfigurationItem, ITILLifecycle, ITILConfigStatus } from '@cmdb/unified-model';
import { DiscoveryProducer } from '@cmdb/event-streaming';
import { CIRepository } from '../repositories/ci-repository';
import { LifecycleManager } from '../utils/lifecycle-manager';
import {
  CIHistoryEvent,
  AuditResult,
  ConfigurationAccuracyMetrics,
} from '../types';
import { v4 as uuidv4 } from 'uuid';

export class ConfigurationManagementService {
  private ciRepository: CIRepository;
  private eventProducer: DiscoveryProducer;

  constructor() {
    this.ciRepository = new CIRepository();
    this.eventProducer = new DiscoveryProducer();
  }

  /**
   * Initialize event producer
   */
  async connect(): Promise<void> {
    await this.eventProducer.connect();
  }

  /**
   * Close event producer
   */
  async disconnect(): Promise<void> {
    await this.eventProducer.disconnect();
  }

  /**
   * Update CI lifecycle stage
   * Validates transition is valid before applying
   */
  async updateLifecycleStage(
    ciId: string,
    organizationId: string,
    newStage: ITILLifecycle,
    performedBy: string,
    reason?: string
  ): Promise<ConfigurationItem> {
    // Get current CI
    const ci = await this.ciRepository.getOwnedCI(ciId, organizationId);
    if (!ci) {
      throw new Error(`CI not found: ${ciId}`);
    }

    const currentStage = ci.itil_attributes.lifecycle_stage;

    // Validate transition
    if (!LifecycleManager.isValidLifecycleTransition(currentStage, newStage)) {
      const validStages = LifecycleManager.getValidNextLifecycleStages(currentStage);
      throw new Error(
        `Invalid lifecycle transition from '${currentStage}' to '${newStage}'. ` +
          `Valid transitions: ${validStages.join(', ')}`
      );
    }

    // Update lifecycle stage
    const updatedCI = await this.ciRepository.updateITILAttributes(ciId, organizationId, {
      lifecycle_stage: newStage,
    });

    // Publish event
    await this.eventProducer.publishCIUpdated({
      eventId: uuidv4(),
      timestamp: new Date(),
      version: '3.0.0',
      eventType: 'ci.updated',
      payload: {
        ciId,
        ciType: ci.type,
        name: ci.name,
        updatedBy: performedBy,
        changes: [
          {
            field: 'lifecycle_stage',
            oldValue: currentStage,
            newValue: newStage,
          },
        ],
        metadata: {
          reason: reason || LifecycleManager.generateTransitionReasoning(currentStage, newStage),
        },
      },
    });

    return updatedCI;
  }

  /**
   * Update configuration status
   */
  async updateConfigurationStatus(
    ciId: string,
    organizationId: string,
    newStatus: ITILConfigStatus,
    performedBy: string,
    reason?: string
  ): Promise<ConfigurationItem> {
    // Get current CI
    const ci = await this.ciRepository.getOwnedCI(ciId, organizationId);
    if (!ci) {
      throw new Error(`CI not found: ${ciId}`);
    }

    const currentStatus = ci.itil_attributes.configuration_status;

    // Validate transition
    if (!LifecycleManager.isValidStatusTransition(currentStatus, newStatus)) {
      const validStatuses = LifecycleManager.getValidNextStatuses(currentStatus);
      throw new Error(
        `Invalid status transition from '${currentStatus}' to '${newStatus}'. ` +
          `Valid transitions: ${validStatuses.join(', ')}`
      );
    }

    // Update configuration status
    const updatedCI = await this.ciRepository.updateITILAttributes(ciId, organizationId, {
      configuration_status: newStatus,
    });

    // Publish event
    await this.eventProducer.publishCIUpdated({
      eventId: uuidv4(),
      timestamp: new Date(),
      version: '3.0.0',
      eventType: 'ci.updated',
      payload: {
        ciId,
        ciType: ci.type,
        name: ci.name,
        updatedBy: performedBy,
        changes: [
          {
            field: 'configuration_status',
            oldValue: currentStatus,
            newValue: newStatus,
          },
        ],
        metadata: { reason },
      },
    });

    return updatedCI;
  }

  /**
   * Mark CI for audit
   */
  async scheduleAudit(
    ciId: string,
    organizationId: string,
    auditDate: Date,
    scheduledBy: string
  ): Promise<void> {
    const ci = await this.ciRepository.getOwnedCI(ciId, organizationId);
    if (!ci) {
      throw new Error(`CI not found: ${ciId}`);
    }

    // Update audit metadata
    await this.ciRepository.updateITILAttributes(ciId, organizationId, {
      audit_status: 'unknown',
    });

    // Publish event
    await this.eventProducer.publishCIUpdated({
      eventId: uuidv4(),
      timestamp: new Date(),
      version: '3.0.0',
      eventType: 'ci.updated',
      payload: {
        ciId,
        ciType: ci.type,
        name: ci.name,
        updatedBy: scheduledBy,
        changes: [
          {
            field: 'audit_scheduled',
            oldValue: null,
            newValue: auditDate.toISOString(),
          },
        ],
        metadata: {
          eventType: 'audit_scheduled',
        },
      },
    });
  }

  /**
   * Complete audit and update status
   */
  async completeAudit(
    ciId: string,
    organizationId: string,
    auditStatus: 'compliant' | 'non_compliant',
    auditedBy: string,
    findings: string[] = [],
    recommendations: string[] = []
  ): Promise<AuditResult> {
    const ci = await this.ciRepository.getOwnedCI(ciId, organizationId);
    if (!ci) {
      throw new Error(`CI not found: ${ciId}`);
    }

    const now = new Date();

    // Determine next audit date based on criticality
    const daysUntilNextAudit = LifecycleManager.getRecommendedAuditFrequency(
      ci.itil_attributes.lifecycle_stage,
      ci.bsm_attributes.business_criticality as any
    );
    const nextAuditDate = new Date(now);
    nextAuditDate.setDate(nextAuditDate.getDate() + daysUntilNextAudit);

    // Update audit attributes
    await this.ciRepository.updateITILAttributes(ciId, organizationId, {
      audit_status: auditStatus,
      last_audited: now,
    });

    // Publish event
    await this.eventProducer.publishCIUpdated({
      eventId: uuidv4(),
      timestamp: new Date(),
      version: '3.0.0',
      eventType: 'ci.updated',
      payload: {
        ciId,
        ciType: ci.type,
        name: ci.name,
        updatedBy: auditedBy,
        changes: [
          {
            field: 'audit_status',
            oldValue: ci.itil_attributes.audit_status,
            newValue: auditStatus,
          },
        ],
        metadata: {
          eventType: 'audit_completed',
          findings,
          recommendations,
        },
      },
    });

    return {
      ciId,
      auditDate: now,
      auditStatus,
      auditedBy,
      findings,
      recommendations,
      nextAuditDate,
    };
  }

  /**
   * Get CIs due for audit
   */
  async getCIsDueForAudit(daysThreshold: number = 90): Promise<ConfigurationItem[]> {
    return await this.ciRepository.getCIsDueForAudit(daysThreshold);
  }

  /**
   * Get CI history (lifecycle transitions and audits)
   */
  async getCIHistory(ciId: string, limit: number = 100): Promise<CIHistoryEvent[]> {
    return await this.ciRepository.getCIHistory(ciId, limit);
  }

  /**
   * Get configuration accuracy metrics
   * Returns percentage of CIs with recent audit
   */
  async getConfigurationAccuracy(): Promise<ConfigurationAccuracyMetrics> {
    const metrics = await this.ciRepository.getConfigurationAccuracyMetrics();

    // Get CIs due for audit
    const cisDueForAudit = await this.getCIsDueForAudit(90);
    metrics.cisDueForAudit = cisDueForAudit.length;

    return metrics;
  }

  /**
   * Validate a CI of this organization is ready for production
   */
  async validateReadyForProduction(ciId: string, organizationId: string): Promise<{
    ready: boolean;
    issues: string[];
  }> {
    const ci = await this.ciRepository.getOwnedCI(ciId, organizationId);
    if (!ci) {
      throw new Error(`CI not found: ${ciId}`);
    }

    const issues: string[] = [];

    // Check lifecycle stage
    if (ci.itil_attributes.lifecycle_stage !== 'deploy') {
      issues.push('CI must be in deploy stage before moving to production');
    }

    // Check configuration status
    if (ci.itil_attributes.configuration_status !== 'in_development') {
      issues.push('CI must be in in_development status');
    }

    // Check audit status
    if (ci.itil_attributes.audit_status === 'non_compliant') {
      issues.push('CI has non-compliant audit status');
    }

    // Check if audit is recent (within 30 days)
    const daysSinceAudit = Math.floor(
      (Date.now() - new Date(ci.itil_attributes.last_audited).getTime()) /
        (1000 * 60 * 60 * 24)
    );
    if (daysSinceAudit > 30) {
      issues.push('CI audit is more than 30 days old');
    }

    return {
      ready: issues.length === 0,
      issues,
    };
  }

  /**
   * Promote CI to production
   * Validates readiness and updates lifecycle/status
   */
  async promoteToProduction(
    ciId: string,
    organizationId: string,
    promotedBy: string
  ): Promise<ConfigurationItem> {
    // Validate readiness
    const validation = await this.validateReadyForProduction(ciId, organizationId);
    if (!validation.ready) {
      throw new Error(
        `CI is not ready for production:\n${validation.issues.join('\n')}`
      );
    }

    // Update to operate lifecycle and active status
    await this.updateLifecycleStage(ciId, organizationId, 'operate', promotedBy, 'Promoted to production');
    const ci = await this.updateConfigurationStatus(
      ciId,
      organizationId,
      'active',
      promotedBy,
      'Promoted to production'
    );

    return ci;
  }

  /**
   * Retire CI
   * Moves CI to retire lifecycle and retired status
   */
  async retireCI(ciId: string, organizationId: string, retiredBy: string, reason: string): Promise<ConfigurationItem> {
    const ci = await this.ciRepository.getOwnedCI(ciId, organizationId);
    if (!ci) {
      throw new Error(`CI not found: ${ciId}`);
    }

    // Update to retire lifecycle
    await this.updateLifecycleStage(ciId, organizationId, 'retire', retiredBy, reason);

    // Update to retired status
    const retiredCI = await this.updateConfigurationStatus(ciId, organizationId, 'retired', retiredBy, reason);

    return retiredCI;
  }
}
