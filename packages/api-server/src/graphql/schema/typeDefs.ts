// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/graphql/schema/typeDefs.ts

export const typeDefs = `
  """
  Configuration Item (CI) - Core entity representing any managed component
  """
  type CI {
    """Unique identifier"""
    _id: ID!
    """External identifier from source system"""
    _externalId: String
    """Human-readable name"""
    _name: String!
    """CI type/category"""
    _type: CIType!
    """Operational status"""
    _status: CIStatus!
    """Deployment environment"""
    _environment: Environment
    """Creation timestamp"""
    _createdAt: String!
    """Last update timestamp"""
    _updatedAt: String!
    """Discovery timestamp"""
    _discoveredAt: String!
    """Additional metadata"""
    _metadata: JSON
    """Outgoing relationships"""
    _relationships: [RelatedCI!]!
    """Incoming relationships"""
    _dependents: [RelatedCI!]!
    """All dependencies (recursive)"""
    _dependencies: [CI!]!
  }

  """
  Related CI with relationship information
  """
  type RelatedCI {
    """Relationship type"""
    _type: String!
    """Related configuration item"""
    _ci: CI!
    """Relationship properties"""
    _properties: JSON
  }

  """
  Impact analysis result
  """
  type ImpactResult {
    """Impacted configuration item"""
    _ci: CI!
    """Distance from source CI"""
    _distance: Int!
  }

  """
  CI Type enumeration
  """
  enum CIType {
    SERVER
    VIRTUAL_MACHINE
    CONTAINER
    APPLICATION
    SERVICE
    DATABASE
    NETWORK_DEVICE
    STORAGE
    LOAD_BALANCER
    CLOUD_RESOURCE
  }

  """
  CI Status enumeration
  """
  enum CIStatus {
    ACTIVE
    INACTIVE
    MAINTENANCE
    DECOMMISSIONED
  }

  """
  Environment enumeration
  """
  enum Environment {
    PRODUCTION
    STAGING
    DEVELOPMENT
    TEST
  }

  """
  Relationship type enumeration
  """
  enum RelationshipType {
    DEPENDS_ON
    HOSTS
    CONNECTS_TO
    USES
    OWNED_BY
    PART_OF
    DEPLOYED_ON
    BACKED_UP_BY
  }

  """
  Input for creating a new CI
  """
  input CreateCIInput {
    """Unique identifier"""
    _id: ID!
    """External identifier"""
    _externalId: String
    """Name of the CI"""
    _name: String!
    """CI type"""
    _type: CIType!
    """Status (defaults to ACTIVE)"""
    _status: CIStatus
    """Environment"""
    _environment: Environment
    """Discovery timestamp"""
    _discoveredAt: String
    """Additional metadata"""
    _metadata: JSON
  }

  """
  Input for updating an existing CI
  """
  input UpdateCIInput {
    """Name of the CI"""
    _name: String
    """Status"""
    _status: CIStatus
    """Environment"""
    _environment: Environment
    """Additional metadata"""
    _metadata: JSON
  }

  """
  Input for creating a relationship
  """
  input CreateRelationshipInput {
    """Source CI ID"""
    _fromId: ID!
    """Target CI ID"""
    _toId: ID!
    """Relationship type"""
    _type: RelationshipType!
    """Additional properties"""
    _properties: JSON
  }

  """
  Search filters for CIs
  """
  input SearchCIFilter {
    """Filter by CI type"""
    _type: CIType
    """Filter by status"""
    _status: CIStatus
    """Filter by environment"""
    _environment: Environment
    """Filter by name (partial match)"""
    _name: String
  }

  """
  Custom JSON scalar type
  """
  scalar JSON

  """
  Custom DateTime scalar type (ISO-8601 string)
  """
  scalar DateTime

  """
  Query operations
  """
  type Query {
    """Get all CIs with optional filtering"""
    getCIs(filter: SearchCIFilter, limit: Int, offset: Int): [CI!]!

    """Get a single CI by ID"""
    getCI(id: ID!): CI

    """Search CIs by various criteria"""
    searchCIs(query: String!, filter: SearchCIFilter, limit: Int): [CI!]!

    """Get relationships for a specific CI"""
    getCIRelationships(id: ID!, direction: String): [RelatedCI!]!

    """Get all dependencies for a CI (recursive)"""
    getCIDependencies(id: ID!, depth: Int): [CI!]!

    """Perform impact analysis for a CI"""
    getImpactAnalysis(id: ID!, depth: Int): [ImpactResult!]!
  }

  """
  Mutation operations
  """
  type Mutation {
    """Create a new CI"""
    createCI(input: CreateCIInput!): CI!

    """Update an existing CI"""
    updateCI(id: ID!, input: UpdateCIInput!): CI!

    """Delete a CI"""
    deleteCI(id: ID!): Boolean!

    """Create a relationship between two CIs"""
    createRelationship(input: CreateRelationshipInput!): Boolean!

    """Delete a relationship between two CIs"""
    deleteRelationship(fromId: ID!, toId: ID!, type: RelationshipType!): Boolean!
  }
`;
