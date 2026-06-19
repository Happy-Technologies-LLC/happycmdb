# TBM Cost Engine

Technology Business Management (TBM) v5.0.1 cost allocation engine for HappyCMDB v3.0.

## Overview

The TBM Cost Engine implements comprehensive cost transparency from infrastructure resources to business capabilities, following the TBM v5.0.1 taxonomy and best practices.

## Features

- **TBM Taxonomy Mapping**: Automatic classification of CIs into TBM Resource Towers and Sub-Towers
- **Cost Allocation Methods**:
  - Direct allocation (hardware/software costs directly assigned)
  - Usage-based allocation (costs split by actual usage metrics)
  - Equal split allocation (shared costs divided equally)
- **Depreciation Schedules**: Straight-line and declining balance depreciation
- **Cost Aggregation**: Roll-up from CIs → Application Services → Business Services → Business Capabilities
- **Cost Pool Management**: Categorization by TBM cost pools (hardware, software, cloud, labor, etc.)

## Installation

```bash
npm install @cmdb/tbm-cost-engine
```

## Quick Start

### 1. Tower Mapping

Map Configuration Items to TBM Resource Towers:

```typescript
import { getTowerMappingService } from '@cmdb/tbm-cost-engine';

const towerService = getTowerMappingService();

// Map a single CI
const mapping = towerService.mapCIToTower('ci-001', 'server', { vendor: 'Dell' });
console.log(mapping.tower);     // TBMResourceTower.COMPUTE
console.log(mapping.subTower);  // 'Physical Servers'
console.log(mapping.costPool);  // TBMCostPool.HARDWARE

// Map multiple CIs in batch
const mappings = towerService.mapCIsBatch([
  { id: 'ci-001', type: 'server' },
  { id: 'ci-002', type: 'database' },
  { id: 'ci-003', type: 'storage' }
]);
```

### 2. Depreciation Calculation

Calculate depreciation for hardware and software assets:

```typescript
import { getDepreciationService, DepreciationMethod } from '@cmdb/tbm-cost-engine';

const depService = getDepreciationService();

// Set depreciation schedule
depService.setSchedule('ci-server-001', {
  purchaseDate: new Date('2023-01-01'),
  purchasePrice: 36000,
  method: DepreciationMethod.STRAIGHT_LINE,
  depreciationYears: 3,
  residualValue: 0
});

// Calculate current depreciation
const result = depService.calculateCurrentDepreciation('ci-server-001');
console.log(result.monthlyDepreciation);      // 1000
console.log(result.currentBookValue);         // Varies by date
console.log(result.isFullyDepreciated);       // false

// Get monthly cost
const monthlyCost = depService.getMonthlyDepreciation('ci-server-001');
console.log(monthlyCost); // 1000
```

### 3. Cost Allocation

Allocate CI costs to consumers using different methods:

#### Direct Allocation

```typescript
import { getCostAllocationService } from '@cmdb/tbm-cost-engine';

const costService = getCostAllocationService();

const result = costService.allocateDirectCosts(
  'ci-001',
  'Production Server',
  'server',
  [
    {
      ciId: 'ci-001',
      costType: 'purchase',
      amount: 36000,
      frequency: 'one_time',
      startDate: new Date('2023-01-01')
    }
  ],
  [
    {
      targetId: 'app-001',
      targetType: 'application_service',
      targetName: 'E-commerce',
      allocatedAmount: 1000,
      allocationBasis: 'Direct assignment',
      allocationPercentage: 100
    }
  ]
);
```

#### Usage-Based Allocation

```typescript
const result = costService.allocateUsageBasedCosts(
  'ci-db-001',
  'Shared Database',
  'database',
  3000, // Total monthly cost
  [
    { consumerId: 'app-001', metricType: 'cpu_hours', value: 600 },
    { consumerId: 'app-002', metricType: 'cpu_hours', value: 300 },
    { consumerId: 'app-003', metricType: 'cpu_hours', value: 100 }
  ]
);

console.log(result.allocatedTo[0].allocatedAmount); // 1800 (60% of 3000)
console.log(result.allocatedTo[1].allocatedAmount); // 900 (30% of 3000)
console.log(result.allocatedTo[2].allocatedAmount); // 300 (10% of 3000)
```

#### Equal Split Allocation

```typescript
const result = costService.allocateEqualSplit(
  'ci-network-001',
  'Shared Firewall',
  'firewall',
  1500,
  ['app-001', 'app-002', 'app-003']
);

console.log(result.costPerConsumer); // 500
```

### 4. Cost Aggregation

Roll up costs through the hierarchy:

```typescript
import { getPoolAggregationService } from '@cmdb/tbm-cost-engine';

const poolService = getPoolAggregationService();

// Aggregate costs for an Application Service
const appServiceCosts = await poolService.aggregateApplicationServiceCosts('app-svc-001');
console.log(appServiceCosts.totalMonthlyCost);
console.log(appServiceCosts.costByTower);
console.log(appServiceCosts.contributingCIs);

// Aggregate costs for a Business Service
const businessServiceCosts = await poolService.aggregateBusinessServiceCosts('bs-001');
console.log(businessServiceCosts.totalMonthlyCost);

// Aggregate costs for a Business Capability
const capabilityCosts = await poolService.aggregateBusinessCapabilityCosts('bc-001');
console.log(capabilityCosts.totalMonthlyCost);

// Get top cost contributors
const topContributors = await poolService.getTopCostContributors('bs-001', 'business_service', 10);
topContributors.forEach(ci => {
  console.log(`${ci.ciName}: $${ci.cost} (${ci.percentage}%)`);
});
```

## TBM Resource Towers

The engine supports all TBM v5.0.1 resource towers:

- **Compute**: Physical Servers, Virtual Machines, Containers, Serverless, Mainframes
- **Storage**: Block Storage, Object Storage, File Storage, Backup Storage, SAN/NAS
- **Network**: Routers, Switches, Load Balancers, Firewalls, VPN, CDN
- **Data**: Relational Databases, NoSQL Databases, Data Warehouses, Data Lakes, Cache Services
- **Security**: Identity Management, Key Management, Threat Detection, DDoS Protection, WAF
- **Applications**: Business Applications, Development Tools, Collaboration, Analytics
- **End User**: Workstations, Mobile Devices, Peripherals
- **Facilities**: Data Centers, Power, Cooling
- **IoT**: IoT Devices, Edge Computing
- **Blockchain**: Blockchain Nodes
- **Quantum**: Quantum Computing

## TBM Cost Pools

Costs are categorized into TBM cost pools:

- Labor (Internal)
- Labor (External)
- Hardware
- Software
- Cloud
- Outside Services
- Facilities
- Telecom

## Advanced Usage

### Custom Depreciation Schedules

```typescript
import { calculateDepreciation, DepreciationMethod } from '@cmdb/tbm-cost-engine';

const result = calculateDepreciation('ci-001', {
  purchaseDate: new Date('2023-01-01'),
  purchasePrice: 50000,
  method: DepreciationMethod.DECLINING_BALANCE,
  depreciationYears: 5,
  residualValue: 5000
});
```

### Tiered Usage Pricing

```typescript
import { calculateTieredUsageAllocation } from '@cmdb/tbm-cost-engine';

const result = calculateTieredUsageAllocation(
  {
    ciId: 'ci-001',
    unitCost: 0, // Will be calculated from tiers
    usageMetric: 'storage_gb',
    totalUsage: 10000,
    consumerUsage: new Map([
      ['app-001', 6000],
      ['app-002', 4000]
    ])
  },
  [
    { threshold: 0, unitCost: 0.10 },      // First 1000 GB: $0.10/GB
    { threshold: 1000, unitCost: 0.08 },   // 1001-5000 GB: $0.08/GB
    { threshold: 5000, unitCost: 0.05 }    // Above 5000 GB: $0.05/GB
  ]
);
```

### Weighted Split Allocation

```typescript
import { calculateWeightedSplit } from '@cmdb/tbm-cost-engine';

const result = calculateWeightedSplit(
  'ci-001',
  3000,
  new Map([
    ['app-001', 2],  // Gets 2/5 of cost = $1200
    ['app-002', 2],  // Gets 2/5 of cost = $1200
    ['app-003', 1]   // Gets 1/5 of cost = $600
  ])
);
```

### Cost Validation

```typescript
const validation = costService.validateAllocation(allocationResult);

if (!validation.isValid) {
  console.error('Validation errors:', validation.errors);
}

if (validation.warnings.length > 0) {
  console.warn('Warnings:', validation.warnings);
}

console.log(`Allocation percentage: ${validation.allocationPercentage}%`);
```

## Integration with Neo4j

The Pool Aggregation Service uses Neo4j graph queries to traverse the CI hierarchy:

```cypher
-- Example: Find all CIs supporting a Business Service
MATCH (bs:BusinessService {id: $serviceId})
MATCH (ci:CI)-[:SUPPORTS*1..2]->(bs)
RETURN ci.id, ci.tbm_monthly_cost, ci.tbm_resource_tower
```

Ensure your Neo4j schema includes:
- TBM attributes on CI nodes (`tbm_resource_tower`, `tbm_cost_pool`, `tbm_monthly_cost`)
- Relationship types: `SUPPORTS`, `ENABLES`

## Performance

The engine is optimized for performance:
- **Batch operations**: Process 1000 CIs in <5 seconds
- **Caching**: Depreciation schedules cached in memory
- **Efficient queries**: Neo4j queries use indexed properties

## Testing

```bash
npm test                 # Run all tests
npm run test:watch       # Watch mode
npm run test:coverage    # Generate coverage report
```

## API Reference

### Services

- `TowerMappingService`: Map CIs to TBM towers and sub-towers
- `DepreciationService`: Manage depreciation schedules
- `CostAllocationService`: Allocate costs using different methods
- `PoolAggregationService`: Aggregate costs through hierarchy

### Calculators

- `depreciation.calculator`: Depreciation calculations
- `direct-cost-calculator`: Direct cost calculations
- `usage-based-calculator`: Usage-based allocation
- `equal-split-calculator`: Equal split allocation

### Types

All TypeScript types are exported from:
- `types/tbm-types.ts`: TBM-specific types
- `types/cost-types.ts`: Cost calculation types

## License

MIT

## Cloud Cost Integrations

The TBM Cost Engine now includes comprehensive integrations for fetching actual cost data from cloud providers and financial systems.

### AWS Cost Explorer Integration

Fetch cost and usage data from AWS:

```typescript
import { AWSCostExplorer, AWSCredentials } from '@cmdb/tbm-cost-engine';
import winston from 'winston';

const logger = winston.createLogger({ /* ... */ });

const credentials: AWSCredentials = {
  accessKeyId: 'YOUR_ACCESS_KEY',
  secretAccessKey: 'YOUR_SECRET_KEY',
  region: 'us-east-1'
};

const awsCostExplorer = new AWSCostExplorer(credentials, logger);

// Get daily costs
const startDate = new Date('2024-10-01');
const endDate = new Date('2024-10-31');
const dailyCosts = await awsCostExplorer.getDailyCosts(startDate, endDate);

// Get costs by service
const serviceBreakdown = await awsCostExplorer.getCostsByService('EC2', startDate, endDate);
console.log(`Total EC2 cost: $${serviceBreakdown.total}`);

// Get current month costs
const currentMonthCosts = await awsCostExplorer.getCurrentMonthCosts();

// Get cost forecast
const nextMonthStart = new Date('2024-11-01');
const nextMonthEnd = new Date('2024-11-30');
const forecast = await awsCostExplorer.getCostForecast(nextMonthStart, nextMonthEnd);
console.log(`Predicted next month cost: $${forecast.predictedCost}`);

// Detect cost anomalies
const anomaly = await awsCostExplorer.detectCostAnomalies('i-1234567890abcdef0', 150.00);
if (anomaly.detected) {
  console.log(`Cost anomaly detected: ${anomaly.reason}`);
}
```

### Azure Cost Management Integration

Fetch cost data from Azure:

```typescript
import { AzureCostManagement, AzureCredentials } from '@cmdb/tbm-cost-engine';

const credentials: AzureCredentials = {
  clientId: 'YOUR_CLIENT_ID',
  clientSecret: 'YOUR_CLIENT_SECRET',
  tenantId: 'YOUR_TENANT_ID',
  subscriptionId: 'YOUR_SUBSCRIPTION_ID'
};

const azureCostMgmt = new AzureCostManagement(credentials, logger);

// Get costs by resource group
const rgCost = await azureCostMgmt.getCostsByResourceGroup('my-resource-group', startDate, endDate);

// Get subscription costs with breakdown
const subscriptionCosts = await azureCostMgmt.getCostsBySubscription('sub-id', startDate, endDate);

// Get daily costs
const dailyCosts = await azureCostMgmt.getDailyCosts('sub-id', startDate, endDate);

// Get costs by location
const regionCost = await azureCostMgmt.getCostsByLocation('eastus', startDate, endDate);

// Get costs by tag
const taggedCost = await azureCostMgmt.getCostsByTag('Environment', 'Production', startDate, endDate);
```

### GCP Billing Integration

Fetch cost data from Google Cloud Platform:

```typescript
import { GCPBilling, GCPCredentials } from '@cmdb/tbm-cost-engine';

const credentials: GCPCredentials = {
  projectId: 'my-project-id',
  keyFilename: '/path/to/service-account-key.json'
};

const gcpBilling = new GCPBilling(credentials, logger);

// Get costs by project
const projectCost = await gcpBilling.getCostsByProject('my-project', startDate, endDate);

// Get service breakdown
const serviceBreakdown = await gcpBilling.getServiceBreakdown(startDate, endDate);

// Get costs by location
const locationCost = await gcpBilling.getCostsByLocation('us-central1', startDate, endDate);

// Get costs by label
const labeledCost = await gcpBilling.getCostsByLabel('env', 'prod', startDate, endDate);

// List billing accounts
const accounts = await gcpBilling.listBillingAccounts();
```

### General Ledger Integration

Import and synchronize GL data:

```typescript
import { GLIntegration, GLImportConfig } from '@cmdb/tbm-cost-engine';

const glIntegration = new GLIntegration(logger);

// Import GL accounts from CSV
const importConfig: GLImportConfig = {
  format: 'csv',
  delimiter: ',',
  hasHeader: true,
  columnMappings: {
    accountNumber: 'Account',
    accountName: 'Description',
    amount: 'Amount',
    date: 'Date',
    costCenter: 'Cost Center'
  }
};

const accounts = await glIntegration.importGLAccounts('/path/to/gl-export.csv', importConfig);

// Map GL account to TBM cost pool
await glIntegration.mapGLAccountToCostPool('6000-001', 'hardware', 100);

// Synchronize monthly costs
const currentMonth = new Date();
const syncResult = await glIntegration.syncMonthlyCosts(currentMonth);

// Get on-premise asset costs
const assetCosts = await glIntegration.getOnPremiseAssetCosts();

// Calculate asset depreciation
const depreciation = await glIntegration.calculateAssetDepreciation('asset-001');

// Reconcile costs
const reconciliation = await glIntegration.reconcileCosts(currentMonth);
console.log(`Variance: $${reconciliation.variance} (${reconciliation.variancePercentage}%)`);
```

### License Cost Tracking

Track and manage software licenses:

```typescript
import { LicenseTracker, SoftwareLicense } from '@cmdb/tbm-cost-engine';

const licenseTracker = new LicenseTracker(logger);

// Track a new license
const license: SoftwareLicense = {
  id: 'lic-001',
  softwareName: 'Microsoft Office 365',
  vendor: 'Microsoft',
  licenseType: 'per_user',
  quantity: 100,
  unitCost: 12.50,
  currency: 'USD',
  renewalDate: new Date('2025-01-01'),
  purchaseDate: new Date('2024-01-01'),
  supportIncluded: true
};

await licenseTracker.trackSoftwareLicense(license);

// Calculate license cost based on usage
const usage = {
  licenseId: 'lic-001',
  usedCount: 85,
  availableCount: 15,
  utilizationPercentage: 85,
  lastUpdated: new Date()
};

const cost = await licenseTracker.calculateLicenseCost('lic-001', usage);

// Get upcoming renewals (next 30 days)
const renewals = await licenseTracker.getUpcomingRenewals(30);
renewals.forEach(renewal => {
  console.log(`${renewal.softwareName} renews in ${renewal.daysUntilRenewal} days - Cost: $${renewal.renewalCost}`);
});

// Get cost breakdown
const breakdown = await licenseTracker.getLicenseCostBreakdown();
console.log(`Total annual license cost: $${breakdown.totalAnnualCost}`);
console.log(`Underutilized licenses: ${breakdown.underutilized.length}`);

// Send renewal reminders
await licenseTracker.sendRenewalReminders(30);
```

### Cost Synchronization Service

Automated cost synchronization from all sources:

```typescript
import { CostSyncService } from '@cmdb/tbm-cost-engine';

const costSyncService = new CostSyncService(logger);

// Sync AWS costs
const awsResult = await costSyncService.syncCloudCosts('aws', {
  credentialId: 'cred-aws-001',
  lookbackDays: 7,
  batchSize: 100
});

console.log(`AWS Sync: ${awsResult.recordsProcessed} records processed`);
console.log(`Created: ${awsResult.recordsCreated}, Updated: ${awsResult.recordsUpdated}`);

// Sync Azure costs
const azureResult = await costSyncService.syncCloudCosts('azure', {
  credentialId: 'cred-azure-001'
});

// Sync GCP costs
const gcpResult = await costSyncService.syncCloudCosts('gcp', {
  credentialId: 'cred-gcp-001'
});

// Sync GL costs (monthly)
const glResult = await costSyncService.syncGLCosts();

// Sync license costs
const licenseResult = await costSyncService.syncLicenseCosts();

// Reconcile all costs
const currentMonth = new Date();
const reconciliation = await costSyncService.reconcileCosts(currentMonth);

console.log(`Total Cloud Costs: $${reconciliation.totalCloudCosts}`);
console.log(`Total GL Costs: $${reconciliation.totalGLCosts}`);
console.log(`Total License Costs: $${reconciliation.totalLicenseCosts}`);
console.log(`Reconciled: ${reconciliation.reconciled}`);

// Schedule automated syncs
await costSyncService.scheduleAutomatedSyncs();
// This sets up:
// - Daily cloud cost syncs (AWS, Azure, GCP) at 2 AM
// - Monthly GL sync on 5th of each month at 3 AM
// - Daily license cost sync at 1 AM
```

## Integration Setup

### Prerequisites

1. **Cloud Provider Credentials**:
   - **AWS**: IAM user with `ce:GetCostAndUsage` permission
   - **Azure**: Service Principal with Cost Management Reader role
   - **GCP**: Service account with Billing Account Viewer role + BigQuery export configured

2. **Database Schema**: Ensure PostgreSQL tables are created:
   - `credentials` - Store encrypted cloud credentials
   - `resource_costs` - Store cloud cost data
   - `gl_accounts` - Store GL account mappings
   - `software_licenses` - Store license information
   - `license_costs` - Store license cost tracking

3. **Redis**: Required for BullMQ job queue (cost synchronization)

### Credential Management

Store credentials securely in PostgreSQL:

```sql
INSERT INTO credentials (
  credential_id, provider, access_key_id, secret_access_key, region
) VALUES (
  'cred-aws-001', 'aws', 'ENCRYPTED_KEY', 'ENCRYPTED_SECRET', 'us-east-1'
);
```

**Important**: Always encrypt sensitive credentials using your encryption service.

### GCP BigQuery Export

For GCP billing integration to work, you must:

1. Enable BigQuery Billing Export in GCP Console
2. Create a BigQuery dataset (e.g., `billing_export`)
3. Configure daily exports to this dataset
4. Grant service account BigQuery Data Viewer role

### Scheduling

The Cost Synchronization Service uses BullMQ for job scheduling. Ensure Redis is running and call:

```typescript
await costSyncService.scheduleAutomatedSyncs();
```

This creates recurring jobs that run automatically.

## Error Handling

All integrations include comprehensive error handling with retry logic:

- **AWS**: Exponential backoff for throttling errors
- **Azure**: Automatic retry for 429 and 5xx errors
- **GCP**: Quota error detection and retry
- **GL**: Transaction rollback on import errors
- **Sync**: Failed jobs automatically retried up to 3 times

## Support

For questions and support, please refer to the HappyCMDB documentation at `/doc-site/`.
