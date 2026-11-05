// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for Cypher injection prevention validators
 */

import {
  validateNodeLabel,
  validateRelationshipType,
  validateCIProperty,
  sanitizeCITypeForLabel,
  buildSafeCypherLabel,
  containsCypherInjectionPatterns,
  escapeCypherIdentifier,
  VALID_RELATIONSHIP_TYPES,
} from '../cypher-validators';
import { RELATIONSHIP_TYPES } from '../../types/ci.types';

describe('Cypher Validators - Cypher Injection Prevention', () => {
  describe('validateNodeLabel', () => {
    it('should accept valid node labels', () => {
      expect(validateNodeLabel('CI')).toBe('CI');
      expect(validateNodeLabel('server')).toBe('server');
      expect(validateNodeLabel('virtual_machine')).toBe('virtual_machine');
      expect(validateNodeLabel('container')).toBe('container');
    });

    it('should accept kebab-case and convert to snake_case', () => {
      expect(validateNodeLabel('virtual-machine')).toBe('virtual_machine');
      expect(validateNodeLabel('network-device')).toBe('network_device');
    });

    it('should reject invalid node labels', () => {
      expect(() => validateNodeLabel('malicious_label')).toThrow('Invalid node label');
      expect(() => validateNodeLabel('User')).toThrow('Invalid node label');
    });

    it('should prevent Cypher injection attempts', () => {
      const attacks = [
        "CI' OR 1=1",
        'CI; DETACH DELETE (n)',
        'CI)--[r]->()',
        "CI'; MATCH (n) DELETE n; //",
      ];

      attacks.forEach(attack => {
        expect(() => validateNodeLabel(attack)).toThrow('Invalid node label');
      });
    });
  });

  describe('validateRelationshipType', () => {
    it('should accept valid relationship types', () => {
      expect(validateRelationshipType('DEPENDS_ON')).toBe('DEPENDS_ON');
      expect(validateRelationshipType('HOSTS')).toBe('HOSTS');
      expect(validateRelationshipType('CONNECTS_TO')).toBe('CONNECTS_TO');
    });

    it('should convert to uppercase', () => {
      expect(validateRelationshipType('depends_on')).toBe('DEPENDS_ON');
      expect(validateRelationshipType('hosts')).toBe('HOSTS');
    });

    it('should reject invalid relationship types', () => {
      expect(() => validateRelationshipType('MALICIOUS_REL')).toThrow('Invalid relationship type');
      expect(() => validateRelationshipType('CUSTOM_REL')).toThrow('Invalid relationship type');
    });

    it('should prevent Cypher injection in relationships', () => {
      const attacks = [
        "DEPENDS_ON]->(n) DELETE n; MATCH ()-[r:",
        "HOSTS; DETACH DELETE (n)",
        "CONNECTS_TO]-(x) WHERE x.password",
      ];

      attacks.forEach(attack => {
        expect(() => validateRelationshipType(attack)).toThrow('Invalid relationship type');
      });
    });

    it('HAP-1442 S5: the TS RelationshipType values and VALID_RELATIONSHIP_TYPES list the same types, INSTANCE_OF included', () => {
      expect([...RELATIONSHIP_TYPES].sort()).toEqual([...VALID_RELATIONSHIP_TYPES].sort());
      expect(VALID_RELATIONSHIP_TYPES).toContain('INSTANCE_OF');
    });
  });

  describe('validateCIProperty', () => {
    it('should accept valid CI properties', () => {
      expect(validateCIProperty('id')).toBe('id');
      expect(validateCIProperty('name')).toBe('name');
      expect(validateCIProperty('type')).toBe('type');
      expect(validateCIProperty('created_at')).toBe('created_at');
    });

    it('should reject invalid properties', () => {
      expect(() => validateCIProperty('password')).toThrow('Invalid property name');
      expect(() => validateCIProperty('malicious_prop')).toThrow('Invalid property name');
    });
  });

  describe('sanitizeCITypeForLabel', () => {
    it('should convert kebab-case to snake_case', () => {
      expect(sanitizeCITypeForLabel('virtual-machine')).toBe('virtual_machine');
      expect(sanitizeCITypeForLabel('network-device')).toBe('network_device');
      expect(sanitizeCITypeForLabel('load-balancer')).toBe('load_balancer');
    });

    it('should validate the sanitized label', () => {
      expect(() => sanitizeCITypeForLabel('malicious-type')).toThrow('Invalid node label');
    });

    it('should handle already snake_case types', () => {
      expect(sanitizeCITypeForLabel('server')).toBe('server');
      expect(sanitizeCITypeForLabel('container')).toBe('container');
    });
  });

  describe('buildSafeCypherLabel', () => {
    it('should build valid label strings with CI base label', () => {
      expect(buildSafeCypherLabel('virtual-machine')).toBe(':CI:virtual_machine');
      expect(buildSafeCypherLabel('server')).toBe(':CI:server');
      expect(buildSafeCypherLabel('container')).toBe(':CI:container');
    });

    it('should validate the CI type before building label', () => {
      expect(() => buildSafeCypherLabel('malicious-type')).toThrow('Invalid node label');
    });
  });

  describe('containsCypherInjectionPatterns', () => {
    it('should detect Cypher injection patterns', () => {
      const injections = [
        "'; MATCH (n) DETACH DELETE n; //",
        "id: $id }) DELETE (ci",
        "}) CALL db.index.fulltext.drop('ci_search')",
        "LOAD CSV FROM 'file:///etc/passwd'",
        "; DETACH DELETE (n)",
        "/* malicious comment */ DROP INDEX",
      ];

      injections.forEach(injection => {
        expect(containsCypherInjectionPatterns(injection)).toBe(true);
      });
    });

    it('should not flag safe Cypher query fragments', () => {
      const safeStrings = [
        'virtual-machine-01',
        'production-server',
        'container:nginx',
        'app/service',
      ];

      safeStrings.forEach(safe => {
        expect(containsCypherInjectionPatterns(safe)).toBe(false);
      });
    });
  });

  describe('escapeCypherIdentifier', () => {
    it('should escape backticks in identifiers', () => {
      expect(escapeCypherIdentifier('my`label')).toBe('`my``label`');
      expect(escapeCypherIdentifier('normal_label')).toBe('`normal_label`');
    });

    it('should wrap identifiers in backticks', () => {
      const escaped = escapeCypherIdentifier('label_name');
      expect(escaped).toMatch(/^`.*`$/);
    });
  });

  describe('Real-world Cypher injection attack scenarios', () => {
    it('should prevent node deletion via label injection', () => {
      const attack = "CI)--() DELETE (ci) MATCH (malicious:";
      expect(() => validateNodeLabel(attack)).toThrow();
    });

    it('should prevent relationship manipulation', () => {
      const attack = "DEPENDS_ON]->(x) DETACH DELETE (x) MATCH ()-[r:";
      expect(() => validateRelationshipType(attack)).toThrow();
    });

    it('should prevent property-based injection', () => {
      const attack = "id }) CALL db.index.fulltext.drop('ci_search') MATCH (n {";
      expect(containsCypherInjectionPatterns(attack)).toBe(true);
    });

    it('should prevent APOC procedure calls', () => {
      const injection = "id }) CALL apoc.cypher.run('MATCH (n) DETACH DELETE n', {}) YIELD value MATCH (x {";
      expect(containsCypherInjectionPatterns(injection)).toBe(true);
    });

    it('should prevent database procedure calls', () => {
      const injection = "CALL db.constraints.drop('constraint_name')";
      expect(containsCypherInjectionPatterns(injection)).toBe(true);
    });
  });

  describe('Integration with CREATE/MATCH statements', () => {
    it('should produce safe CREATE statements', () => {
      const ciType = 'virtual-machine';
      const label = buildSafeCypherLabel(ciType);

      // Verify the label is safe to use in a CREATE statement
      expect(label).toBe(':CI:virtual_machine');
      expect(label).not.toContain(';');
      expect(label).not.toContain('--');
      expect(label).not.toContain('DROP');
      expect(label).not.toContain('DELETE');
    });

    it('should reject malicious CI types in CREATE', () => {
      const maliciousType = "server; DETACH DELETE (n); //";
      expect(() => buildSafeCypherLabel(maliciousType)).toThrow();
    });

    it('should produce safe MERGE relationship statements', () => {
      const relType = 'depends-on';
      const validatedType = validateRelationshipType(relType);

      // Verify the relationship type is safe to use
      expect(validatedType).toBe('DEPENDS_ON');
      expect(validatedType).not.toContain(']');
      expect(validatedType).not.toContain('-');
      expect(validatedType).not.toContain(';');
    });
  });

  describe('Edge cases and special characters', () => {
    it('should handle empty strings', () => {
      expect(() => validateNodeLabel('')).toThrow();
      expect(() => validateRelationshipType('')).toThrow();
    });

    it('should handle whitespace', () => {
      expect(() => validateNodeLabel('  server  ')).toThrow();
      expect(() => validateRelationshipType(' HOSTS ')).toThrow();
    });

    it('should handle case conversion correctly', () => {
      expect(validateRelationshipType('depends_on')).toBe('DEPENDS_ON');
      expect(validateRelationshipType('DEPENDS_ON')).toBe('DEPENDS_ON');
    });
  });
});
