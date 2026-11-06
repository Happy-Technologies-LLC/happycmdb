// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Cypher Security Validators
 *
 * Provides validation functions to prevent Cypher injection attacks in Neo4j queries
 * by whitelisting node labels, relationship types, and property names.
 *
 * IMPORTANT: These validators should ONLY be used for identifiers (labels, types, properties)
 * that cannot be safely parameterized. All user data MUST use parameterized queries.
 */

/**
 * Valid Neo4j node labels in the CMDB schema
 */
export const VALID_NODE_LABELS = [
  'CI',
  'server',
  'virtual_machine',
  'container',
  'application',
  'service',
  'database',
  'network_device',
  'storage',
  'load_balancer',
  'cloud_resource',
  'kubernetes_cluster',
  'kubernetes_node',
  'kubernetes_pod',
  'agent_release',
  'ai_model',
  'cell',
  'ai_deployment',
] as const;

/**
 * Valid Neo4j relationship types: the same values as the TS RelationshipType (types/ci.types RELATIONSHIP_TYPES),
 * kept as its own list here so the Cypher allowlist is explicit; a unit test compares the two.
 */
export const VALID_RELATIONSHIP_TYPES = [
  'DEPENDS_ON',
  'HOSTS',
  'CONNECTS_TO',
  'USES',
  'OWNED_BY',
  'MANAGES',
  'MONITORS',
  'PART_OF',
  'RUNS_ON',
  'CONTAINS',
  'ROUTES_TO',
  'BACKED_UP_BY',
  'LOCATED_IN',
  'DEPLOYED_ON',
  'DETECTED_ON',
  'AFFECTS',
  'INSTALLED_ON',
  'ASSIGNED_TO',
  'APPLIES_TO',
  'MEMBER_OF',
  'REQUIRED_BY',
  'HOSTED_ON',
  'INSTANCE_OF',
] as const;

/**
 * Valid CI property names for Neo4j queries
 */
export const VALID_CI_PROPERTIES = [
  'id',
  'external_id',
  'name',
  'type',
  'status',
  'environment',
  'created_at',
  'updated_at',
  'discovered_at',
  'discovery_provider',
  'metadata',
] as const;

/**
 * Validate Neo4j node label
 * @param label - Node label to validate
 * @returns Validated label
 * @throws Error if label is not in whitelist
 */
export function validateNodeLabel(label: string): string {
  // Convert kebab-case to snake_case for validation
  const normalizedLabel = label.replace(/-/g, '_');

  if (!VALID_NODE_LABELS.includes(normalizedLabel as any)) {
    throw new Error(`Invalid node label: ${label}. Must be one of: ${VALID_NODE_LABELS.join(', ')}`);
  }

  return normalizedLabel;
}

/**
 * Validate Neo4j relationship type
 * @param relType - Relationship type to validate
 * @returns Validated relationship type
 * @throws Error if relationship type is not in whitelist
 */
export function validateRelationshipType(relType: string): string {
  const upperRelType = relType.toUpperCase().replace(/-/g, '_');

  if (!VALID_RELATIONSHIP_TYPES.includes(upperRelType as any)) {
    throw new Error(`Invalid relationship type: ${relType}. Must be one of: ${VALID_RELATIONSHIP_TYPES.join(', ')}`);
  }

  return upperRelType;
}

/**
 * Validate CI property name
 * @param propertyName - Property name to validate
 * @returns Validated property name
 * @throws Error if property name is not in whitelist
 */
export function validateCIProperty(propertyName: string): string {
  if (!VALID_CI_PROPERTIES.includes(propertyName as any)) {
    throw new Error(`Invalid property name: ${propertyName}. Must be one of: ${VALID_CI_PROPERTIES.join(', ')}`);
  }

  return propertyName;
}

/**
 * Escape Cypher identifier (label, property name)
 * This should ONLY be used as a last resort when whitelist validation is not possible
 * @param identifier - Identifier to escape
 * @returns Escaped identifier wrapped in backticks
 */
export function escapeCypherIdentifier(identifier: string): string {
  // Replace backticks with escaped backticks
  const escaped = identifier.replace(/`/g, '``');
  return `\`${escaped}\``;
}

/**
 * Sanitize CI type for use as Neo4j label
 * Converts kebab-case to snake_case and validates against whitelist
 * @param ciType - CI type string (e.g., "virtual-machine")
 * @returns Sanitized type suitable for use as Neo4j label
 */
export function sanitizeCITypeForLabel(ciType: string): string {
  // Convert to snake_case
  const sanitized = ciType.replace(/-/g, '_').toLowerCase();

  // Validate against whitelist
  return validateNodeLabel(sanitized);
}

/**
 * Check if string contains potential Cypher injection patterns
 * This is a defense-in-depth measure, not a replacement for parameterized queries
 * @param input - String to check
 * @returns True if suspicious patterns detected
 */
export function containsCypherInjectionPatterns(input: string): boolean {
  const patterns = [
    /;/,                     // Statement terminator
    /\/\//,                  // Cypher comment
    /\/\*/,                  // Multi-line comment start
    /\*\//,                  // Multi-line comment end
    /\bDROP\b/i,            // DROP statement
    /\bDELETE\b/i,          // DELETE statement
    /\bDETACH\b/i,          // DETACH DELETE
    /\bREMOVE\b/i,          // REMOVE statement
    /\bCALL\b.*\bdb\./i,    // Database procedure calls
    /\bCALL\b.*\bapoc\./i,  // APOC procedure calls
    /\bLOAD\b.*\bCSV\b/i,   // LOAD CSV (potential file access)
  ];

  return patterns.some(pattern => pattern.test(input));
}

/**
 * Build safe Cypher label string for CREATE/MATCH statements
 * @param ciType - CI type to convert to label
 * @returns Safe label string with CI base label and type-specific label
 * @example buildSafeCypherLabel('virtual-machine') => ':CI:virtual_machine'
 */
export function buildSafeCypherLabel(ciType: string): string {
  const validatedType = sanitizeCITypeForLabel(ciType);
  return `:CI:${validatedType}`;
}
