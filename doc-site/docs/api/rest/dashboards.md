# Dashboard REST API Reference

This document describes the REST API endpoints for HappyCMDB v3.0's Multi-Stakeholder Business Insights dashboards.

## Overview

The Dashboard API provides aggregated data for five specialized dashboards:

1. **Executive Dashboard** - Strategic IT spend, service health, and value metrics
2. **CIO Dashboard** - Operational KPIs, service availability, and capacity planning
3. **FinOps Dashboard** - Cost optimization, budget variance, and unit economics
4. **ITSM Dashboard** - Incident management, change tracking, and SLA compliance
5. **Business Service Dashboard** - Service-specific health, dependencies, and impact analysis

All dashboard endpoints return data optimized for visualization and decision-making, pulling from both Neo4j (real-time operational data) and PostgreSQL (historical analytics).

## Base URL

```
http://localhost:3000/api/v1/dashboards
```

## Authentication

All dashboard endpoints require JWT authentication.

```http
GET /api/v1/dashboards/executive
Authorization: Bearer <jwt_token>
```

See [Authentication Guide](/api/authentication) for JWT token generation.

## Endpoints

### GET /executive

Get Executive Dashboard summary data for strategic IT leadership.

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `days` | number | No | 30 | Time range in days (7, 30, 90, 365) |

**Example Request:**

```bash
curl -X GET "http://localhost:3000/api/v1/dashboards/executive?days=90" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "totalITSpend": 1245000.50,
    "costByCapability": [
      {
        "capability": "compute",
        "totalCost": 542000.00,
        "businessServices": [
          {
            "serviceId": "bs-ecommerce",
            "serviceName": "E-Commerce Platform",
            "monthlyCost": 125000.00,
            "applicationServices": [
              {
                "serviceId": "app-web-frontend",
                "serviceName": "Web Frontend",
                "monthlyCost": 45000.00
              }
            ]
          }
        ]
      }
    ],
    "costTrends": [
      {
        "month": "2025-09",
        "total": 1180000.00,
        "compute": 520000.00,
        "storage": 180000.00,
        "network": 120000.00,
        "data": 200000.00,
        "security": 90000.00,
        "applications": 70000.00,
        "budget": 1200000.00,
        "variance": -20000.00
      },
      {
        "month": "2025-10",
        "total": 1215000.00,
        "compute": 535000.00,
        "storage": 185000.00,
        "network": 125000.00,
        "data": 205000.00,
        "security": 92000.00,
        "applications": 73000.00,
        "budget": 1200000.00,
        "variance": 15000.00
      }
    ],
    "serviceHealthByTier": [
      {
        "tier": "tier_0",
        "averageHealthScore": 98.5,
        "serviceCount": 12,
        "trend": "stable"
      },
      {
        "tier": "tier_1",
        "averageHealthScore": 95.2,
        "serviceCount": 45,
        "trend": "improving"
      }
    ],
    "riskMatrix": {
      "services": [
        {
          "id": "bs-payment-gateway",
          "name": "Payment Gateway",
          "criticality": "tier_0",
          "riskLevel": "medium",
          "type": "application",
          "description": "PCI-compliant payment processing"
        }
      ]
    },
    "topCostDrivers": [
      {
        "serviceId": "bs-data-analytics",
        "serviceName": "Data Analytics Platform",
        "monthlyCost": 185000.00,
        "trend": "increasing",
        "changePercent": 12.5
      }
    ],
    "valueScorecard": [
      {
        "serviceId": "bs-ecommerce",
        "serviceName": "E-Commerce Platform",
        "annualRevenue": 25000000.00,
        "monthlyCost": 125000.00,
        "roi": 16.67,
        "customers": 125000
      }
    ]
  },
  "timeRange": {
    "days": 90,
    "startDate": "2025-08-17",
    "endDate": "2025-11-17"
  }
}
```

**Response Fields:**

- **totalITSpend**: Total monthly IT expenditure across all capability towers
- **costByCapability**: Breakdown by TBM capability towers (compute, storage, network, data, security, applications)
- **costTrends**: Historical monthly cost data with budget variance
- **serviceHealthByTier**: Average health scores by business criticality tier (tier_0 to tier_4)
- **riskMatrix**: Services requiring attention based on criticality and risk level
- **topCostDrivers**: Highest-cost services with trend analysis
- **valueScorecard**: Revenue, ROI, and customer impact metrics

**Error Response:**

```json
{
  "success": false,
  "error": "Failed to fetch executive dashboard",
  "message": "Neo4j connection timeout"
}
```

---

### GET /cio

Get CIO Dashboard operational metrics for IT leadership.

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `days` | number | No | 30 | Time range in days |

**Example Request:**

```bash
curl -X GET "http://localhost:3000/api/v1/dashboards/cio?days=30" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "serviceAvailability": [
      {
        "tier": "tier_0",
        "averageAvailability": 99.95,
        "slaTarget": 99.9,
        "complianceStatus": "compliant"
      },
      {
        "tier": "tier_1",
        "averageAvailability": 99.5,
        "slaTarget": 99.5,
        "complianceStatus": "at_risk"
      }
    ],
    "changeSuccessRates": {
      "successful": 142,
      "failed": 8,
      "rollbacks": 3,
      "total": 150,
      "successRate": 94.67
    },
    "incidentResponseTimes": [
      {
        "priority": "P1",
        "mttr": 25.4,
        "target": 30,
        "count": 12
      },
      {
        "priority": "P2",
        "mttr": 48.2,
        "target": 60,
        "count": 45
      }
    ],
    "configurationAccuracy": {
      "totalCIs": 8542,
      "accurateCIs": 8120,
      "accuracyPercentage": 95.06,
      "driftDetected": 422,
      "lastAuditDate": "2025-11-15T10:30:00Z"
    },
    "costByCapability": [
      {
        "capability": "compute",
        "cost": 542000.00,
        "budgetAllocated": 550000.00,
        "variance": -8000.00
      }
    ],
    "capacityPlanning": [
      {
        "month": "2025-12",
        "computeUtilization": 78.5,
        "storageUtilization": 82.3,
        "networkUtilization": 65.4,
        "forecast": 81.2
      }
    ]
  },
  "timeRange": {
    "days": 30,
    "startDate": "2025-10-17",
    "endDate": "2025-11-17"
  }
}
```

**Response Fields:**

- **serviceAvailability**: Availability percentages by tier with SLA compliance status
- **changeSuccessRates**: Change management success/failure/rollback statistics
- **incidentResponseTimes**: Mean Time To Repair (MTTR) by priority level
- **configurationAccuracy**: CMDB data quality metrics and drift detection
- **costByCapability**: Budget vs actual spending by capability tower
- **capacityPlanning**: Resource utilization forecasts

---

### GET /itsm

Get ITSM Dashboard data for incident and change management operations.

**Query Parameters:** None

**Example Request:**

```bash
curl -X GET "http://localhost:3000/api/v1/dashboards/itsm" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "openIncidents": [
      {
        "id": "INC0012345",
        "title": "Database connection pool exhaustion",
        "priority": "P1",
        "status": "in_progress",
        "affectedCI": "db-prod-main-01",
        "assignedTeam": "Database Team",
        "createdAt": "2025-11-17T08:15:00Z",
        "updatedAt": "2025-11-17T08:45:00Z",
        "age": 120
      }
    ],
    "changesInProgress": [
      {
        "id": "CHG0009876",
        "title": "Kubernetes cluster upgrade to v1.28",
        "status": "scheduled",
        "type": "normal",
        "riskLevel": "medium",
        "scheduledDate": "2025-11-20T02:00:00Z",
        "affectedCIs": ["k8s-prod-master-01", "k8s-prod-master-02", "k8s-prod-master-03"],
        "assignedTo": "Platform Engineering",
        "createdAt": "2025-11-10T14:00:00Z"
      }
    ],
    "ciStatus": [
      {
        "status": "active",
        "count": 7245,
        "cis": [
          {
            "ci_id": "srv-web-01",
            "name": "Production Web Server 01",
            "type": "virtual-machine",
            "status": "active",
            "environment": "production",
            "lastSeen": "2025-11-17T10:00:00Z"
          }
        ]
      },
      {
        "status": "maintenance",
        "count": 12,
        "cis": []
      }
    ],
    "topFailingCIs": [],
    "slaCompliance": {
      "p1": {
        "target": 95.0,
        "actual": 98.2,
        "breaches": 2
      },
      "p2": {
        "target": 90.0,
        "actual": 88.7,
        "breaches": 8
      }
    },
    "baselineCompliance": []
  }
}
```

**Response Fields:**

- **openIncidents**: Currently open incidents with priority, status, and age
- **changesInProgress**: Scheduled and in-progress changes
- **ciStatus**: CI inventory broken down by status (active, maintenance, decommissioned, inactive)
- **topFailingCIs**: CIs with the most incidents (requires ITIL data)
- **slaCompliance**: SLA target vs actual performance by priority
- **baselineCompliance**: Configuration baseline drift detection (future feature)

---

### GET /finops

Get FinOps Dashboard data for cost optimization and financial operations.

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `days` | number | No | 30 | Time range in days |

**Example Request:**

```bash
curl -X GET "http://localhost:3000/api/v1/dashboards/finops?days=90" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "cloudCostsByProvider": [
      {
        "provider": "aws",
        "monthlyCost": 485000.00,
        "ciCount": 1245,
        "trend": "increasing",
        "changePercent": 8.5
      },
      {
        "provider": "azure",
        "monthlyCost": 220000.00,
        "ciCount": 542,
        "trend": "stable",
        "changePercent": 1.2
      }
    ],
    "onPremVsCloud": {
      "cloud": {
        "cost": 780000.00,
        "ciCount": 1950,
        "providers": ["aws", "azure", "gcp"]
      },
      "onPrem": {
        "cost": 465000.00,
        "ciCount": 1245,
        "depreciation": 125000.00
      }
    },
    "budgetVariance": [
      {
        "capability": "compute",
        "actual": 542000.00,
        "budgeted": 550000.00,
        "variance": -8000.00,
        "variancePercent": -1.45
      }
    ],
    "unitEconomics": [
      {
        "metric": "cost_per_user",
        "value": 25.50,
        "unit": "USD/user/month",
        "trend": "decreasing"
      },
      {
        "metric": "cost_per_transaction",
        "value": 0.15,
        "unit": "USD/transaction",
        "trend": "stable"
      }
    ],
    "costOptimizationOpportunities": [
      {
        "ciId": "srv-analytics-dev-05",
        "ciName": "Analytics Development Server 05",
        "currentCost": 245.00,
        "potentialSavings": 145.00,
        "recommendation": "Downsize from m5.2xlarge to m5.xlarge",
        "category": "rightsizing",
        "priority": "medium"
      },
      {
        "ciId": "vol-backup-logs-old",
        "ciName": "Old Log Backup Volume",
        "currentCost": 180.00,
        "potentialSavings": 160.00,
        "recommendation": "Delete unused backup volume (>90 days old)",
        "category": "unused_resources",
        "priority": "high"
      }
    ]
  },
  "timeRange": {
    "days": 90,
    "startDate": "2025-08-17",
    "endDate": "2025-11-17"
  }
}
```

**Response Fields:**

- **cloudCostsByProvider**: Monthly cloud spend by provider (AWS, Azure, GCP)
- **onPremVsCloud**: Cost comparison between cloud and on-premise infrastructure
- **budgetVariance**: Actual vs budgeted costs by capability tower
- **unitEconomics**: Cost per user, cost per transaction, and other business metrics
- **costOptimizationOpportunities**: AI-powered recommendations for cost savings

---

### GET /business-service/:serviceId?

Get Business Service Dashboard data for a specific service or all services.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `serviceId` | string | No | Business service ID (e.g., "bs-ecommerce") |

**Query Parameters:** None

**Example Request (Specific Service):**

```bash
curl -X GET "http://localhost:3000/api/v1/dashboards/business-service/bs-ecommerce" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**Example Request (All Services):**

```bash
curl -X GET "http://localhost:3000/api/v1/dashboards/business-service" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**Example Response:**

```json
{
  "success": true,
  "data": {
    "service": {
      "id": "bs-ecommerce",
      "name": "E-Commerce Platform",
      "tier": "tier_0",
      "healthScore": 97.5,
      "description": "Customer-facing online store and checkout"
    },
    "dependencyGraph": {
      "nodes": [
        {
          "id": "bs-ecommerce",
          "name": "E-Commerce Platform",
          "type": "business_service",
          "criticality": "tier_0"
        },
        {
          "id": "srv-web-01",
          "name": "Web Frontend Server",
          "type": "virtual-machine",
          "criticality": "tier_1"
        }
      ],
      "edges": [
        {
          "source": "bs-ecommerce",
          "target": "srv-web-01",
          "type": "USES",
          "criticality": "critical"
        }
      ]
    },
    "impactMetrics": {
      "totalCIs": 42,
      "criticalCIs": 12,
      "tier0CIs": 12,
      "tier1CIs": 18,
      "tier2CIs": 12,
      "totalMonthlyCost": 125000.00,
      "annualRevenue": 25000000.00,
      "customersFacing": true,
      "customersAffected": 125000
    },
    "kpis": [
      {
        "name": "Availability",
        "value": 99.95,
        "unit": "%",
        "target": 99.9,
        "status": "healthy"
      },
      {
        "name": "Response Time",
        "value": 245,
        "unit": "ms",
        "target": 300,
        "status": "healthy"
      }
    ],
    "recentIncidents": [
      {
        "id": "INC0012340",
        "title": "Slow checkout performance",
        "priority": "P2",
        "status": "resolved",
        "createdAt": "2025-11-15T14:20:00Z",
        "resolvedAt": "2025-11-15T16:45:00Z",
        "mttr": 145
      }
    ],
    "upcomingChanges": [
      {
        "id": "CHG0009880",
        "title": "Deploy new checkout flow v2.5",
        "scheduledDate": "2025-11-22T02:00:00Z",
        "riskLevel": "low"
      }
    ]
  }
}
```

**Response Fields:**

- **service**: Business service metadata (ID, name, tier, health score)
- **dependencyGraph**: Neo4j graph visualization data (nodes and edges)
- **impactMetrics**: CI count, cost, revenue, and customer impact
- **kpis**: Service-specific KPIs (availability, performance, throughput, etc.)
- **recentIncidents**: Recent incidents affecting this service
- **upcomingChanges**: Scheduled changes that may impact this service

---

## Common Patterns

### Time Range Filtering

All dashboards with a `days` query parameter support these common values:

| Value | Description | Use Case |
|-------|-------------|----------|
| 7 | Last 7 days | Weekly operational reviews |
| 30 | Last 30 days | Monthly reports (default) |
| 90 | Last 90 days | Quarterly business reviews |
| 365 | Last 12 months | Annual strategic planning |

### Response Structure

All dashboard endpoints return a consistent structure:

```json
{
  "success": true,
  "data": {
    // Dashboard-specific data
  },
  "timeRange": {
    "days": 30,
    "startDate": "2025-10-17",
    "endDate": "2025-11-17"
  }
}
```

### Error Handling

All endpoints return errors in this format:

```json
{
  "success": false,
  "error": "Failed to fetch <dashboard-name> dashboard",
  "message": "Specific error message (e.g., Neo4j connection timeout)"
}
```

**HTTP Status Codes:**

| Code | Meaning | Common Cause |
|------|---------|--------------|
| 200 | Success | Data fetched successfully |
| 401 | Unauthorized | Missing or invalid JWT token |
| 500 | Internal Server Error | Database connection failure, query error |

## Rate Limiting

Dashboard endpoints are not rate-limited. However, caching is strongly recommended for production use:

```http
GET /api/v1/dashboards/executive
Cache-Control: max-age=300  # Cache for 5 minutes
```

## Best Practices

::: tip Caching
Dashboard data is computationally expensive. Implement client-side caching with a 5-minute TTL to reduce server load:

```typescript
const CACHE_TTL = 300000; // 5 minutes
const cachedData = localStorage.getItem('executive_dashboard');
const cachedTime = localStorage.getItem('executive_dashboard_time');

if (cachedData && Date.now() - cachedTime < CACHE_TTL) {
  return JSON.parse(cachedData);
}
```
:::

::: warning Historical Data
Cost trends and capacity planning data depend on ETL jobs syncing Neo4j → PostgreSQL. If historical data is missing, verify:
- ETL scheduler is running (`packages/etl-processor`)
- `fact_cost` and `fact_incidents` tables are populated
:::

::: tip Performance
For large environments (>10,000 CIs), dashboard queries may take 2-5 seconds. Consider:
- Pre-aggregating data with scheduled ETL jobs
- Using PostgreSQL materialized views
- Implementing Redis caching layer
:::

## Related Resources

- [Executive Dashboard User Guide](/user-guides/executive-dashboard)
- [CIO Dashboard User Guide](/user-guides/cio-dashboard)
- [FinOps Dashboard User Guide](/user-guides/finops-dashboard)
- [ITSM Operations Guide](/user-guides/itsm-operations)
- [Business Service Dashboard Guide](/user-guides/service-owner-guide)
- [Authentication API](/api/authentication)

---

**Last Updated**: 2025-11-17
**Maintainer**: HappyCMDB Team
