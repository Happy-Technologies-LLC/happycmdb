// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/graphql/schema/tbm.schema.ts

export const tbmTypeDefs = `
# TBM (Technology Business Management) v5.0.1 GraphQL Schema Extension

# ============================================================================
# TBM Configuration Item Extensions
# ============================================================================

extend type CI {
  """TBM cost attributes for this configuration item"""
  tbmAttributes: TBMAttributes
}

"""TBM attributes for configuration items"""
type TBMAttributes {
  """TBM resource tower classification"""
  resourceTower: TBMResourceTower!

  """Sub-tower for more specific categorization"""
  subTower: String

  """Cost pool assignment"""
  costPool: TBMCostPool!

  """Monthly cost in USD"""
  monthlyCost: Float!

  """Cost allocation method"""
  costAllocationMethod: AllocationMethod!

  """Depreciation schedule for on-premise assets"""
  depreciationSchedule: DepreciationSchedule
}

"""TBM Resource Tower classifications"""
enum TBMResourceTower {
  COMPUTE
  STORAGE
  NETWORK
  DATA
  SECURITY
  END_USER
  FACILITIES
  RISK_COMPLIANCE
  IOT
  BLOCKCHAIN
  QUANTUM
}

"""TBM Cost Pool categories"""
enum TBMCostPool {
  LABOR_INTERNAL
  LABOR_EXTERNAL
  HARDWARE
  SOFTWARE
  CLOUD
  OUTSIDE_SERVICES
  FACILITIES
  TELECOM
}

"""Cost allocation method"""
enum AllocationMethod {
  DIRECT
  USAGE_BASED
  EQUAL
}

"""Depreciation schedule for on-premise assets"""
type DepreciationSchedule {
  purchaseDate: String!
  purchaseCost: Float!
  usefulLifeMonths: Int!
  residualValue: Float!
  depreciationMethod: DepreciationMethod!
}

"""Depreciation calculation method"""
enum DepreciationMethod {
  STRAIGHT_LINE
  DECLINING_BALANCE
}

# ============================================================================
# Cost Summary Types
# ============================================================================

"""Overall cost summary"""
type CostSummary {
  """Total monthly cost across all CIs"""
  totalMonthlyCost: Float!

  """Total number of CIs with cost data"""
  totalCIs: Int!

  """Cost breakdown by tower"""
  costByTower: [TowerCost!]!

  """Currency code"""
  currency: String!

  """Timestamp of this summary"""
  timestamp: String!
}

"""Cost breakdown by tower"""
type TowerCost {
  """Tower name"""
  tower: TBMResourceTower!

  """Sub-tower name"""
  subTower: String

  """Cost pool"""
  costPool: TBMCostPool

  """Total cost for this tower"""
  totalCost: Float!

  """Number of CIs in this tower"""
  ciCount: Int!

  """Top 10 most expensive CIs in this tower"""
  topCIs: [TowerCIRef!]
}

"""CI reference in tower cost breakdown"""
type TowerCIRef {
  id: ID!
  name: String!
  cost: Float!
}

"""Cost breakdown by business capability"""
type CapabilityCost {
  """Capability ID"""
  capabilityId: ID!

  """Capability name"""
  capabilityName: String!

  """Total monthly cost"""
  totalMonthlyCost: Float!

  """Number of supporting CIs"""
  ciCount: Int!

  """Number of supporting business services"""
  supportingServices: Int!

  """Cost breakdown by tower"""
  costByTower: [TowerCost!]
}

"""Cost breakdown by business service"""
type BusinessServiceCost {
  """Service ID"""
  serviceId: ID!

  """Service name"""
  serviceName: String!

  """Total monthly cost"""
  totalMonthlyCost: Float!

  """Number of supporting CIs"""
  ciCount: Int!

  """Towers supporting this service"""
  towers: [TBMResourceTower!]!

  """Cost per user (if user count available)"""
  costPerUser: Float

  """Cost per transaction (if transaction count available)"""
  costPerTransaction: Float
}

"""Monthly cost trend data point"""
type MonthlyCostData {
  """Month identifier"""
  month: String!

  """Total cost for the month"""
  totalCost: Float!

  """Number of CIs tracked"""
  ciCount: Int!
}

# ============================================================================
# Cost Allocation Types
# ============================================================================

"""Cost allocation result"""
type CostAllocationResult {
  """Source CI ID"""
  sourceId: ID!

  """Total cost being allocated"""
  totalCost: Float!

  """Allocation method used"""
  allocationMethod: AllocationMethod!

  """Individual allocations"""
  allocations: [CostAllocation!]!
}

"""Individual cost allocation"""
type CostAllocation {
  """Target ID (service, capability, or application)"""
  targetId: ID!

  """Allocated cost amount"""
  allocatedCost: Float!

  """Percentage of total cost"""
  allocationPercentage: Float!

  """Weight used (for usage-based allocation)"""
  weight: Float
}

"""Cost allocation history for a CI"""
type CIAllocationHistory {
  """CI ID"""
  ciId: ID!

  """Total allocated cost"""
  totalAllocatedCost: Float!

  """All allocations for this CI"""
  allocations: [CostAllocation!]!
}

# ============================================================================
# License Management Types
# ============================================================================

"""Software license information"""
type SoftwareLicense {
  """License ID"""
  id: ID!

  """Software/product name"""
  name: String!

  """Vendor name"""
  vendor: String

  """License type"""
  licenseType: String

  """License status"""
  licenseStatus: LicenseStatus

  """Expiry date"""
  licenseExpiryDate: String

  """Renewal date"""
  renewalDate: String

  """Monthly cost"""
  monthlyCost: Float!

  """Number of licenses"""
  licenseCount: Int

  """Compliance status"""
  complianceStatus: ComplianceStatus
}

"""License status"""
enum LicenseStatus {
  ACTIVE
  EXPIRED
  EXPIRING_SOON
  CANCELLED
}

"""Compliance status for licenses"""
enum ComplianceStatus {
  COMPLIANT
  OVER_LICENSED
  UNDER_LICENSED
  UNKNOWN
}

# ============================================================================
# Query Extensions
# ============================================================================

extend type Query {
  # Cost Summary Queries
  """Get overall cost summary"""
  costSummary: CostSummary!

  """Get cost breakdown by tower"""
  costsByTower(tower: TBMResourceTower): [TowerCost!]!

  """Get cost breakdown by business capability"""
  costsByCapability(id: ID!): CapabilityCost!

  """Get cost breakdown by business service"""
  costsByBusinessService(id: ID!): BusinessServiceCost!

  """Get cost trends over time"""
  costTrends(months: Int = 6): [MonthlyCostData!]!

  # Cost Allocation Queries
  """Get cost allocations for a CI"""
  costAllocations(ciId: ID!): CIAllocationHistory!

  # License Management Queries
  """Get all software licenses when the bounded read proves completeness; otherwise SERVICE_UNAVAILABLE"""
  licenses(vendor: String, status: LicenseStatus): [SoftwareLicense!]!

  """Get upcoming license renewals when the bounded read proves completeness; otherwise SERVICE_UNAVAILABLE"""
  upcomingRenewals(days: Int = 90): [SoftwareLicense!]!
}

# ============================================================================
# Mutation Extensions
# ============================================================================

extend type Mutation {
  # Cost Allocation Mutations
  """Allocate costs from a source CI to target services/capabilities"""
  allocateCosts(input: AllocateCostsInput!): CostAllocationResult!

  # GL Import
  """Import general ledger cost data"""
  importGLData(file: Upload): GLImportResult!
}

# ============================================================================
# Input Types
# ============================================================================

"""Input for cost allocation"""
input AllocateCostsInput {
  """Source CI ID to allocate from"""
  sourceId: ID!

  """Target type (business_service, business_capability, application_service)"""
  targetType: String!

  """Target IDs to allocate to"""
  targetIds: [ID!]!

  """Allocation method"""
  allocationMethod: AllocationMethod = USAGE_BASED

  """Allocation rules (weights for usage-based)"""
  allocationRules: JSON
}

# ============================================================================
# Result Types
# ============================================================================

"""GL import result"""
type GLImportResult {
  """Import was successful"""
  success: Boolean!

  """Number of records imported"""
  recordsImported: Int

  """Error message if failed"""
  errorMessage: String
}

# ============================================================================
# Scalar Types
# ============================================================================

"""JSON scalar type for arbitrary JSON data"""
scalar JSON

"""File upload scalar type"""
scalar Upload
`;
