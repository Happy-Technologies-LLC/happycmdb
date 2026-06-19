# @cmdb/unified-model

Unified data model for HappyCMDB v3.0, providing TypeScript types and runtime validators for the integration of ITIL v4, TBM v5.0.1, and Business Service Mapping (BSM) frameworks.

## Overview

HappyCMDB v3.0 introduces a **unified data model** that serves as the single source of truth for all entities across the platform. This package consolidates type definitions previously scattered across multiple packages and adds comprehensive support for three industry-standard frameworks:

- **ITIL v4** - IT Service Management practices (Configuration, Incident, Change, Problem)
- **TBM v5.0.1** - Technology Business Management cost transparency and allocation
- **BSM** - Business Service Mapping for business impact analysis

## Installation

```bash
npm install @cmdb/unified-model
# or
pnpm add @cmdb/unified-model
```

## Key Features

- **Complete TypeScript type definitions** for all v3.0 entities
- **Runtime validation** using Zod schemas
- **Service interfaces** for CRUD operations (implementation-agnostic)
- **Framework integration** - Single entity with ITIL, TBM, and BSM attributes
- **Comprehensive JSDoc documentation** with examples

## Core Entities

### 1. Configuration Item (CI)

The foundational entity representing any IT infrastructure component.

```typescript
import { ConfigurationItem } from '@cmdb/unified-model';

const webServer: ConfigurationItem = {
  id: 'ci-web-001',
  external_id: 'aws-i-0123456789abcdef0',
  name: 'Web Server - Production',
  type: 'server',

  // ITIL attributes
  itil_attributes: {
    ci_class: 'hardware',
    lifecycle_stage: 'operate',
    configuration_status: 'active',
    version: '1.0.0',
    last_audited: new Date('2025-11-01'),
    audit_status: 'compliant',
  },

  // TBM cost attributes
  tbm_attributes: {
    resource_tower: 'compute',
    sub_tower: 'Physical Servers',
    cost_pool: 'hardware',
    monthly_cost: 1500.00,
    cost_allocation_method: 'usage_based',
    depreciation_schedule: {
      purchase_date: new Date('2023-01-15'),
      purchase_cost: 50000,
      useful_life_months: 60,
      residual_value: 5000,
      depreciation_method: 'straight_line',
    },
  },

  // BSM business attributes
  bsm_attributes: {
    business_criticality: 'tier_1',
    supports_business_services: ['bs-ecommerce-001'],
    customer_facing: true,
    compliance_scope: ['PCI_DSS', 'SOX'],
    data_classification: 'confidential',
  },

  // Operational attributes
  status: 'active',
  environment: 'production',
  location: {
    datacenter: 'US-East-1',
    region: 'us-east-1',
    availability_zone: 'us-east-1a',
  },
  owner: 'john.doe@company.com',
  technical_contact: 'ops-team@company.com',

  // Discovery metadata
  discovered_by: ['aws-connector'],
  discovery_confidence: 95,
  last_discovered: new Date(),

  // Audit trail
  created_at: new Date('2023-01-15'),
  updated_at: new Date(),
  created_by: 'system',
  updated_by: 'aws-connector',

  // Flexible metadata
  metadata: {
    instance_type: 't3.large',
    cloud_provider: 'aws',
    region: 'us-east-1',
  },
};
```

### 2. Application Service

Represents an application or IT solution that enables business services.

```typescript
import { ApplicationService } from '@cmdb/unified-model';

const ecommerceApp: ApplicationService = {
  id: 'app-ecommerce-001',
  name: 'E-Commerce Platform',
  description: 'Customer-facing online store',

  // TBM IT Solution
  tbm_attributes: {
    solution_type: 'application',
    it_tower_alignment: 'Application Services',
    total_monthly_cost: 45000.00,
    cost_breakdown: {
      infrastructure: 25000,
      licenses: 10000,
      labor: 8000,
      support: 2000,
    },
  },

  // ITIL Service
  itil_attributes: {
    service_type: 'business_service',
    service_owner: 'product-team@company.com',
    lifecycle_stage: 'operate',
    release_version: '2.5.0',
    change_schedule: 'Weekly deployment window',
  },

  // Application portfolio
  application_attributes: {
    application_type: 'web_application',
    technology_stack: {
      primary_language: 'TypeScript',
      frameworks: ['React', 'Node.js', 'Express'],
      databases: ['PostgreSQL', 'Redis'],
      messaging: ['Kafka'],
      caching: ['Redis'],
      monitoring: ['Prometheus', 'Grafana'],
    },
    deployment_model: 'cloud_native',
    architecture_pattern: 'microservices',
    product_owner: 'jane.smith@company.com',
    development_team: 'Platform Team',
    vendor_product: false,
  },

  // Quality metrics
  quality_metrics: {
    code_repository: 'https://github.com/company/ecommerce',
    test_coverage_percentage: 85,
    defect_density: 0.5,
    availability_percentage: 99.95,
    response_time_p95: 150,
  },

  // Business alignment
  supports_business_services: ['bs-online-sales-001'],
  business_value_score: 92,

  // Infrastructure
  infrastructure_components: ['ci-web-001', 'ci-db-001', 'ci-cache-001'],

  created_at: new Date('2024-01-01'),
  updated_at: new Date(),
};
```

### 3. Business Service

Bridge between IT operations and business value.

```typescript
import { BusinessService } from '@cmdb/unified-model';

const customerPortal: BusinessService = {
  id: 'bs-portal-001',
  name: 'Customer Self-Service Portal',
  description: 'Online portal for customer account management',

  // ITIL Service Management
  itil_attributes: {
    service_owner: 'john.doe@company.com',
    service_type: 'customer_facing',
    service_hours: {
      availability: '24x7',
      timezone: 'UTC',
      maintenance_windows: [
        {
          day_of_week: 0, // Sunday
          start_time: '02:00',
          end_time: '04:00',
          frequency: 'weekly',
        },
      ],
    },
    sla_targets: {
      availability_percentage: 99.9,
      response_time_ms: 200,
      error_rate_percentage: 0.1,
      measured_period: 'monthly',
    },
    support_level: 'l2',
    incident_count_30d: 3,
    change_count_30d: 5,
    availability_30d: 99.95,
  },

  // TBM Cost Transparency
  tbm_attributes: {
    total_monthly_cost: 75000,
    cost_per_user: 0.60,
    cost_per_transaction: 0.05,
    cost_breakdown_by_tower: {
      compute: 30000,
      storage: 10000,
      network: 5000,
      data: 15000,
      security: 10000,
      end_user: 5000,
    },
    cost_trend: 'stable',
  },

  // Business Service Mapping
  bsm_attributes: {
    business_criticality: 'tier_1',
    capabilities_enabled: ['bc-customer-mgmt-001'],
    value_streams: ['vs-customer-experience-001'],
    business_impact_score: 85,
    risk_rating: 'high',
    annual_revenue_supported: 50000000,
    customer_count: 125000,
    transaction_volume_daily: 250000,
    compliance_requirements: [
      {
        framework: 'GDPR',
        applicable: true,
        last_audit: new Date('2025-06-01'),
        next_audit: new Date('2026-06-01'),
        compliance_status: 'compliant',
        findings_count: 0,
      },
      {
        framework: 'SOC2',
        applicable: true,
        last_audit: new Date('2025-09-01'),
        next_audit: new Date('2026-03-01'),
        compliance_status: 'compliant',
        findings_count: 1,
      },
    ],
    data_sensitivity: 'confidential',
    sox_scope: true,
    pci_scope: false,
    recovery_time_objective: 60,
    recovery_point_objective: 15,
    disaster_recovery_tier: 1,
  },

  application_services: ['app-ecommerce-001'],
  technical_owner: 'ops-team@company.com',
  platform_team: 'Platform Team',
  operational_status: 'operational',
  last_incident: new Date('2025-10-15'),

  created_at: new Date('2024-01-01'),
  updated_at: new Date(),
  last_validated: new Date('2025-11-01'),
};
```

### 4. Business Capability

Top-level business capability with full cost allocation.

```typescript
import { BusinessCapability } from '@cmdb/unified-model';

const orderManagement: BusinessCapability = {
  id: 'bc-order-mgmt-001',
  name: 'Order Management',
  description: 'End-to-end order processing capability',

  // TBM Business Layer
  tbm_attributes: {
    business_unit: 'Sales & Operations',
    total_monthly_cost: 250000.00,
    cost_per_employee: 500.00,
    budget_annual: 3000000.00,
    variance_percentage: -2.5, // 2.5% under budget
  },

  // Capability attributes
  capability_attributes: {
    capability_type: 'core',
    strategic_importance: 'critical',
    maturity_level: 'defined',
    lifecycle_stage: 'invest',
    capability_owner: 'jane.smith@company.com',
  },

  // Value attributes
  value_attributes: {
    revenue_impact: {
      direct_revenue: true,
      annual_revenue_supported: 100000000,
      customer_count_impacted: 250000,
      transaction_volume: 1000000,
    },
    customer_facing: true,
    user_count: 500,
    regulatory_requirements: ['SOX', 'GDPR'],
    competitive_advantage: true,
  },

  business_services: ['bs-portal-001', 'bs-order-processing-001'],
  key_applications: ['app-ecommerce-001', 'app-erp-001'],

  created_at: new Date('2024-01-01'),
  updated_at: new Date(),
};
```

## Runtime Validation

All entities have corresponding Zod schemas for runtime validation:

```typescript
import {
  validateConfigurationItem,
  validateConfigurationItemSafe,
  ConfigurationItemSchema,
} from '@cmdb/unified-model';

// Strict validation (throws on error)
try {
  const validCI = validateConfigurationItem(unknownData);
  console.log('Valid CI:', validCI);
} catch (error) {
  console.error('Validation failed:', error);
}

// Safe validation (returns result object)
const result = validateConfigurationItemSafe(unknownData);
if (result.success) {
  console.log('Valid CI:', result.data);
} else {
  console.error('Validation errors:', result.error.issues);
}

// Direct schema usage
const parseResult = ConfigurationItemSchema.safeParse(unknownData);
```

## Service Interfaces

The package provides TypeScript interfaces for service implementations:

```typescript
import { ICIService } from '@cmdb/unified-model';

class Neo4jCIService implements ICIService {
  async create(ci: ConfigurationItemInput): Promise<ConfigurationItem> {
    // Implementation using Neo4j
  }

  async findById(id: string): Promise<ConfigurationItem | null> {
    // Implementation
  }

  async findAll(filters?: CIFilters): Promise<ConfigurationItem[]> {
    // Implementation
  }

  async getUpstreamDependencies(id: string, depth?: number): Promise<ConfigurationItem[]> {
    // Graph traversal implementation
  }

  // ... other methods
}
```

## Type Exports

### Common Types
- `CIType`, `CIStatus`, `Environment`
- `Location`, `AuditFields`, `DiscoveryMetadata`

### ITIL Types
- `ITILCIClass`, `ITILLifecycle`, `ITILConfigStatus`
- `ServiceHours`, `SLATargets`, `MaintenanceWindow`
- `ComplianceRequirement`, `SupportLevel`

### TBM Types
- `TBMResourceTower`, `TBMCostPool`, `AllocationMethod`
- `DepreciationSchedule`, `CostBreakdown`, `CostTrend`

### BSM Types
- `BusinessCriticality`, `DataClassification`, `RiskRating`
- `CapabilityType`, `StrategicImportance`, `MaturityLevel`
- `OperationalStatus`, `LifecycleStage`, `RevenueImpact`

### Entity Types
- `ConfigurationItem`, `ConfigurationItemInput`, `ConfigurationItemUpdate`
- `ApplicationService`, `ApplicationServiceInput`, `ApplicationServiceUpdate`
- `BusinessService`, `BusinessServiceInput`, `BusinessServiceUpdate`
- `BusinessCapability`, `BusinessCapabilityInput`, `BusinessCapabilityUpdate`

### Service Interfaces
- `ICIService`
- `IApplicationServiceService`
- `IBusinessServiceService`
- `IBusinessCapabilityService`

## Design Principles

1. **Framework Integration** - Single entity model that serves ITIL, TBM, and BSM requirements simultaneously
2. **Type Safety** - Comprehensive TypeScript types with strict null checking
3. **Runtime Validation** - Zod schemas for runtime type checking and validation
4. **Separation of Concerns** - Clean separation between types, services, and validators
5. **Extensibility** - Metadata fields allow for connector-specific extensions
6. **Audit Trail** - Built-in audit fields (created_at, updated_at, created_by, updated_by)
7. **Discovery Metadata** - Track data lineage and confidence scores

## Package Structure

```
packages/unified-model/
├── src/
│   ├── types/
│   │   ├── common.types.ts              # Shared common types
│   │   ├── itil.types.ts                # ITIL v4 types
│   │   ├── tbm.types.ts                 # TBM v5.0.1 types
│   │   ├── bsm.types.ts                 # BSM types
│   │   ├── configuration-item.types.ts  # CI entity
│   │   ├── application-service.types.ts # Application Service entity
│   │   ├── business-service.types.ts    # Business Service entity
│   │   ├── business-capability.types.ts # Business Capability entity
│   │   └── index.ts
│   ├── services/
│   │   ├── ci-service.ts
│   │   ├── application-service-service.ts
│   │   ├── business-service-service.ts
│   │   ├── capability-service.ts
│   │   └── index.ts
│   ├── validators/
│   │   ├── ci-validator.ts
│   │   ├── business-service-validator.ts
│   │   └── index.ts
│   └── index.ts
├── package.json
├── tsconfig.json
└── README.md
```

## Contributing

This package is part of the HappyCMDB v3.0 monorepo. See the main [CLAUDE.md](../../CLAUDE.md) for development guidelines.

## License

MIT

## Related Packages

- `@cmdb/database` - Database implementations of service interfaces
- `@cmdb/discovery-engine` - Discovery and enrichment using these types
- `@cmdb/api-server` - REST and GraphQL APIs using these types
- `@cmdb/common` - v2.0 legacy types (being migrated to this package)

## Version History

- **3.0.0** - Initial release with unified ITIL + TBM + BSM model
  - Complete type definitions for all v3.0 entities
  - Zod validators for runtime validation
  - Service interfaces for CRUD operations
  - Comprehensive documentation and examples
