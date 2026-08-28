// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Priority Calculator Unit Tests
 */

import { PriorityCalculator } from '../../src/utils/priority-calculator';

describe('PriorityCalculator', () => {
  describe('calculatePriority', () => {
    it('should calculate P1 for critical impact and critical urgency', () => {
      const priority = PriorityCalculator.calculatePriority('critical', 'critical');
      expect(priority).toBe(1);
    });

    it('should calculate P2 for critical impact and medium urgency', () => {
      const priority = PriorityCalculator.calculatePriority('critical', 'medium');
      expect(priority).toBe(2);
    });

    it('should calculate P3 for high impact and low urgency', () => {
      const priority = PriorityCalculator.calculatePriority('high', 'low');
      expect(priority).toBe(3);
    });

    it('should calculate P5 for low impact and low urgency', () => {
      const priority = PriorityCalculator.calculatePriority('low', 'low');
      expect(priority).toBe(5);
    });

    it('should handle all matrix combinations', () => {
      const impacts: Array<'critical' | 'high' | 'medium' | 'low'> = [
        'critical',
        'high',
        'medium',
        'low',
      ];
      const urgencies: Array<'critical' | 'high' | 'medium' | 'low'> = [
        'critical',
        'high',
        'medium',
        'low',
      ];

      impacts.forEach((impact) => {
        urgencies.forEach((urgency) => {
          const priority = PriorityCalculator.calculatePriority(impact, urgency);
          expect(priority).toBeGreaterThanOrEqual(1);
          expect(priority).toBeLessThanOrEqual(5);
        });
      });
    });
  });

  describe('calculateImpact', () => {
    it('should return critical for tier_1 services', () => {
      const impact = PriorityCalculator.calculateImpact('tier_1', 0, false);
      expect(impact).toBe('critical');
    });

    it('should return critical for high user impact on customer-facing', () => {
      const impact = PriorityCalculator.calculateImpact('tier_3', 2000, true);
      expect(impact).toBe('critical');
    });

    it('should return high for tier_2 services', () => {
      const impact = PriorityCalculator.calculateImpact('tier_2', 0, false);
      expect(impact).toBe('high');
    });

    it('should return low for tier_4 services with no users', () => {
      const impact = PriorityCalculator.calculateImpact('tier_4', 0, false);
      expect(impact).toBe('low');
    });
  });

  describe('calculateUrgency', () => {
    it('should return critical for service in outage during business hours with high SLA', () => {
      const urgency = PriorityCalculator.calculateUrgency('outage', 99.9, true);
      expect(urgency).toBe('critical');
    });
    it('should return high for a service in outage with medium SLA', () => {
      const urgency = PriorityCalculator.calculateUrgency('outage', 99.0, true);
      expect(urgency).toBe('high');
    });


    it('should return high for service degraded with high SLA', () => {
      const urgency = PriorityCalculator.calculateUrgency('degraded', 99.9, true);
      expect(urgency).toBe('high');
    });

    it('should return medium for service degraded outside business hours', () => {
      const urgency = PriorityCalculator.calculateUrgency('degraded', 99.0, false);
      expect(urgency).toBe('medium');
    });

    it('should return medium for operational service outside business hours', () => {
      // When isBusinessHours is false, the condition `!isBusinessHours` is true,
      // so urgency returns 'medium' (not 'low')
      const urgency = PriorityCalculator.calculateUrgency('operational', 95.0, false);
      expect(urgency).toBe('medium');
    });

    it('should return low for operational service during business hours', () => {
      const urgency = PriorityCalculator.calculateUrgency('operational', 95.0, true);
      expect(urgency).toBe('low');
    });
  });

  describe('requiresEscalation', () => {
    it('should require escalation for P1', () => {
      expect(PriorityCalculator.requiresEscalation(1)).toBe(true);
    });

    it('should not require escalation for P2', () => {
      expect(PriorityCalculator.requiresEscalation(2)).toBe(false);
    });

    it('should not require escalation for P5', () => {
      expect(PriorityCalculator.requiresEscalation(5)).toBe(false);
    });
  });

  describe('getRecommendedResponseTime', () => {
    it('should return 15 minutes for P1', () => {
      expect(PriorityCalculator.getRecommendedResponseTime(1)).toBe(15);
    });

    it('should return 60 minutes for P2', () => {
      expect(PriorityCalculator.getRecommendedResponseTime(2)).toBe(60);
    });

    it('should return 1440 minutes for P5', () => {
      expect(PriorityCalculator.getRecommendedResponseTime(5)).toBe(1440);
    });
  });

  describe('getRecommendedResponseTeam', () => {
    it('should include incident commander for P1', () => {
      const teams = PriorityCalculator.getRecommendedResponseTeam(1, 'john@example.com', 'l2');
      expect(teams).toContain('Incident Commander');
      expect(teams.length).toBeGreaterThan(3);
    });

    it('should include service owner for P2', () => {
      const teams = PriorityCalculator.getRecommendedResponseTeam(2, 'john@example.com', 'l2');
      expect(teams).toContain('Service Owner: john@example.com');
    });

    it('should only include L1 support for P5', () => {
      const teams = PriorityCalculator.getRecommendedResponseTeam(5, 'john@example.com', 'l1');
      expect(teams).toEqual(['L1 Support']);
    });
  });

  describe('estimateCostOfDowntime', () => {
    it('should calculate hourly cost correctly', () => {
      const annualRevenue = 10000000; // $10M
      const cost = PriorityCalculator.estimateCostOfDowntime(annualRevenue, 2080);
      expect(cost).toBeCloseTo(4807.69, 1);
    });

    it('should handle zero revenue', () => {
      const cost = PriorityCalculator.estimateCostOfDowntime(0);
      expect(cost).toBe(0);
    });
  });

  describe('isBusinessHours', () => {
    it('should return true for 24x7 services', () => {
      const serviceHours = {
        availability: '24x7' as const,
        timezone: 'UTC',
        maintenance_windows: [],
      };
      expect(PriorityCalculator.isBusinessHours(serviceHours)).toBe(true);
    });

    it('should return true for Monday during 24x5', () => {
      const serviceHours = {
        availability: '24x5' as const,
        timezone: 'UTC',
        maintenance_windows: [],
      };
      const monday = new Date('2025-01-06T10:00:00Z'); // Monday
      expect(PriorityCalculator.isBusinessHours(serviceHours, monday)).toBe(true);
    });

    it('should return false for Saturday during 24x5', () => {
      const serviceHours = {
        availability: '24x5' as const,
        timezone: 'UTC',
        maintenance_windows: [],
      };
      const saturday = new Date('2025-01-11T10:00:00Z'); // Saturday
      expect(PriorityCalculator.isBusinessHours(serviceHours, saturday)).toBe(false);
    });
  });
});
