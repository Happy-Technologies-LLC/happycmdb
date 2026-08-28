// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Priority Calculator Utility
 * Implements ITIL v4 Priority Matrix (Impact x Urgency = Priority)
 */

import { PriorityMatrix } from '../types';

export class PriorityCalculator {
  /**
   * ITIL Standard Priority Matrix
   * Priority levels: 1 (Critical) to 5 (Low)
   */
  private static readonly PRIORITY_MATRIX: PriorityMatrix = {
    matrix: {
      critical: {
        critical: 1,
        high: 1,
        medium: 2,
        low: 3,
      },
      high: {
        critical: 1,
        high: 2,
        medium: 2,
        low: 3,
      },
      medium: {
        critical: 2,
        high: 3,
        medium: 3,
        low: 4,
      },
      low: {
        critical: 3,
        high: 4,
        medium: 4,
        low: 5,
      },
    },
  };

  /**
   * Calculate priority from impact and urgency
   */
  static calculatePriority(
    impact: 'critical' | 'high' | 'medium' | 'low',
    urgency: 'critical' | 'high' | 'medium' | 'low'
  ): 1 | 2 | 3 | 4 | 5 {
    return this.PRIORITY_MATRIX.matrix[impact]?.[urgency] || 3;
  }

  /**
   * Get priority matrix
   */
  static getPriorityMatrix(): PriorityMatrix {
    return this.PRIORITY_MATRIX;
  }

  /**
   * Determine impact based on business criticality and user count
   */
  static calculateImpact(
    businessCriticality: 'tier_1' | 'tier_2' | 'tier_3' | 'tier_4',
    estimatedUserImpact: number,
    isCustomerFacing: boolean
  ): 'critical' | 'high' | 'medium' | 'low' {
    // Critical: Tier 1 services OR high user impact on customer-facing
    if (
      businessCriticality === 'tier_1' ||
      (estimatedUserImpact > 1000 && isCustomerFacing)
    ) {
      return 'critical';
    }

    // High: Tier 2 services OR medium user impact on customer-facing
    if (
      businessCriticality === 'tier_2' ||
      (estimatedUserImpact > 100 && isCustomerFacing)
    ) {
      return 'high';
    }

    // Medium: Tier 3 services OR low user impact
    if (businessCriticality === 'tier_3' || estimatedUserImpact > 10) {
      return 'medium';
    }

    // Low: Tier 4 services OR minimal user impact
    return 'low';
  }

  /**
   * Determine urgency based on operational status and SLA requirements
   */
  static calculateUrgency(
    operationalStatus: string,
    slaAvailabilityTarget: number,
    isBusinessHours: boolean
  ): 'critical' | 'high' | 'medium' | 'low' {
    // Critical: Service in outage during business hours with high SLA
    if (operationalStatus === 'outage' && isBusinessHours && slaAvailabilityTarget >= 99.9) {
      return 'critical';
    }

    // High: Service degraded with high SLA OR in outage with medium SLA
    if (
      (operationalStatus === 'degraded' && slaAvailabilityTarget >= 99.9) ||
      (operationalStatus === 'outage' && slaAvailabilityTarget >= 99.0)
    ) {
      return 'high';
    }

    // Medium: Service degraded OR outage outside business hours
    if (operationalStatus === 'degraded' || !isBusinessHours) {
      return 'medium';
    }

    // Low: Service operational (or in maintenance) or low SLA
    return 'low';
  }

  /**
   * Check if priority requires immediate escalation
   */
  static requiresEscalation(priority: 1 | 2 | 3 | 4 | 5): boolean {
    return priority === 1; // P1 incidents require immediate escalation
  }

  /**
   * Get recommended response time (in minutes)
   */
  static getRecommendedResponseTime(priority: 1 | 2 | 3 | 4 | 5): number {
    const responseTimes: Record<number, number> = {
      1: 15, // 15 minutes for P1
      2: 60, // 1 hour for P2
      3: 240, // 4 hours for P3
      4: 480, // 8 hours for P4
      5: 1440, // 24 hours for P5
    };

    return responseTimes[priority] || 240;
  }

  /**
   * Get recommended resolution time (in minutes)
   */
  static getRecommendedResolutionTime(priority: 1 | 2 | 3 | 4 | 5): number {
    const resolutionTimes: Record<number, number> = {
      1: 240, // 4 hours for P1
      2: 480, // 8 hours for P2
      3: 1440, // 24 hours for P3
      4: 4320, // 3 days for P4
      5: 10080, // 7 days for P5
    };

    return resolutionTimes[priority] || 1440;
  }

  /**
   * Get recommended response team based on priority
   */
  static getRecommendedResponseTeam(
    priority: 1 | 2 | 3 | 4 | 5,
    serviceOwner: string,
    supportLevel: 'l1' | 'l2' | 'l3' | 'l4'
  ): string[] {
    const teams: string[] = [];

    // P1: All hands on deck
    if (priority === 1) {
      teams.push('Incident Commander');
      teams.push('Service Owner: ' + serviceOwner);
      teams.push('L3 Support');
      teams.push('Engineering Team');
      teams.push('Communications Team');
    }
    // P2: Senior support and service owner
    else if (priority === 2) {
      teams.push('Service Owner: ' + serviceOwner);
      teams.push('L2/L3 Support');
    }
    // P3-P4: Standard support
    else if (priority === 3 || priority === 4) {
      teams.push(supportLevel === 'l1' ? 'L1 Support' : 'L2 Support');
    }
    // P5: L1 support
    else {
      teams.push('L1 Support');
    }

    return teams;
  }

  /**
   * Estimate cost of downtime per hour
   */
  static estimateCostOfDowntime(
    annualRevenue: number,
    businessHoursPerYear: number = 2080 // 40 hours/week * 52 weeks
  ): number {
    return annualRevenue / businessHoursPerYear;
  }

  /**
   * Check if current time is business hours
   */
  static isBusinessHours(
    serviceHours: {
      availability: '24x7' | '24x5' | 'business_hours' | 'custom';
      business_hours_start?: string;
      business_hours_end?: string;
      timezone: string;
    },
    currentTime: Date = new Date()
  ): boolean {
    // 24x7 services are always business hours
    if (serviceHours.availability === '24x7') {
      return true;
    }

    const dayOfWeek = currentTime.getDay();
    const hour = currentTime.getHours();

    // 24x5: Monday-Friday, any hour
    if (serviceHours.availability === '24x5') {
      return dayOfWeek >= 1 && dayOfWeek <= 5;
    }

    // Business hours: Monday-Friday, 8am-6pm (default)
    if (serviceHours.availability === 'business_hours') {
      const startHour = serviceHours.business_hours_start
        ? parseInt(serviceHours.business_hours_start.split(':')[0] || '8')
        : 8;
      const endHour = serviceHours.business_hours_end
        ? parseInt(serviceHours.business_hours_end.split(':')[0] || '18')
        : 18;

      return dayOfWeek >= 1 && dayOfWeek <= 5 && hour >= startHour && hour < endHour;
    }

    // Custom: Use provided hours
    return false;
  }
}
