# Financial Management REST API

Complete REST API reference for v3.0 Technology Business Management (TBM) v5.0.1 cost transparency and financial operations.

## Overview

The Financial Management API provides comprehensive IT cost visibility, allocation, and optimization features based on TBM Framework v5.0.1. Track costs across towers, capabilities, and business services.

## Authentication

All API endpoints require authentication using a JWT bearer token:

```bash
Authorization: Bearer YOUR_JWT_TOKEN
```

## Base URL

```
http://localhost:3000/api/v1/tbm
```

---

## Cost Summary Endpoints

### Get Cost Summary

Get aggregated cost summary across all IT resources.

**Endpoint**: `GET /api/v1/tbm/costs/summary`

**Example Request**:
```bash
curl "http://localhost:3000/api/v1/tbm/costs/summary" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "totalMonthlyCost": 125450.75,
    "totalAnnualCost": 1505409.00,
    "costByEnvironment": {
      "production": 98500.50,
      "staging": 15250.25,
      "development": 11700.00
    },
    "costByProvider": {
      "aws": 75000.00,
      "azure": 35450.75,
      "gcp": 10000.00,
      "on-premises": 5000.00
    },
    "costByType": {
      "compute": 45000.00,
      "storage": 25000.00,
      "network": 15000.00,
      "database": 20450.75,
      "other": 20000.00
    },
    "period": {
      "month": "2025-11",
      "year": 2025
    },
    "lastUpdated": "2025-11-15T10:00:00Z"
  }
}
```

---

### Get Costs by Tower

Get costs grouped by TBM capability tower.

**Endpoint**: `GET /api/v1/tbm/costs/by-tower`

**Query Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tower` | string | No | Filter by specific tower |

**Supported Towers**:
- `compute` - Compute infrastructure
- `storage` - Storage and backup systems
- `network` - Networking and connectivity
- `data` - Data management and databases
- `security` - Security and compliance tools
- `end_user` - End user computing
- `facilities` - Data center facilities
- `risk_compliance` - Risk management and compliance
- `iot` - Internet of Things infrastructure
- `blockchain` - Blockchain infrastructure
- `quantum` - Quantum computing resources

**Example Request**:
```bash
curl "http://localhost:3000/api/v1/tbm/costs/by-tower?tower=compute" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "towers": [
      {
        "tower": "compute",
        "monthlyCost": 45000.00,
        "annualCost": 540000.00,
        "ciCount": 125,
        "percentOfTotal": 35.8,
        "topCosts": [
          {
            "ciId": "ci-prod-app-01",
            "ciName": "Production App Server 1",
            "monthlyCost": 2500.00
          }
        ]
      },
      {
        "tower": "storage",
        "monthlyCost": 25000.00,
        "annualCost": 300000.00,
        "ciCount": 50,
        "percentOfTotal": 19.9
      }
    ],
    "total": {
      "monthlyCost": 125450.75,
      "ciCount": 350
    }
  }
}
```

---

### Get Costs by Capability

Get costs for a specific business capability.

**Endpoint**: `GET /api/v1/tbm/costs/by-capability/:id`

**Example Request**:
```bash
curl "http://localhost:3000/api/v1/tbm/costs/by-capability/cap-ecommerce-001" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "capabilityId": "cap-ecommerce-001",
    "capabilityName": "E-Commerce Platform",
    "monthlyCost": 15250.50,
    "annualCost": 183006.00,
    "costBreakdown": {
      "compute": 8500.00,
      "storage": 3250.50,
      "network": 2000.00,
      "database": 1500.00
    },
    "allocatedCIs": [
      {
        "ciId": "ci-web-frontend-01",
        "ciName": "Web Frontend Server",
        "ciType": "server",
        "monthlyCost": 3500.00,
        "allocationMethod": "direct"
      },
      {
        "ciId": "ci-api-backend-01",
        "ciName": "API Backend Server",
        "ciType": "server",
        "monthlyCost": 4000.00,
        "allocationMethod": "direct"
      }
    ],
    "period": {
      "month": "2025-11",
      "year": 2025
    }
  }
}
```

---

### Get Costs by Business Service

Get costs allocated to a specific business service.

**Endpoint**: `GET /api/v1/tbm/costs/by-service/:id`

**Example Request**:
```bash
curl "http://localhost:3000/api/v1/tbm/costs/by-service/svc-customer-portal-001" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "serviceId": "svc-customer-portal-001",
    "serviceName": "Customer Portal",
    "tier": "tier_1",
    "monthlyCost": 8750.25,
    "annualCost": 105003.00,
    "costPerUser": 2.50,
    "activeUsers": 3500,
    "costBreakdown": {
      "infrastructure": 6000.00,
      "licenses": 1500.25,
      "support": 750.00,
      "labor": 500.00
    },
    "dependentCIs": [
      {
        "ciId": "ci-web-01",
        "ciName": "Portal Web Server",
        "monthlyCost": 2500.00
      },
      {
        "ciId": "ci-db-01",
        "ciName": "Portal Database",
        "monthlyCost": 1500.00
      }
    ],
    "period": {
      "month": "2025-11",
      "year": 2025
    }
  }
}
```

---

### Get Cost Trends

Get historical cost trends over time.

**Endpoint**: `GET /api/v1/tbm/costs/trends`

**Query Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `months` | number | No | Number of months to include (default: 6, max: 36) |

**Example Request**:
```bash
curl "http://localhost:3000/api/v1/tbm/costs/trends?months=12" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "trends": [
      {
        "month": "2024-12",
        "totalCost": 118500.00,
        "aws": 70000.00,
        "azure": 33500.00,
        "gcp": 10000.00,
        "onPremises": 5000.00
      },
      {
        "month": "2025-01",
        "totalCost": 120250.50,
        "aws": 71500.00,
        "azure": 33750.50,
        "gcp": 10000.00,
        "onPremises": 5000.00
      },
      {
        "month": "2025-11",
        "totalCost": 125450.75,
        "aws": 75000.00,
        "azure": 35450.75,
        "gcp": 10000.00,
        "onPremises": 5000.00
      }
    ],
    "summary": {
      "averageMonthlyCost": 121850.25,
      "lowestMonth": { "month": "2024-12", "cost": 118500.00 },
      "highestMonth": { "month": "2025-11", "cost": 125450.75 },
      "trend": "increasing",
      "percentageChange": 5.9
    },
    "periodStart": "2024-12",
    "periodEnd": "2025-11"
  }
}
```

---

## Cost Allocation Endpoints

### Allocate Costs

Allocate costs from a source CI to target business services, capabilities, or application services.

**Endpoint**: `POST /api/v1/tbm/costs/allocate`

**Request Body**:
```json
{
  "sourceId": "ci-shared-db-cluster-01",
  "targetType": "business_service",
  "targetIds": [
    "svc-customer-portal-001",
    "svc-admin-dashboard-002",
    "svc-reporting-003"
  ],
  "allocationMethod": "usage_based",
  "allocationRules": {
    "svc-customer-portal-001": 0.50,
    "svc-admin-dashboard-002": 0.30,
    "svc-reporting-003": 0.20
  }
}
```

**Allocation Methods**:
- `direct` - Direct 1:1 allocation
- `usage_based` - Allocate based on usage percentage (requires allocationRules)
- `equal` - Split equally among all targets

**Target Types**:
- `business_service` - Business service
- `business_capability` - Business capability
- `application_service` - Application service

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "sourceId": "ci-shared-db-cluster-01",
    "sourceName": "Shared Database Cluster",
    "sourceMonthlyCost": 5000.00,
    "allocations": [
      {
        "targetId": "svc-customer-portal-001",
        "targetName": "Customer Portal",
        "allocatedCost": 2500.00,
        "percentage": 50.0
      },
      {
        "targetId": "svc-admin-dashboard-002",
        "targetName": "Admin Dashboard",
        "allocatedCost": 1500.00,
        "percentage": 30.0
      },
      {
        "targetId": "svc-reporting-003",
        "targetName": "Reporting Service",
        "allocatedCost": 1000.00,
        "percentage": 20.0
      }
    ],
    "totalAllocated": 5000.00,
    "method": "usage_based",
    "createdAt": "2025-11-15T10:00:00Z"
  }
}
```

**Error Responses**:
- `400 Bad Request` - Invalid allocation data
- `404 Not Found` - Source or target CI does not exist
- `422 Unprocessable Entity` - Allocation rules don't sum to 100%

---

### Get Cost Allocations

Get all cost allocations for a specific CI.

**Endpoint**: `GET /api/v1/tbm/costs/allocations/:ciId`

**Example Request**:
```bash
curl "http://localhost:3000/api/v1/tbm/costs/allocations/ci-shared-db-cluster-01" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "ciId": "ci-shared-db-cluster-01",
    "ciName": "Shared Database Cluster",
    "monthlyCost": 5000.00,
    "allocations": [
      {
        "allocationId": "alloc-001",
        "targetType": "business_service",
        "targetId": "svc-customer-portal-001",
        "targetName": "Customer Portal",
        "allocatedCost": 2500.00,
        "percentage": 50.0,
        "method": "usage_based",
        "createdAt": "2025-11-01T00:00:00Z"
      },
      {
        "allocationId": "alloc-002",
        "targetType": "business_service",
        "targetId": "svc-admin-dashboard-002",
        "targetName": "Admin Dashboard",
        "allocatedCost": 1500.00,
        "percentage": 30.0,
        "method": "usage_based",
        "createdAt": "2025-11-01T00:00:00Z"
      }
    ],
    "totalAllocated": 4000.00,
    "unallocated": 1000.00
  }
}
```

---

## General Ledger Integration

### Import GL Data

Import General Ledger data from CSV or JSON format.

**Endpoint**: `POST /api/v1/tbm/gl/import`

**Content-Type**: `multipart/form-data` or `application/json`

**Request Body (JSON)**:
```json
{
  "format": "csv",
  "data": "Account,Description,Debit,Credit,Date\n5000,IT Infrastructure,125000.00,0,2025-11-01\n5100,Software Licenses,25000.00,0,2025-11-01",
  "mappings": {
    "accountField": "Account",
    "descriptionField": "Description",
    "amountField": "Debit",
    "dateField": "Date"
  },
  "options": {
    "skipHeader": true,
    "delimiter": ",",
    "dateFormat": "YYYY-MM-DD"
  }
}
```

**Request Body (File Upload)**:
```bash
curl -X POST "http://localhost:3000/api/v1/tbm/gl/import" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -F "file=@gl-export.csv" \
  -F "format=csv"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "importId": "import-gl-20251115-001",
    "recordsProcessed": 150,
    "recordsImported": 148,
    "recordsFailed": 2,
    "totalAmount": 150000.00,
    "errors": [
      {
        "row": 15,
        "error": "Invalid date format"
      },
      {
        "row": 47,
        "error": "Missing account number"
      }
    ],
    "importedAt": "2025-11-15T10:00:00Z"
  }
}
```

**Supported Formats**:
- `csv` - Comma-separated values
- `json` - JSON array of records
- `xlsx` - Excel spreadsheet (requires file upload)

**Error Responses**:
- `400 Bad Request` - Invalid file format or data
- `413 Payload Too Large` - File exceeds size limit (10MB)

---

## License Management

### Get Licenses

Get all software licenses and subscriptions.

**Endpoint**: `GET /api/v1/tbm/licenses`

**Query Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `vendor` | string | No | Filter by vendor name |
| `status` | string | No | Filter by status (active, expired, expiring_soon) |

**Example Request**:
```bash
curl "http://localhost:3000/api/v1/tbm/licenses?status=active" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "licenses": [
      {
        "licenseId": "lic-vmware-001",
        "vendor": "VMware",
        "product": "vSphere Enterprise Plus",
        "licenseKey": "XXXXX-XXXXX-XXXXX-XXXXX",
        "quantity": 50,
        "unitCost": 250.00,
        "monthlyCost": 1041.67,
        "annualCost": 12500.00,
        "purchaseDate": "2024-01-15",
        "expirationDate": "2026-01-14",
        "status": "active",
        "daysUntilExpiration": 425,
        "assignedCIs": [
          "ci-esxi-host-01",
          "ci-esxi-host-02"
        ]
      },
      {
        "licenseId": "lic-microsoft-001",
        "vendor": "Microsoft",
        "product": "Office 365 E3",
        "quantity": 500,
        "unitCost": 20.00,
        "monthlyCost": 10000.00,
        "annualCost": 120000.00,
        "subscriptionStart": "2023-06-01",
        "subscriptionEnd": "2026-05-31",
        "status": "active",
        "autoRenewal": true
      }
    ],
    "summary": {
      "totalLicenses": 2,
      "totalMonthlyCost": 11041.67,
      "totalAnnualCost": 132500.00,
      "expiringWithin90Days": 0
    }
  }
}
```

---

### Get Upcoming Renewals

Get licenses expiring within a specified timeframe.

**Endpoint**: `GET /api/v1/tbm/licenses/renewals`

**Query Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `days` | number | No | Days ahead to check (default: 90, max: 365) |

**Example Request**:
```bash
curl "http://localhost:3000/api/v1/tbm/licenses/renewals?days=180" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "renewals": [
      {
        "licenseId": "lic-oracle-001",
        "vendor": "Oracle",
        "product": "Database Enterprise Edition",
        "expirationDate": "2025-12-31",
        "daysUntilExpiration": 46,
        "annualCost": 75000.00,
        "autoRenewal": false,
        "renewalContact": "licensing@example.com",
        "urgency": "high"
      },
      {
        "licenseId": "lic-redhat-001",
        "vendor": "Red Hat",
        "product": "Enterprise Linux",
        "expirationDate": "2026-03-15",
        "daysUntilExpiration": 120,
        "annualCost": 15000.00,
        "autoRenewal": true,
        "urgency": "medium"
      }
    ],
    "summary": {
      "totalRenewals": 2,
      "totalRenewalCost": 90000.00,
      "urgencyBreakdown": {
        "high": 1,
        "medium": 1,
        "low": 0
      }
    },
    "lookAheadDays": 180
  }
}
```

**Urgency Levels**:
- `high` - Expiring within 60 days
- `medium` - Expiring within 61-120 days
- `low` - Expiring after 120 days

---

## TBM Attributes

All CIs in HappyCMDB v3.0 automatically receive TBM enrichment with the following attributes:

### TBM Attribute Structure

```json
{
  "tbm_attributes": {
    "capability_tower": "compute",
    "resource_pool": "production-compute",
    "cost_center": "IT-INFRA",
    "cost_allocation": {
      "direct": 2500.00,
      "allocated_from": [
        {
          "sourceId": "shared-network-01",
          "amount": 150.00
        }
      ],
      "allocated_to": [
        {
          "targetId": "svc-customer-portal",
          "amount": 1000.00
        }
      ]
    },
    "monthly_cost": 2500.00,
    "annual_cost": 30000.00,
    "unit_cost": 25.50,
    "cost_unit": "per_vcpu",
    "depreciation": {
      "purchase_price": 50000.00,
      "purchase_date": "2023-01-15",
      "useful_life_years": 5,
      "residual_value": 5000.00,
      "monthly_depreciation": 750.00,
      "accumulated_depreciation": 18000.00
    },
    "chargeback_enabled": true,
    "last_cost_update": "2025-11-15T10:00:00Z"
  }
}
```

### Capability Towers (TBM Framework v5.0.1)

- **Compute** - Servers, VMs, containers
- **Storage** - Storage arrays, backup systems
- **Network** - Switches, routers, load balancers
- **Data** - Databases, data warehouses
- **Security** - Firewalls, IDS/IPS, SIEM
- **End User** - Desktops, laptops, mobile devices
- **Facilities** - Data center space, power, cooling
- **Risk & Compliance** - Compliance tools, audit systems
- **IoT** - IoT gateways, edge devices
- **Blockchain** - Blockchain nodes, smart contracts
- **Quantum** - Quantum computing resources

---

## Cost Calculation Methods

### Direct Costs

Costs directly attributed to a CI:
- Cloud instance costs from provider APIs
- License costs from procurement systems
- Hardware depreciation
- Support contracts

### Allocated Costs

Costs allocated from shared resources:
- Network infrastructure allocated by bandwidth usage
- Storage allocated by capacity consumption
- Shared databases allocated by query volume

### Unit Cost Calculation

Unit costs enable showback and chargeback:

```
Unit Cost = Total Cost / Usage Metric
```

Examples:
- **Per vCPU**: `$2500 / 100 vCPUs = $25/vCPU`
- **Per GB**: `$1000 / 5000 GB = $0.20/GB`
- **Per User**: `$10000 / 500 users = $20/user`

---

## Integration with Cloud Providers

HappyCMDB automatically syncs cost data from cloud providers:

### AWS Cost Sync

- Uses AWS Cost Explorer API
- Retrieves daily cost and usage data
- Groups by service, region, and tags
- Updates costs in real-time

### Azure Cost Sync

- Uses Azure Cost Management API
- Retrieves subscription-level costs
- Groups by resource group and tags
- Daily sync schedule

### GCP Cost Sync

- Uses Cloud Billing API
- Retrieves project-level costs
- Groups by service and labels
- Real-time cost tracking

**Configuration**: See [Financial Data Integration Guide](/operations/financial-data-integration.md)

---

## Best Practices

1. **Regular Cost Reviews**: Review cost trends monthly to identify anomalies
2. **Tag Consistency**: Use consistent tags across environments for accurate tracking
3. **Cost Allocation**: Allocate shared resource costs for accurate chargeback
4. **License Management**: Track license expiration to avoid unplanned renewals
5. **Budget Alerts**: Set up alerts for cost thresholds
6. **Unit Economics**: Calculate unit costs for meaningful cost optimization
7. **Depreciation Tracking**: Maintain accurate depreciation for on-premises assets

---

## Migration from v2.0

### Breaking Changes

1. **New TBM Attributes**: All CIs now include TBM enrichment automatically
2. **Capability Towers**: Updated to TBM Framework v5.0.1 (11 towers)
3. **Cost Allocation API**: New allocation endpoints for shared resource costs
4. **License Management**: New license tracking and renewal management

### Migration Steps

1. **Cost Data**: Existing costs preserved, new TBM attributes added
2. **Tower Mapping**: CIs automatically mapped to appropriate capability towers
3. **GL Integration**: Import historical GL data using `/tbm/gl/import`
4. **License Import**: Add software licenses via UI or API
5. **Allocation Rules**: Configure cost allocation for shared resources

---

## See Also

- [Executive Dashboard User Guide](/user-guides/executive-dashboard.md) - Cost visibility for executives
- [FinOps Dashboard User Guide](/user-guides/finops-dashboard.md) - Financial operations guide
- [Components: TBM Cost Engine](/components/tbm-cost-engine.md) - TBM architecture overview
- [Operations: Financial Data Integration](/operations/financial-data-integration.md) - Cloud cost sync setup
