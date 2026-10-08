// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * GraphQL Schema for Identity Reconciliation
 */

export const reconciliationTypeDefs = `
  """
  Match result from identity resolution
  """
  type MatchResult {
    """Matched CI ID"""
    _ciId: ID!
    """Match confidence score (0-100)"""
    _confidence: Int!
    """Strategy used for matching"""
    _matchStrategy: String!
    """Attributes that matched"""
    _matchedAttributes: [String!]!
  }

  """
  Identification attributes for matching CIs
  """
  input IdentificationAttributesInput {
    """External ID from source system"""
    _externalId: String
    """Hardware serial number"""
    _serialNumber: String
    """UUID/GUID"""
    _uuid: String
    """MAC addresses"""
    _macAddress: [String!]
    """Fully qualified domain name"""
    _fqdn: String
    """Hostname"""
    _hostname: String
    """IP addresses"""
    _ipAddress: [String!]
  }

  """
  Reconciliation conflict types
  """
  enum ConflictType {
    DUPLICATE_CI
    FIELD_CONFLICT
    IDENTITY_MISMATCH
  }

  """
  Conflict status
  """
  enum ConflictStatus {
    PENDING
    RESOLVED
    DISMISSED
  }

  """
  Reconciliation conflict
  """
  type ReconciliationConflict {
    """Conflict ID"""
    _id: ID!
    """Related CI ID"""
    _ciId: ID
    """Type of conflict"""
    _conflictType: ConflictType!
    """Source data"""
    _sourceData: JSON!
    """Target data"""
    _targetData: JSON
    """Fields in conflict"""
    _conflictingFields: [String!]!
    """Current status"""
    _status: ConflictStatus!
    """Creation timestamp"""
    _createdAt: String!
  }

  """
  Match type enumeration
  """
  enum MatchType {
    EXACT
    FUZZY
    COMPOSITE
  }

  """
  Identification rule
  """
  type IdentificationRule {
    """Attribute name"""
    _attribute: String!
    """Priority (1 = highest)"""
    _priority: Int!
    """Match type"""
    _matchType: MatchType!
    """Confidence score for this match (0-100)"""
    _matchConfidence: Int!
    """Fuzzy match threshold (0-100)"""
    _fuzzyThreshold: Int
  }

  """
  Identification rule input
  """
  input IdentificationRuleInput {
    """Attribute name"""
    _attribute: String!
    """Priority (1 = highest)"""
    _priority: Int!
    """Match type"""
    _matchType: MatchType!
    """Confidence score for this match (0-100)"""
    _matchConfidence: Int!
    """Fuzzy match threshold (0-100)"""
    _fuzzyThreshold: Int
  }

  """
  Merge strategy types
  """
  enum MergeStrategy {
    HIGHEST_AUTHORITY
    MOST_RECENT
    AGGREGATE
    MANUAL_REVIEW
  }

  """
  Field merge rule
  """
  type FieldMergeRule {
    """Field name"""
    _fieldName: String!
    """Merge strategy"""
    _strategy: MergeStrategy!
    """Conflict threshold (0-100)"""
    _conflictThreshold: Int
  }

  """
  Field merge rule input
  """
  input FieldMergeRuleInput {
    """Field name"""
    _fieldName: String!
    """Merge strategy"""
    _strategy: MergeStrategy!
    """Conflict threshold (0-100)"""
    _conflictThreshold: Int
  }

  """
  Reconciliation rule configuration
  """
  type ReconciliationRule {
    """Rule ID"""
    _id: ID!
    """Rule name"""
    _name: String!
    """Identification rules"""
    _identificationRules: [IdentificationRule!]!
    """Merge strategies"""
    _mergeStrategies: [FieldMergeRule!]!
    """Whether rule is enabled"""
    _enabled: Boolean!
    """Creation timestamp"""
    _createdAt: String!
    """Last update timestamp"""
    _updatedAt: String!
  }

  """
  Source authority
  """
  type SourceAuthority {
    """Source system name"""
    _sourceName: String!
    """Authority score (1-10, higher = more authoritative)"""
    _authorityScore: Int!
    """Description"""
    _description: String
  }

  """
  Source lineage entry
  """
  type SourceLineage {
    """Source system name"""
    _sourceName: String!
    """External ID in source system"""
    _sourceId: String!
    """Confidence score (0-100)"""
    _confidenceScore: Int!
    """First seen timestamp"""
    _firstSeenAt: String!
    """Last seen timestamp"""
    _lastSeenAt: String!
  }

  """
  CI source lineage
  """
  type CILineage {
    """CI ID"""
    _ciId: ID!
    """Contributing sources"""
    _sources: [SourceLineage!]!
  }

  """
  Field source attribution
  """
  type FieldSource {
    """Field name"""
    _fieldName: String!
    """Field value"""
    _fieldValue: String!
    """Source system name"""
    _sourceName: String!
    """Last update timestamp"""
    _updatedAt: String!
  }

  """
  CI field sources
  """
  type CIFieldSources {
    """CI ID"""
    _ciId: ID!
    """Field sources"""
    _fields: [FieldSource!]!
  }

  """
  Merge result
  """
  type MergeResult {
    """Success flag"""
    _success: Boolean!
    """Resulting CI ID"""
    _ciId: ID!
    """Action taken (updated existing CI)"""
    _action: String!
    """Merged field names"""
    _mergedFields: [String!]
    """Conflicts encountered"""
    _conflicts: [ReconciliationConflict!]
  }

  """
  Input for creating reconciliation rule
  """
  input CreateReconciliationRuleInput {
    """Rule name"""
    _name: String!
    """Identification rules"""
    _identificationRules: [IdentificationRuleInput!]!
    """Merge strategies"""
    _mergeStrategies: [FieldMergeRuleInput!]
    """Whether rule is enabled"""
    _enabled: Boolean
  }

  """
  Input for updating source authority
  """
  input UpdateSourceAuthorityInput {
    """Source system name"""
    _sourceName: String!
    """Authority score (1-10)"""
    _authorityScore: Int!
    """Description"""
    _description: String
  }

  """
  Reconciliation query operations
  """
  type ReconciliationQuery {
    """Find matching CIs based on identification attributes"""
    findMatches(
      """Identification attributes"""
      _identifiers: IdentificationAttributesInput!
      """Source system"""
      _source: String
    ): MatchResult

    """List reconciliation conflicts"""
    listConflicts(
      """Filter by status"""
      _status: ConflictStatus
      """Result limit"""
      _limit: Int
      """Result offset"""
      _offset: Int
    ): [ReconciliationConflict!]!

    """Get reconciliation rules"""
    getRules: [ReconciliationRule!]!

    """Get source authorities"""
    getSourceAuthorities: [SourceAuthority!]!

    """Get CI source lineage"""
    getCILineage(
      """CI ID"""
      _ciId: ID!
    ): CILineage

    """Get CI field sources"""
    getCIFieldSources(
      """CI ID"""
      _ciId: ID!
    ): CIFieldSources
  }

  """
  Reconciliation mutation operations
  """
  type ReconciliationMutation {
    """Merge an existing caller-owned CI; foreign, NULL-org and missing targets share NOT_FOUND"""
    mergeCI(
      """CI name"""
      _name: String!
      """CI type"""
      _ciType: String!
      """Source system"""
      _source: String!
      """Source ID"""
      _sourceId: String!
      """Identification attributes"""
      _identifiers: IdentificationAttributesInput!
      """Additional attributes"""
      _attributes: JSON
      """Confidence score (0-100)"""
      _confidenceScore: Int
      """Environment"""
      _environment: String
      """Status"""
      _status: String
    ): MergeResult!

    """Resolve a reconciliation conflict"""
    resolveConflict(
      """Conflict ID"""
      _id: ID!
      """Resolution action"""
      _resolution: String!
      """Merged data (for merge resolution)"""
      _mergedData: JSON
    ): ReconciliationConflict!

    """Create a reconciliation rule"""
    createRule(
      """Rule configuration"""
      _input: CreateReconciliationRuleInput!
    ): ReconciliationRule!

    """Update source authority"""
    updateSourceAuthority(
      """Source authority configuration"""
      _input: UpdateSourceAuthorityInput!
    ): SourceAuthority!
  }

  extend type Query {
    """Identity reconciliation operations"""
    _reconciliation: ReconciliationQuery!
  }

  extend type Mutation {
    """Identity reconciliation mutations"""
    _reconciliation: ReconciliationMutation!
  }
`;
