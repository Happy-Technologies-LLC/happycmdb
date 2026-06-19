# Financial Data Integration Guide

This guide explains how to integrate financial cost data into HappyCMDB v3.0 to enable Technology Business Management (TBM) features, cost transparency, and FinOps optimization dashboards.

## Overview

HappyCMDB v3.0's TBM Cost Engine supports multiple financial data sources:

- **Cloud Provider APIs**: Automated cost fetching from AWS, Azure, and GCP
- **General Ledger (GL) Systems**: Cost center and departmental allocation data
- **CSV Import**: Manual cost data upload for on-premise assets, licenses, and depreciation
- **License Tracking**: Software license cost allocation across services

All financial data flows into the PostgreSQL data mart (`tbm_cost_pools`, `gl_accounts`, `license_costs`) and gets mapped to Configuration Items (CIs) through the TBM enrichment pipeline.

## Prerequisites

Before integrating financial data, ensure:

- HappyCMDB v3.0 is deployed with PostgreSQL and Redis
- Discovery has run and populated CIs in Neo4j
- You have credentials for cloud providers (AWS, Azure, GCP) or GL systems
- ETL processor service is running (`packages/etl-processor`)

## Supported Data Sources

### 1. AWS Cost Explorer

**What it provides:**
- Daily cost and usage data by service (EC2, RDS, S3, etc.)
- Resource-level cost breakdown (per EC2 instance, per RDS database)
- Cost forecasts and anomaly detection

**Prerequisites:**
- AWS IAM user with `ce:GetCostAndUsage` permission
- AWS access key and secret key
- Account must have Cost Explorer enabled (first 12 months free)

**Setup Steps:**

#### Step 1: Create AWS IAM Policy

Create a custom IAM policy with Cost Explorer read permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ce:GetCostAndUsage",
        "ce:GetCostAndUsageWithResources",
        "ce:GetCostForecast",
        "ce:GetDimensionValues",
        "ce:GetTags"
      ],
      "Resource": "*"
    }
  ]
}
```

#### Step 2: Create IAM User and Credentials

1. AWS Console → IAM → Users → Create User
2. Attach the Cost Explorer policy created above
3. Create Access Key → Copy Access Key ID and Secret Access Key

#### Step 3: Add Credentials to HappyCMDB

Use the unified credential system (v2.0+):

```bash
# Via CLI
cmdb credentials create \
  --name "AWS Cost Explorer - Production" \
  --type api_key \
  --protocol aws_api \
  --port 443 \
  --fields '{
    "access_key_id": "AKIA...",
    "secret_access_key": "wJalr...",
    "region": "us-east-1"
  }'
```

Or via Web UI: **Credentials** → **Add Credential** → Select **AWS API**

#### Step 4: Schedule Cost Sync Job

Create a BullMQ job to sync AWS costs daily:

```typescript
// packages/etl-processor/src/jobs/aws-cost-sync.job.ts
import { CostSyncService } from '@cmdb/tbm-cost-engine';

export async function scheduleAWSCostSync() {
  const costSync = new CostSyncService(logger);

  // Trigger daily at 4:00 AM UTC
  await costSync.scheduleCostSync({
    provider: 'aws',
    credentialId: 'aws-cost-explorer-prod', // From Step 3
    schedule: '0 4 * * *', // cron pattern
    lookbackDays: 7, // Sync last 7 days (catch delayed charges)
    options: {
      groupBy: ['SERVICE', 'REGION'],
      includeResourceTags: true,
      enableForecasting: true,
    }
  });
}
```

#### Step 5: Verify Data Import

Check that costs are being imported:

```sql
-- PostgreSQL: Check AWS costs in tbm_cost_pools
SELECT
  fiscal_period,
  pool_name,
  resource_tower,
  monthly_cost,
  source_system
FROM tbm_cost_pools
WHERE source_system = 'aws'
ORDER BY fiscal_period DESC, monthly_cost DESC
LIMIT 20;
```

### 2. Azure Cost Management

**What it provides:**
- Subscription-level cost data
- Resource group cost allocation
- Azure service costs (VMs, Storage, Databases)
- Budgets and cost alerts

**Prerequisites:**
- Azure App Registration (Service Principal)
- Cost Management Reader role on subscription
- Tenant ID, Client ID, and Client Secret

**Setup Steps:**

#### Step 1: Create Azure Service Principal

```bash
# Azure CLI
az ad sp create-for-rbac \
  --name "HappyCMDB-CostManagement" \
  --role "Cost Management Reader" \
  --scopes /subscriptions/{subscription-id}

# Output will contain:
# - appId (Client ID)
# - password (Client Secret)
# - tenant (Tenant ID)
```

#### Step 2: Add Credentials to HappyCMDB

```bash
cmdb credentials create \
  --name "Azure Cost Management - Production" \
  --type oauth2_client_credentials \
  --protocol azure_api \
  --fields '{
    "tenant_id": "00000000-0000-0000-0000-000000000000",
    "client_id": "00000000-0000-0000-0000-000000000000",
    "client_secret": "secretvalue",
    "subscription_id": "00000000-0000-0000-0000-000000000000"
  }'
```

#### Step 3: Schedule Cost Sync Job

```typescript
await costSync.scheduleCostSync({
  provider: 'azure',
  credentialId: 'azure-cost-mgmt-prod',
  schedule: '0 4 * * *',
  lookbackDays: 7,
  options: {
    groupBy: ['ResourceGroup', 'ServiceName'],
    includeTags: true,
  }
});
```

### 3. GCP Billing Export

**What it provides:**
- BigQuery-based cost data export
- Project-level and SKU-level costs
- GCP service costs (Compute Engine, Cloud Storage, etc.)

**Prerequisites:**
- GCP project with Billing enabled
- BigQuery dataset with billing export enabled
- Service Account with BigQuery Data Viewer role

**Setup Steps:**

#### Step 1: Enable BigQuery Billing Export

1. GCP Console → Billing → Billing Export
2. Enable **Detailed usage cost** export
3. Select BigQuery dataset (or create new): `billing_data`
4. Wait 24 hours for first export

#### Step 2: Create Service Account

```bash
# Create service account
gcloud iam service-accounts create happycmdb-billing \
  --display-name "HappyCMDB Billing Reader"

# Grant BigQuery Data Viewer role
gcloud projects add-iam-policy-binding {project-id} \
  --member "serviceAccount:happycmdb-billing@{project-id}.iam.gserviceaccount.com" \
  --role "roles/bigquery.dataViewer"

# Create and download key
gcloud iam service-accounts keys create billing-key.json \
  --iam-account happycmdb-billing@{project-id}.iam.gserviceaccount.com
```

#### Step 3: Add Credentials to HappyCMDB

```bash
cmdb credentials create \
  --name "GCP Billing Export - Production" \
  --type service_account_key \
  --protocol gcp_api \
  --fields '{
    "project_id": "my-gcp-project",
    "billing_dataset": "billing_data",
    "billing_table": "gcp_billing_export_v1_XXXXXX",
    "service_account_key": "<paste contents of billing-key.json>"
  }'
```

#### Step 4: Schedule Cost Sync Job

```typescript
await costSync.scheduleCostSync({
  provider: 'gcp',
  credentialId: 'gcp-billing-prod',
  schedule: '0 4 * * *',
  lookbackDays: 7,
  options: {
    groupBy: ['service', 'sku'],
    includeTags: true,
  }
});
```

### 4. General Ledger (GL) Import

**What it provides:**
- Cost center allocations
- Departmental budgets
- On-premise asset depreciation
- Capital expenditure (CapEx) and operational expenditure (OpEx) classification

**Supported GL Systems:**
- SAP ERP / S/4HANA
- Oracle Financials Cloud
- NetSuite
- Microsoft Dynamics 365
- CSV exports from any system

**Setup Steps:**

#### Step 1: Export GL Account Data

Export a CSV file from your GL system with these columns:

| Column | Required | Description |
|--------|----------|-------------|
| `account_number` | Yes | GL account code (e.g., "6100-100") |
| `account_name` | Yes | Account description (e.g., "IT Infrastructure") |
| `cost_center` | No | Cost center code (e.g., "CC-IT-001") |
| `fiscal_period` | Yes | YYYY-MM format (e.g., "2025-11") |
| `actual_cost` | Yes | Amount in local currency |
| `budgeted_cost` | No | Budget amount for variance analysis |
| `cost_category` | No | capex or opex |
| `resource_tower` | No | TBM tower (compute, storage, network, etc.) |

**Example CSV:**

```csv
account_number,account_name,cost_center,fiscal_period,actual_cost,budgeted_cost,cost_category,resource_tower
6100-100,Cloud Infrastructure,CC-IT-001,2025-11,125000,120000,opex,compute
6100-200,On-Prem Servers,CC-IT-001,2025-11,45000,50000,capex,compute
6200-100,Storage Systems,CC-IT-002,2025-11,32000,30000,opex,storage
6300-100,Network Equipment,CC-IT-003,2025-11,18000,20000,capex,network
```

#### Step 2: Import GL Data via API

```bash
# Upload CSV file
curl -X POST http://localhost:3000/api/v1/tbm/gl/import \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -F "file=@gl-costs-2025-11.csv" \
  -F "config={
    \"hasHeader\": true,
    \"delimiter\": \",\",
    \"columnMappings\": {
      \"accountNumber\": \"account_number\",
      \"accountName\": \"account_name\",
      \"costCenter\": \"cost_center\",
      \"fiscalPeriod\": \"fiscal_period\",
      \"actualCost\": \"actual_cost\",
      \"budgetedCost\": \"budgeted_cost\",
      \"costCategory\": \"cost_category\",
      \"resourceTower\": \"resource_tower\"
    }
  }"
```

#### Step 3: Map GL Accounts to TBM Cost Pools

Create mappings between GL accounts and TBM towers:

```sql
-- PostgreSQL: Create GL to TBM mappings
INSERT INTO tbm_gl_mappings (
  gl_account_code,
  gl_account_name,
  cost_pool_id,
  resource_tower,
  allocation_percentage
) VALUES
  ('6100-100', 'Cloud Infrastructure', 'pool-aws-compute', 'compute', 100),
  ('6100-200', 'On-Prem Servers', 'pool-onprem-compute', 'compute', 100),
  ('6200-100', 'Storage Systems', 'pool-storage', 'storage', 100),
  ('6300-100', 'Network Equipment', 'pool-network', 'network', 100);
```

#### Step 4: Automate Monthly GL Import

Create a monthly scheduled job:

```typescript
// Sync GL costs on the 1st of every month at 6:00 AM
await costSync.scheduleCostSync({
  provider: 'gl',
  credentialId: 'gl-import-config',
  schedule: '0 6 1 * *', // 1st of month
  options: {
    filePath: '/data/gl-exports/monthly-costs.csv',
    autoReconcile: true, // Compare GL vs Cloud costs
  }
});
```

### 5. CSV Import (Manual Upload)

For one-time imports or testing:

#### Step 1: Prepare CSV File

Create a CSV with cost data:

```csv
ci_id,ci_name,monthly_cost,fiscal_period,cost_category,resource_tower,notes
srv-web-01,Production Web Server,450.00,2025-11,opex,compute,AWS t3.xlarge
db-main-prod,Main Production Database,1200.00,2025-11,opex,data,RDS PostgreSQL
storage-backup,Backup Storage Array,320.00,2025-11,capex,storage,On-premise NAS
license-office365,Microsoft 365 E5,15.50,2025-11,opex,end_user,Per user/month
```

#### Step 2: Upload via Web UI

1. Navigate to **Financial Management** → **Cost Import**
2. Click **Upload CSV**
3. Select file and map columns
4. Review preview and click **Import**

#### Step 3: Upload via CLI

```bash
cmdb costs import \
  --file costs-november-2025.csv \
  --fiscal-period 2025-11 \
  --validate-cis \
  --dry-run # Preview before import
```

## Data Validation

### Verify Cost Data Quality

After importing costs, run these validation queries:

```sql
-- Check total costs by source system
SELECT
  source_system,
  COUNT(*) as cost_pool_count,
  SUM(monthly_cost) as total_monthly_cost,
  MAX(updated_at) as last_updated
FROM tbm_cost_pools
WHERE fiscal_period = '2025-11'
GROUP BY source_system;

-- Find CIs missing cost data
SELECT
  ci.ci_id,
  ci.ci_name,
  ci.ci_type,
  ci.discovery_provider
FROM dim_ci ci
WHERE ci.ci_status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM tbm_cost_pools tcp
    WHERE tcp.ci_id = ci.ci_id
      AND tcp.fiscal_period = '2025-11'
  )
LIMIT 50;

-- Check for anomalous costs (> $10,000/month for single CI)
SELECT
  ci_id,
  pool_name,
  monthly_cost,
  resource_tower,
  source_system
FROM tbm_cost_pools
WHERE fiscal_period = '2025-11'
  AND monthly_cost > 10000
ORDER BY monthly_cost DESC;
```

### Cost Reconciliation

Compare cloud provider costs with GL costs:

```sql
-- Reconciliation report: AWS Cloud vs GL
SELECT
  'AWS API' as source,
  SUM(monthly_cost) as total_cost
FROM tbm_cost_pools
WHERE source_system = 'aws'
  AND fiscal_period = '2025-11'

UNION ALL

SELECT
  'GL System' as source,
  SUM(actual_cost) as total_cost
FROM gl_accounts ga
JOIN tbm_gl_mappings tgm ON ga.account_number = tgm.gl_account_code
WHERE ga.fiscal_period = '2025-11'
  AND tgm.resource_tower IN ('compute', 'storage', 'network');
```

## Troubleshooting

### Issue 1: AWS Costs Not Importing

**Problem**: Zero costs in `tbm_cost_pools` for AWS resources

**Solutions**:

1. **Check AWS credentials:**
   ```bash
   # Test credentials
   aws ce get-cost-and-usage \
     --time-period Start=2025-11-01,End=2025-11-30 \
     --granularity MONTHLY \
     --metrics BlendedCost
   ```

2. **Verify Cost Explorer is enabled:**
   - AWS Console → Billing → Cost Explorer → Enable

3. **Check IAM permissions:**
   - Ensure user has `ce:GetCostAndUsage` permission

4. **Review sync job logs:**
   ```bash
   docker exec cmdb-api-server tail -f /var/log/cost-sync.log | grep AWS
   ```

### Issue 2: Duplicate Cost Entries

**Problem**: Costs are being imported multiple times for the same CI

**Solution**:

```sql
-- Find duplicate cost pools
SELECT
  ci_id,
  fiscal_period,
  source_system,
  COUNT(*) as duplicate_count
FROM tbm_cost_pools
GROUP BY ci_id, fiscal_period, source_system
HAVING COUNT(*) > 1;

-- Delete duplicates, keep newest
DELETE FROM tbm_cost_pools
WHERE id NOT IN (
  SELECT MAX(id)
  FROM tbm_cost_pools
  GROUP BY ci_id, fiscal_period, source_system
);
```

### Issue 3: GL CSV Import Fails

**Problem**: Error: "Column mapping not found"

**Solution**:

Ensure CSV has exact column names in `columnMappings`:

```json
{
  "columnMappings": {
    "accountNumber": "account_number",  // ← Must match CSV header exactly
    "accountName": "account_name",
    "fiscalPeriod": "fiscal_period"     // ← Case-sensitive
  }
}
```

### Issue 4: Costs Not Appearing in Dashboards

**Problem**: FinOps dashboard shows $0 for all resources

**Possible Causes**:

1. **ETL not syncing Neo4j → PostgreSQL:**
   ```bash
   # Check ETL job status
   docker exec cmdb-api-server npm run etl:status

   # Manually trigger CI sync
   docker exec cmdb-api-server npm run etl:sync-cis
   ```

2. **TBM enricher not running:**
   ```cypher
   // Neo4j: Check if CIs have tbm_attributes
   MATCH (ci:CI)
   RETURN
     COUNT(ci) as total_cis,
     COUNT(ci.tbm_attributes) as cis_with_tbm;
   ```

3. **Cost data not linked to CIs:**
   ```sql
   -- Check if cost pools have valid CI IDs
   SELECT
     COUNT(*) as total_cost_pools,
     COUNT(DISTINCT ci_id) as unique_cis,
     COUNT(CASE WHEN ci_id IS NULL THEN 1 END) as missing_ci_id
   FROM tbm_cost_pools
   WHERE fiscal_period = '2025-11';
   ```

## Best Practices

::: tip Cost Sync Frequency
- **Cloud costs**: Sync daily (costs can have 24-48 hour delays)
- **GL costs**: Sync monthly after books close (typically 5th of month)
- **License costs**: Sync quarterly unless using dynamic licensing
:::

::: warning Data Retention
Cost data is retained for 36 months (3 years) by default. Configure retention policy in `.env`:
```bash
TBM_COST_RETENTION_MONTHS=36
```
:::

::: tip Multi-Cloud Aggregation
For organizations using AWS + Azure + GCP, enable cross-cloud normalization:
```bash
TBM_NORMALIZE_CURRENCIES=true
TBM_BASE_CURRENCY=USD
TBM_EXCHANGE_RATE_API=https://api.exchangerate-api.com/v4/latest/USD
```
:::

## Configuration Examples

### Example 1: Full AWS + Azure + GL Setup

```yaml
# .env configuration
TBM_ENABLED=true
TBM_COST_SYNC_SCHEDULE=0 4 * * *  # Daily at 4:00 AM
TBM_GL_SYNC_SCHEDULE=0 6 1 * *     # Monthly on 1st at 6:00 AM
TBM_LOOKBACK_DAYS=7
TBM_COST_RETENTION_MONTHS=36
TBM_ENABLE_FORECASTING=true
TBM_ENABLE_ANOMALY_DETECTION=true
```

### Example 2: On-Premise Only (No Cloud)

```yaml
# .env configuration
TBM_ENABLED=true
TBM_CLOUD_SYNC_ENABLED=false
TBM_GL_SYNC_SCHEDULE=0 6 1 * *
TBM_ALLOW_MANUAL_CSV_IMPORT=true
```

## API Reference

### Trigger Cost Sync

**POST** `/api/v1/tbm/costs/sync`

**Authentication**: Required (JWT)

**Request Body**:
```json
{
  "provider": "aws",
  "credentialId": "aws-cost-explorer-prod",
  "lookbackDays": 7,
  "options": {
    "groupBy": ["SERVICE", "REGION"],
    "includeResourceTags": true
  }
}
```

**Response**:
```json
{
  "jobId": "cost-sync-1234567890",
  "status": "queued",
  "estimatedCompletion": "2025-11-17T04:15:00Z"
}
```

### Import GL CSV

**POST** `/api/v1/tbm/gl/import`

**Authentication**: Required (JWT)

**Request**: Multipart form-data
- `file`: CSV file
- `config`: JSON configuration

**Response**:
```json
{
  "imported": 245,
  "skipped": 12,
  "errors": [
    {
      "row": 15,
      "error": "Invalid fiscal_period format"
    }
  ],
  "summary": {
    "totalCost": 458920.50,
    "costPools": 18
  }
}
```

## Related Resources

- [TBM Framework Architecture](/architecture/tbm-framework)
- [FinOps Dashboard User Guide](/user-guides/finops-dashboard)
- [Cost Optimization Recommendations](/operations/cost-optimization)
- [Connector Configuration](/configuration/connectors)

## Next Steps

After integrating financial data:

- [ ] Verify costs appear in **FinOps Dashboard** (`/dashboards/finops`)
- [ ] Run TBM enrichment to update Neo4j CIs with cost attributes
- [ ] Set up cost alerts for budget overruns
- [ ] Configure Metabase dashboards for finance team reporting
- [ ] Enable cost forecasting and anomaly detection

---

**Last Updated**: 2025-11-17
**Maintainer**: HappyCMDB Team
