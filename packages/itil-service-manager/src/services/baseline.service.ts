// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Baseline Management Service
 * Implements ITIL v4 Configuration Baseline Management
 */

import { ConfigurationItem } from '@cmdb/unified-model';
import { CIRepository } from '../repositories/ci-repository';
import { BaselineRepository } from '../repositories/baseline-repository';
import {
  ConfigurationBaseline,
  BaselineComparison,
  DriftedCI,
} from '../types';

export class BaselineService {
  private ciRepository: CIRepository;
  private baselineRepository: BaselineRepository;

  constructor() {
    this.ciRepository = new CIRepository();
    this.baselineRepository = new BaselineRepository();
  }

  /**
   * Create configuration baseline
   * Captures current state of specified CIs
   */
  async createBaseline(
    name: string,
    ciIds: string[],
    description?: string,
    baselineType: 'configuration' | 'security' | 'performance' | 'compliance' = 'configuration',
    createdBy: string = 'system'
  ): Promise<ConfigurationBaseline> {
    if (ciIds.length === 0) {
      throw new Error('Cannot create baseline with empty CI list');
    }

    // Check if baseline name already exists
    const existing = await this.baselineRepository.getBaselineByName(name);
    if (existing) {
      throw new Error(`Baseline with name '${name}' already exists`);
    }

    // Get current state of all CIs
    const cis = await this.ciRepository.getCIsByIds(ciIds);
    if (cis.length === 0) {
      throw new Error('No CIs found with provided IDs');
    }

    // Capture baseline data (current configuration of each CI)
    const baselineData: Record<string, any> = {};

    for (const ci of cis) {
      baselineData[ci.id] = {
        id: ci.id,
        name: ci.name,
        type: ci.type,
        status: ci.status,
        environment: ci.environment,
        itil_attributes: ci.itil_attributes,
        tbm_attributes: ci.tbm_attributes,
        bsm_attributes: ci.bsm_attributes,
        metadata: ci.metadata,
        captured_at: new Date().toISOString(),
      };
    }

    // Extract unique CI types for scope
    const ciTypes = [...new Set(cis.map((ci) => ci.type))];

    // Extract environment (if all same)
    const environments = [...new Set(cis.map((ci) => ci.environment))];
    const environment: string | null = environments.length === 1 ? (environments[0] || null) : null;

    // Create baseline
    const baseline = await this.baselineRepository.createBaseline(
      name,
      description || `Baseline for ${cis.length} CIs`,
      baselineType,
      {
        ciIds: ciIds,
        ciTypes: ciTypes,
        environment: environment,
      },
      baselineData,
      createdBy
    );

    return baseline;
  }

  /**
   * Compare current state to baseline
   * Detects configuration drift
   */
  async compareToBaseline(baselineId: string): Promise<BaselineComparison> {
    // Get baseline
    const baseline = await this.baselineRepository.getBaselineById(baselineId);
    if (!baseline) {
      throw new Error(`Baseline not found: ${baselineId}`);
    }

    // Get current state of CIs
    const ciIds = baseline.scope.ciIds;
    const currentCIs = await this.ciRepository.getCIsByIds(ciIds);

    // Compare each CI
    const driftedCIs: DriftedCI[] = [];

    for (const currentCI of currentCIs) {
      const baselineCI = baseline.baselineData[currentCI.id];
      if (!baselineCI) {
        continue; // CI not in baseline
      }

      // Detect changes
      const changes = this.detectChanges(baselineCI, currentCI);

      if (changes.length > 0) {
        // Calculate drift severity
        const severity = this.calculateDriftSeverity(changes);

        // Calculate drift score
        const driftScore = this.calculateDriftScore(changes);

        driftedCIs.push({
          ciId: currentCI.id,
          ciName: currentCI.name,
          ciType: currentCI.type,
          changedAttributes: changes,
          severity,
          driftScore,
        });
      }
    }

    // Calculate drift percentage
    const totalCIs = ciIds.length;
    const driftedCount = driftedCIs.length;
    const driftPercentage = totalCIs > 0 ? (driftedCount / totalCIs) * 100 : 0;

    // Calculate compliance score (inverse of drift)
    const complianceScore = 100 - driftPercentage;

    return {
      baselineId: baseline.id,
      baselineName: baseline.name,
      comparisonDate: new Date(),
      driftedCIs,
      totalDriftCount: driftedCount,
      driftPercentage,
      complianceScore,
    };
  }

  /**
   * Detect changes between baseline and current CI
   */
  private detectChanges(
    baselineCI: any,
    currentCI: ConfigurationItem
  ): Array<{
    attribute: string;
    baselineValue: any;
    currentValue: any;
    changeDate?: Date;
  }> {
    const changes: Array<{
      attribute: string;
      baselineValue: any;
      currentValue: any;
      changeDate?: Date;
    }> = [];

    // Compare simple attributes
    if (baselineCI.status !== currentCI.status) {
      changes.push({
        attribute: 'status',
        baselineValue: baselineCI.status,
        currentValue: currentCI.status,
      });
    }

    if (baselineCI.environment !== currentCI.environment) {
      changes.push({
        attribute: 'environment',
        baselineValue: baselineCI.environment,
        currentValue: currentCI.environment,
      });
    }

    // Compare ITIL attributes
    const itilChanges = this.compareObjects(
      baselineCI.itil_attributes,
      currentCI.itil_attributes,
      'itil_attributes'
    );
    changes.push(...itilChanges);

    // Compare TBM attributes
    const tbmChanges = this.compareObjects(
      baselineCI.tbm_attributes,
      currentCI.tbm_attributes,
      'tbm_attributes'
    );
    changes.push(...tbmChanges);

    // Compare BSM attributes
    const bsmChanges = this.compareObjects(
      baselineCI.bsm_attributes,
      currentCI.bsm_attributes,
      'bsm_attributes'
    );
    changes.push(...bsmChanges);

    return changes;
  }

  /**
   * Compare two objects and return differences
   */
  private compareObjects(
    baselineObj: any,
    currentObj: any,
    prefix: string
  ): Array<{
    attribute: string;
    baselineValue: any;
    currentValue: any;
  }> {
    const changes: Array<{
      attribute: string;
      baselineValue: any;
      currentValue: any;
    }> = [];

    const allKeys = new Set([
      ...Object.keys(baselineObj || {}),
      ...Object.keys(currentObj || {}),
    ]);

    for (const key of allKeys) {
      const baselineValue = baselineObj?.[key];
      const currentValue = currentObj?.[key];

      // Skip if values are equal
      if (JSON.stringify(baselineValue) === JSON.stringify(currentValue)) {
        continue;
      }

      changes.push({
        attribute: `${prefix}.${key}`,
        baselineValue,
        currentValue,
      });
    }

    return changes;
  }

  /**
   * Calculate drift severity
   */
  private calculateDriftSeverity(
    changes: Array<{ attribute: string; baselineValue: any; currentValue: any }>
  ): 'critical' | 'high' | 'medium' | 'low' {
    // Critical attributes that should never drift
    const criticalAttributes = [
      'itil_attributes.lifecycle_stage',
      'itil_attributes.configuration_status',
      'bsm_attributes.business_criticality',
    ];

    // High priority attributes
    const highPriorityAttributes = [
      'status',
      'environment',
      'itil_attributes.version',
      'bsm_attributes.compliance_scope',
    ];

    // Check for critical changes
    for (const change of changes) {
      if (criticalAttributes.includes(change.attribute)) {
        return 'critical';
      }
    }

    // Check for high priority changes
    for (const change of changes) {
      if (highPriorityAttributes.includes(change.attribute)) {
        return 'high';
      }
    }

    // Many changes = medium severity
    if (changes.length > 5) {
      return 'medium';
    }

    // Few changes = low severity
    return 'low';
  }

  /**
   * Calculate drift score (0-100)
   */
  private calculateDriftScore(
    changes: Array<{ attribute: string; baselineValue: any; currentValue: any }>
  ): number {
    let score = 0;

    // Base score per change
    score += changes.length * 10;

    // Weight by attribute importance
    for (const change of changes) {
      if (change.attribute.startsWith('itil_attributes')) {
        score += 20;
      } else if (change.attribute.startsWith('bsm_attributes')) {
        score += 15;
      } else if (change.attribute.startsWith('tbm_attributes')) {
        score += 10;
      } else {
        score += 5;
      }
    }

    return Math.min(score, 100);
  }

  /**
   * Get all baselines
   */
  async getBaselines(): Promise<ConfigurationBaseline[]> {
    return await this.baselineRepository.getAllBaselines();
  }

  /**
   * Get baseline by ID
   */
  async getBaselineById(baselineId: string): Promise<ConfigurationBaseline | null> {
    return await this.baselineRepository.getBaselineById(baselineId);
  }

  /**
   * Delete baseline
   */
  async deleteBaseline(baselineId: string): Promise<void> {
    await this.baselineRepository.deleteBaseline(baselineId);
  }

  /**
   * No tenant authority or journal admission exists on this standalone API.
   * Preserve the public method contract but refuse every restore before data access.
   */
  async restoreFromBaseline(
    _ciId: string,
    _baselineId: string,
    _restoredBy: string = 'system'
  ): Promise<ConfigurationItem> {
    throw new Error('Baseline restore unavailable until journal admission');
  }

  /**
   * Approve baseline
   */
  async approveBaseline(
    baselineId: string,
    approvedBy: string
  ): Promise<ConfigurationBaseline> {
    return await this.baselineRepository.updateBaselineStatus(
      baselineId,
      'approved',
      approvedBy
    );
  }

  /**
   * Reject baseline
   */
  async rejectBaseline(
    baselineId: string,
    rejectedBy: string
  ): Promise<ConfigurationBaseline> {
    return await this.baselineRepository.updateBaselineStatus(
      baselineId,
      'rejected',
      rejectedBy
    );
  }

  /**
   * Get baselines by CI
   */
  async getBaselinesByCIId(ciId: string): Promise<ConfigurationBaseline[]> {
    return await this.baselineRepository.getBaselinesByCIId(ciId);
  }

  /**
   * Get compliance summary
   * Returns overall compliance across all approved baselines
   */
  async getComplianceSummary(): Promise<{
    totalBaselines: number;
    compliantCIs: number;
    driftedCIs: number;
    averageComplianceScore: number;
  }> {
    const baselines = await this.baselineRepository.getApprovedBaselines();

    if (baselines.length === 0) {
      return {
        totalBaselines: 0,
        compliantCIs: 0,
        driftedCIs: 0,
        averageComplianceScore: 100,
      };
    }

    let totalCompliantCIs = 0;
    let totalDriftedCIs = 0;
    let totalComplianceScore = 0;

    for (const baseline of baselines) {
      const comparison = await this.compareToBaseline(baseline.id);
      totalCompliantCIs +=
        baseline.scope.ciIds.length - comparison.totalDriftCount;
      totalDriftedCIs += comparison.totalDriftCount;
      totalComplianceScore += comparison.complianceScore;
    }

    return {
      totalBaselines: baselines.length,
      compliantCIs: totalCompliantCIs,
      driftedCIs: totalDriftedCIs,
      averageComplianceScore: totalComplianceScore / baselines.length,
    };
  }
}
