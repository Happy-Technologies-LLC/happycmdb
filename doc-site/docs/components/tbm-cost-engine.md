# TBM Cost Engine

**Package**: `@cmdb/tbm-cost-engine`
**Version**: v3.0+
**Framework**: TBM v5.0.1

The TBM Cost Engine provides Technology Business Management capabilities for cost allocation, showback/chargeback, and financial transparency from infrastructure to business capabilities.

## Overview

HappyCMDB v3.0 implements TBM v5.0.1 taxonomy with automated cost allocation, cloud cost integration, and comprehensive financial reporting.

### Key Features

- **11 TBM Resource Towers**: Complete TBM v5.0.1 taxonomy
- **3 Cost Allocation Methods**: Direct, usage-based, equal split
- **Cloud Cost Integration**: AWS, Azure, GCP automated daily sync
- **GL Integration**: On-premise asset depreciation and cost import
- **Cost Roll-up**: CI → Application Service → Business Service → Business Capability

---

## TBM Resource Towers

### 11 Standard Towers

| Tower | Description | Sub-Towers |
|-------|-------------|------------|
| **Compute** | Servers, VMs, containers | Physical Servers, Virtual Servers, Cloud Instances, Containers |
| **Storage** | Storage arrays, volumes | SAN, NAS, Object Storage, Block Storage, File Storage |
| **Network** | Network devices, bandwidth | Routers, Switches, Firewalls, Load Balancers, WAN, LAN |
| **Data** | Databases, data platforms | RDBMS, NoSQL, Data Warehouses, Data Lakes |
| **Security** | Security tools, appliances | Firewalls, IDS/IPS, SIEM, IAM, Encryption |
| **Applications** | Software applications | Commercial Software, Custom Applications, SaaS |
| **End User** | End-user devices | Laptops, Desktops, Mobile Devices, Peripherals |
| **Facilities** | Physical infrastructure | Data Center Space, Power, Cooling, Physical Security |
| **IoT** | Internet of Things devices | Sensors, Actuators, Gateways, Edge Devices |
| **Blockchain** | Blockchain infrastructure | Nodes, Smart Contracts, Distributed Ledgers |
| **Quantum** | Quantum computing | Quantum Processors, Simulators |

### 8 Cost Pools

- **Hardware**: Physical assets and equipment
- **Software**: Licenses and subscriptions
- **Cloud**: Public cloud consumption (AWS, Azure, GCP)
- **Labor (Internal)**: Internal IT staff costs
- **Labor (External)**: Contractors and consultants
- **Facilities**: Data center and office space
- **Telecom**: Network connectivity and bandwidth
- **Outside Services**: Managed services and outsourcing

---

## Cost Allocation Methods

### 1. Direct Allocation

Costs directly assigned to specific consumers:

```typescript
import { getCostAllocationService } from '@cmdb/tbm-cost-engine';

const costService = getCostAllocationService();

const allocation = costService.allocateDirectCosts(
  'ci-server-001',      // Source CI
  'Web Server 01',      // CI Name
  'server',             // CI Type
  1200,                 // Monthly cost
  [
    {
      consumerId: 'app-web-001',
      consumerName: 'Web Application',
      consumerType: 'application_service',
      costType: 'purchase',      // one-time, monthly, annual
      amount: 1200
    }
  ]
);

console.log(allocation);
// {
//   ciId: 'ci-server-001',
//   tower: 'compute',
//   monthlyCost: 1200,
//   allocationMethod: 'direct',
//   allocatedTo: [...]
// }
```

### 2. Usage-Based Allocation

Costs split by actual usage metrics:

```typescript
const allocation = costService.allocateUsageBasedCosts(
  'ci-db-shared-001',   // Shared database
  'Shared PostgreSQL',
  'database',
  5000,                 // Monthly cost
  [
    { consumerId: 'app-001', metricType: 'cpu_hours', value: 600 },
    { consumerId: 'app-002', metricType: 'cpu_hours', value: 400 }
  ]
);

// app-001 gets 60% = $3000
// app-002 gets 40% = $2000
```

**Supported Metrics**:
- `cpu_hours`: CPU usage hours
- `storage_gb`: Storage gigabytes used
- `bandwidth_gb`: Bandwidth gigabytes transferred
- `transactions`: Number of transactions
- `users`: Number of users
- `requests`: API requests count

### 3. Equal Split Allocation

Shared costs divided equally or with weights:

```typescript
// Equal split
const allocation = costService.allocateEqualSplitCosts(
  'ci-network-001',
  'Core Switch',
  'network-device',
  2000,
  [
    { consumerId: 'app-001' },
    { consumerId: 'app-002' },
    { consumerId: 'app-003' },
    { consumerId: 'app-004' }
  ],
  'equal'  // Each gets 25% = $500
);

// Weighted split
const allocation = costService.allocateEqualSplitCosts(
  'ci-network-001',
  'Core Switch',
  'network-device',
  2000,
  [
    { consumerId: 'app-001', weight: 2 },  // Gets 40% = $800
    { consumerId: 'app-002', weight: 2 },  // Gets 40% = $800
    { consumerId: 'app-003', weight: 0.5 }, // Gets 10% = $200
    { consumerId: 'app-004', weight: 0.5 }  // Gets 10% = $200
  ],
  'weighted'
);
```

---

## Depreciation

### Depreciation Methods

**1. Straight-Line Depreciation** (Default):

```
monthlyDepreciation = (purchasePrice - residualValue) / (depreciationYears × 12)
```

**Example**:
- Purchase price: $36,000
- Depreciation: 3 years
- Residual value: $0
- Monthly cost: $36,000 / 36 = **$1,000/month**

**2. Declining Balance Depreciation**:

```
annualDepreciation = bookValue × depreciationRate
monthlyDepreciation = annualDepreciation / 12
```

### Usage Example

```typescript
import { getDepreciationService } from '@cmdb/tbm-cost-engine';

const depService = getDepreciationService();

// Set depreciation schedule
depService.setSchedule('ci-server-001', {
  purchaseDate: new Date('2023-01-01'),
  purchasePrice: 36000,
  method: 'straight_line',
  depreciationYears: 3,
  residualValue: 0
});

// Get monthly depreciation
const monthly = depService.getMonthlyDepreciation('ci-server-001');
// Returns: 1000

// Get current book value
const bookValue = depService.getCurrentBookValue('ci-server-001');
// Returns current value after depreciation
```

---

## Cloud Cost Integration

### AWS Cost Explorer

```typescript
import { AWSCostExplorer } from '@cmdb/tbm-cost-engine/integrations';

const awsCosts = new AWSCostExplorer(credentialId);

// Get costs by resource
const costs = await awsCosts.getCostsByResourceId(
  ['i-1234567890abcdef0'],  // Instance IDs
  new Date('2024-10-01'),
  new Date('2024-10-31')
);

// Get costs by service
const serviceCosts = await awsCosts.getCostsByService(
  'EC2',
  new Date('2024-10-01'),
  new Date('2024-10-31')
);

// Detect anomalies
const anomalies = await awsCosts.detectAnomalies(
  new Date('2024-10-01'),
  new Date('2024-10-31')
);
```

### Azure Cost Management

```typescript
import { AzureCostManagement } from '@cmdb/tbm-cost-engine/integrations';

const azureCosts = new AzureCostManagement(credentialId);

// Get costs by resource group
const costs = await azureCosts.getCostsByResourceGroup(
  'rg-production',
  new Date('2024-10-01'),
  new Date('2024-10-31')
);

// Get costs by subscription
const subCosts = await azureCosts.getCostsBySubscription(
  'sub-12345',
  new Date('2024-10-01'),
  new Date('2024-10-31')
);
```

### GCP Billing

```typescript
import { GCPBilling } from '@cmdb/tbm-cost-engine/integrations';

const gcpBilling = new GCPBilling(credentialId);

// Get costs by project
const costs = await gcpBilling.getCostsByProject(
  'my-gcp-project',
  new Date('2024-10-01'),
  new Date('2024-10-31')
);

// Get costs by service
const serviceCosts = await gcpBilling.getCostsByService(
  'Compute Engine',
  new Date('2024-10-01'),
  new Date('2024-10-31')
);
```

### Automated Cost Sync

```typescript
import { CostSyncService } from '@cmdb/tbm-cost-engine/integrations';

const syncService = new CostSyncService();

// Schedule automated syncs
await syncService.scheduleAutomatedSyncs();
// Daily cloud costs: 2 AM
// Monthly GL sync: 5th of month at 3 AM
// Daily license costs: 1 AM

// Manual sync
const result = await syncService.syncCloudCosts('aws');
console.log(result);
// {
//   success: true,
//   recordsProcessed: 1523,
//   totalCost: 45678.90,
//   errors: []
// }
```

---

## Cost Roll-Up

Aggregate costs up the hierarchy:

```typescript
import { getPoolAggregationService } from '@cmdb/tbm-cost-engine';

const poolService = getPoolAggregationService();

// Aggregate costs for business service
const costs = await poolService.aggregateBusinessServiceCosts('bs-crm');

console.log(costs);
// {
//   businessServiceId: 'bs-crm',
//   businessServiceName: 'CRM System',
//   totalMonthlyCost: 125000,
//   costByTower: {
//     'compute': 50000,
//     'storage': 30000,
//     'network': 15000,
//     'data': 20000,
//     'applications': 10000
//   },
//   costByPool: {
//     'cloud': 80000,
//     'hardware': 25000,
//     'software': 15000,
//     'labor_internal': 5000
//   },
//   contributingCIs: [
//     { ciId: 'ci-001', monthlyCost: 5000, tower: 'compute' },
//     // ... more CIs
//   ]
// }

// Aggregate costs for business capability
const capCosts = await poolService.aggregateBusinessCapabilityCosts('cap-customer-engagement');
// Rolls up all business services in this capability
```

---

## REST API

### Cost Endpoints

```http
GET    /api/v1/tbm/costs/summary
GET    /api/v1/tbm/costs/by-tower
GET    /api/v1/tbm/costs/by-capability/:id
GET    /api/v1/tbm/costs/by-service/:id
GET    /api/v1/tbm/costs/trends
POST   /api/v1/tbm/costs/allocate
GET    /api/v1/tbm/costs/allocations/:ciId
```

### GL and License Endpoints

```http
POST   /api/v1/tbm/gl/import
GET    /api/v1/tbm/licenses
GET    /api/v1/tbm/licenses/renewals
```

---

## GraphQL API

```graphql
query {
  # Cost summary
  costSummary {
    totalMonthlyCost
    costByTower {
      tower
      monthlyCost
    }
    costByPool {
      pool
      monthlyCost
    }
  }

  # Costs by business service
  costsByBusinessService(serviceId: "bs-crm") {
    totalMonthlyCost
    annualCost
    costByTower {
      tower
      monthlyCost
    }
    contributingCIs {
      ciId
      ciName
      monthlyCost
    }
  }

  # Cost trends
  costTrends(months: 12) {
    month
    totalCost
    costByTower {
      tower
      cost
    }
  }

  # Unit economics
  unitEconomics(serviceId: "bs-crm") {
    costPerTransaction
    costPerUser
    costPerRevenue
  }
}

mutation {
  # Allocate costs
  allocateCosts(input: {
    ciId: "ci-db-001"
    allocationMethod: "usage_based"
    consumers: [
      { consumerId: "app-001", metricType: "cpu_hours", value: 600 }
      { consumerId: "app-002", metricType: "cpu_hours", value: 400 }
    ]
  }) {
    success
    allocations {
      consumerId
      allocatedAmount
    }
  }
}
```

---

## FinOps Dashboard Integration

The TBM Cost Engine powers the **FinOps Dashboard** with:

- Cloud spend by provider (AWS/Azure/GCP)
- On-prem vs cloud comparison
- Cost allocation by tower
- Budget variance tracking
- Unit economics
- Cost optimization recommendations

See [Dashboards](/components/dashboards#finops-dashboard) for more details.

---

## License Tracking

```typescript
import { LicenseTracker } from '@cmdb/tbm-cost-engine/integrations';

const licenseTracker = new LicenseTracker();

// Track software license
await licenseTracker.trackSoftwareLicense({
  id: 'lic-office365',
  softwareName: 'Microsoft Office 365',
  vendor: 'Microsoft',
  licenseType: 'per_user',
  quantity: 500,
  unitCost: 12.50,
  renewalDate: new Date('2025-06-01')
});

// Get upcoming renewals
const renewals = await licenseTracker.getUpcomingRenewals(30); // 30 days
// Returns licenses expiring in the next 30 days

// Calculate license costs
const cost = await licenseTracker.calculateLicenseCost('lic-office365', {
  activeUsers: 475
});
// Returns: 475 × $12.50 = $5,937.50/month
```

---

## Best Practices

### Cost Allocation

1. **Use direct allocation for dedicated resources** - Single-tenant servers, dedicated licenses
2. **Use usage-based for shared resources** - Multi-tenant databases, shared storage
3. **Use equal split for infrastructure** - Network, facilities, security
4. **Review allocations monthly** - Ensure accuracy and adjust as needed

### Cloud Costs

1. **Enable automated daily sync** - Keep cost data current
2. **Tag all cloud resources** - Essential for cost allocation
3. **Set budget alerts** - Detect cost overruns early
4. **Review anomalies weekly** - Investigate unexpected cost spikes

### Depreciation

1. **Use 3-year straight-line for hardware** - Industry standard
2. **Use 1-year for software** - Reflects rapid obsolescence
3. **Set residual value to $0** - Conservative approach
4. **Review schedules annually** - Adjust for actual useful life

### Showback vs Chargeback

**Showback** (Informational):
- Show business units their IT costs
- No actual budget transfer
- Goal: Cost awareness and optimization

**Chargeback** (Billing):
- Bill business units for IT costs
- Actual budget transfer
- Goal: Cost accountability and efficiency

---

## Performance Metrics

- **Cost allocation**: <100ms per CI
- **Cost roll-up**: <5 seconds for 1000 CIs
- **Cloud cost sync**: <30 seconds for 1000 resources
- **Depreciation calculation**: <50ms per asset

---

## Related Documentation

- [ITIL Service Manager](/components/itil-service-manager) - Incident and change management
- [BSM Impact Engine](/components/bsm-impact-engine) - Business impact scoring
- [Framework Integration](/components/framework-integration) - Unified ITIL+TBM+BSM interface
- [Dashboards](/components/dashboards) - FinOps Dashboard for cost optimization
- [Metabase](/components/metabase) - BI reporting for cost analysis
