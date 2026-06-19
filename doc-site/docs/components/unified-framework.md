# Unified Framework Integration

HappyCMDB v3.0 unifies **ITIL v4**, **TBM v5.0.1**, and **BSM** (Business Service Mapping) frameworks into a single, cohesive platform that provides complete 360° visibility into IT services. The Unified Framework eliminates data silos and provides enriched incident management, unified change risk assessment, and comprehensive service views that combine operational, financial, and business impact perspectives.

## Overview

The Unified Framework Integration (`@cmdb/framework-integration`) orchestrates three industry-standard frameworks:

- **ITIL v4**: IT service management (incidents, changes, configuration management)
- **TBM v5.0.1**: Technology Business Management (cost transparency, optimization)
- **BSM**: Business Service Mapping (business impact, criticality, risk)

### Key Benefits

- **360° Service Visibility**: Single view combining operational health, costs, and business impact
- **Context-Rich Incident Management**: Auto-enrichment with priority, cost, and blast radius
- **Intelligent Change Risk Assessment**: Multi-framework risk analysis with approval routing
- **Unified KPIs**: 10 cross-framework metrics for holistic service understanding
- **Executive Dashboards**: Business-relevant views for C-level stakeholders

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│           Unified Service Interface (Orchestrator)          │
└────────┬────────────────┬────────────────┬─────────────────┘
         │                │                │
    ┌────▼─────┐    ┌────▼─────┐    ┌────▼─────┐
    │   ITIL   │    │   TBM    │    │   BSM    │
    │ Service  │    │  Cost    │    │ Impact   │
    │ Manager  │    │ Engine   │    │ Engine   │
    └────┬─────┘    └────┬─────┘    └────┬─────┘
         │                │                │
    ┌────▼────────────────▼────────────────▼─────┐
    │        Unified Data Model (v3.0)           │
    │   (Neo4j Graph + PostgreSQL + Redis)       │
    └────────────────────────────────────────────┘
```

The Unified Service Interface acts as the orchestrator, calling framework-specific managers in parallel and combining results into unified views.

---

## Complete Service Views

Complete Service Views provide a comprehensive snapshot of any business service, combining data from all three frameworks.

### Data Structure

```typescript
interface CompleteServiceView {
  serviceId: string;              // Business service ID
  serviceName: string;            // Service name
  serviceDescription: string;     // Service description

  itil: ITILMetrics;              // ITIL operational metrics
  tbm: TBMCosts;                  // TBM cost transparency
  bsm: BSMImpact;                 // BSM business impact
  kpis: UnifiedKPIs;              // 10 unified KPIs

  businessService: BusinessService;  // Full service entity
  generatedAt: Date;              // View timestamp
  cacheTTL: number;               // Cache duration (seconds)
}
```

### Example: Payment Processing Service

```json
{
  "serviceId": "bs-payment-001",
  "serviceName": "Payment Processing Service",
  "serviceDescription": "Core payment gateway handling all customer transactions",

  "itil": {
    "openIncidents": 2,
    "averageMTTR": 45,
    "changesLast30Days": 12,
    "changeSuccessRate": 0.917,
    "availability": 0.9998,
    "criticalIncidents": 0,
    "baselinedCIs": 24,
    "driftedCIs": 1,
    "baselineCompliance": 95.8
  },

  "tbm": {
    "monthlyCost": 125000,
    "costByTower": [
      { "tower": "compute", "cost": 65000 },
      { "tower": "storage", "cost": 25000 },
      { "tower": "network", "cost": 15000 },
      { "tower": "database", "cost": 20000 }
    ],
    "costTrend": "stable",
    "budgetVariance": 5000,
    "allocationPercentage": 98
  },

  "bsm": {
    "criticality": "tier_0",
    "impactScore": 98,
    "annualRevenue": 450000000,
    "customerCount": 2500000,
    "userCount": 350000,
    "transactionVolume": 500000,
    "customerFacing": true,
    "revenueAtRiskPerHour": 51370,
    "rto": 15,
    "rpo": 5
  },

  "kpis": {
    "serviceHealth": 96.5,
    "costEfficiency": {
      "costPerTransaction": 0.0083,
      "costPerUser": 3.57,
      "costPerRevenue": 0.0033,
      "trend": "stable",
      "budgetVariance": 5000
    },
    "riskScore": 18.2,
    "valueScore": 300,
    "complianceScore": 95.8,
    "availability": 99.98,
    "roi": 2.99,
    "mttr": 45,
    "mtbf": 720,
    "changeSuccessRate": 91.7
  }
}
```

---

## Unified KPIs

HappyCMDB v3.0 provides **10 unified KPIs** that synthesize data from all three frameworks:

### 1. Service Health Score (0-100)

**Definition**: Composite metric measuring overall service operational health.

**Formula**:
```
Service Health = (Availability × 40%) + (Incident Score × 30%) +
                 (Change Score × 20%) + (Compliance Score × 10%)

Where:
- Availability Score = Availability × 100
- Incident Score = max(0, 100 - (Open Incidents × 10))
- Change Score = Change Success Rate × 100
- Compliance Score = Baseline Compliance
```

**Targets**:
- **Excellent**: 90-100 (Green)
- **Good**: 75-89 (Yellow)
- **Poor**: 60-74 (Orange)
- **Critical**: <60 (Red)

**Use Cases**:
- Executive dashboards
- Service health monitoring
- SLA compliance tracking

---

### 2. Cost Efficiency

**Definition**: Multi-dimensional measure of cost effectiveness.

**Metrics**:
```typescript
interface CostEfficiency {
  costPerTransaction: number;    // Monthly cost / (Daily transactions × 30)
  costPerUser: number;           // Monthly cost / Active users
  costPerRevenue: number;        // Annual cost / Annual revenue
  trend: 'increasing' | 'stable' | 'decreasing';
  budgetVariance: number;        // Positive = under budget
}
```

**Targets**:
- **Cost per Transaction**: Industry-specific (e.g., <$0.01 for payments)
- **Cost per User**: <$5/user/month for SaaS
- **Cost per Revenue**: <5% for high-value services

**Use Cases**:
- FinOps optimization
- Budget planning
- Cost benchmarking

---

### 3. Risk Score (0-100)

**Definition**: Aggregated risk level considering criticality, incidents, drift, and compliance.

**Formula**:
```
Risk Score = (Criticality Risk × 30%) + (Incident Risk × 30%) +
             (Drift Risk × 20%) + (Compliance Risk × 20%)

Where:
- Criticality Risk: Tier 0 = 100, Tier 1 = 75, Tier 2 = 50, Tier 3 = 25, Tier 4 = 10
- Incident Risk: min(100, Critical Incidents × 20)
- Drift Risk: (Drifted CIs / Baselined CIs) × 100
- Compliance Risk: Non-compliant = 100, Unknown = 50, Compliant = 0
```

**Risk Levels**:
- **Critical**: 80-100 (Requires immediate attention)
- **High**: 60-79 (Prioritize remediation)
- **Medium**: 40-59 (Monitor closely)
- **Low**: 0-39 (Normal operations)

**Use Cases**:
- Risk dashboards
- Change approval decisions
- Audit preparation

---

### 4. Value Score

**Definition**: Revenue-to-cost ratio measuring business value delivered per IT dollar spent.

**Formula**:
```
Value Score = (Annual Revenue / 12) / Monthly Cost

Example:
- Monthly Revenue: $450M / 12 = $37.5M
- Monthly Cost: $125K
- Value Score: 37,500,000 / 125,000 = 300
```

**Classification**:
- **High Value**: Score ≥ 5 (Revenue services)
- **Medium Value**: Score 2-4.99 (Balanced services)
- **Low Value**: Score 1-1.99 (Support services)
- **Cost Center**: Score < 1 (Infrastructure, overhead)

**Use Cases**:
- Investment prioritization
- Service portfolio optimization
- Executive reporting

---

### 5. Compliance Score (0-100)

**Definition**: Configuration baseline adherence percentage.

**Formula**:
```
Compliance Score = (Compliant CIs / Total Baselined CIs) × 100
```

**Targets**:
- **Excellent**: 95-100%
- **Good**: 85-94%
- **Needs Improvement**: 70-84%
- **Non-Compliant**: <70%

**Use Cases**:
- Audit readiness
- Change freeze periods
- Compliance reporting

---

### 6. Availability (Percentage)

**Definition**: Service uptime percentage (directly from ITIL).

**Formula**:
```
Availability = (Uptime / Total Time) × 100
```

**SLA Targets**:
- **Tier 0 (Mission-Critical)**: 99.99% (52 min/year downtime)
- **Tier 1 (Business-Critical)**: 99.95% (4.4 hours/year)
- **Tier 2 (Important)**: 99.9% (8.76 hours/year)
- **Tier 3 (Standard)**: 99.5% (43.8 hours/year)
- **Tier 4 (Low Priority)**: 99% (3.65 days/year)

---

### 7. ROI (Return on Investment)

**Definition**: Financial return generated per dollar invested in IT service.

**Formula**:
```
ROI = ((Monthly Revenue - Monthly Cost) / Monthly Cost) × 100

Example:
- Monthly Revenue: $37.5M
- Monthly Cost: $125K
- ROI: ((37,500,000 - 125,000) / 125,000) × 100 = 299.9% (or 2.99 as ratio)
```

**Interpretation**:
- **Positive ROI**: Service generates more value than it costs
- **Negative ROI**: Service costs more than it generates (infrastructure, support services)

---

### 8. MTTR (Mean Time to Resolution)

**Definition**: Average time (in minutes) to resolve incidents.

**Formula**:
```
MTTR = Σ(Resolution Time) / Number of Resolved Incidents
```

**Targets by Priority**:
- **P1 (Critical)**: 60 minutes
- **P2 (High)**: 240 minutes (4 hours)
- **P3 (Medium)**: 480 minutes (8 hours)
- **P4 (Low)**: 1440 minutes (24 hours)
- **P5 (Planning)**: 2880 minutes (48 hours)

---

### 9. MTBF (Mean Time Between Failures)

**Definition**: Average time (in hours) between critical incidents.

**Formula**:
```
MTBF = Total Operating Time / Number of Critical Incidents

Example:
- 30 days = 720 hours
- 2 critical incidents
- MTBF = 720 / 2 = 360 hours (15 days)
```

**Targets**:
- **Excellent**: >720 hours (30+ days)
- **Good**: 360-720 hours (15-30 days)
- **Needs Improvement**: 168-360 hours (7-15 days)
- **Critical**: <168 hours (<7 days)

---

### 10. Change Success Rate (Percentage)

**Definition**: Percentage of changes completed successfully without rollback.

**Formula**:
```
Change Success Rate = (Successful Changes / Total Changes) × 100
```

**Targets**:
- **Excellent**: ≥95%
- **Good**: 90-94%
- **Acceptable**: 85-89%
- **Needs Improvement**: <85%

---

## Enriched Incident Management

Enriched Incident Management automatically augments incident records with multi-framework context during creation.

### Auto-Enrichment Process

```
┌──────────────────┐
│ Create Incident  │ (Basic: CI, Title, Description)
└────────┬─────────┘
         │
    ┌────▼────────────────────────────────────┐
    │  Unified Framework Auto-Enrichment      │
    └────┬─────────┬──────────┬───────────────┘
         │         │          │
    ┌────▼────┐ ┌─▼──────┐ ┌─▼──────────┐
    │  ITIL   │ │  BSM   │ │    TBM     │
    │Priority │ │ Impact │ │Downtime $  │
    └────┬────┘ └─┬──────┘ └─┬──────────┘
         │        │          │
    ┌────▼────────▼──────────▼───────────┐
    │    Enriched Incident Record        │
    │ + Priority, Response Team, Cost,   │
    │   Blast Radius, Recommendations    │
    └────────────────────────────────────┘
```

### Enrichment Data

```typescript
interface EnrichedIncident {
  // Basic incident fields
  id: string;
  title: string;
  description: string;
  affectedCIId: string;

  // ITIL enrichment
  itilPriority: {
    priority: number;              // 1-5 (Impact × Urgency)
    impact: 'critical' | 'high' | 'medium' | 'low';
    urgency: 'critical' | 'high' | 'medium' | 'low';
    reasoning: string;
    requiresEscalation: boolean;
  };

  // BSM enrichment
  businessImpact: {
    criticality: BusinessCriticality;
    impactScore: number;           // 0-100
    customersImpacted: number;
    revenueAtRiskPerHour: number;
    complianceImpact: string;
  };
  blastRadius: {
    totalCIsImpacted: number;
    totalServicesImpacted: number;
    totalCustomersImpacted: number;
    totalRevenueAtRisk: number;
  };

  // TBM enrichment
  downtimeCostPerHour: number;
  totalEstimatedCost: number;      // Cost × Estimated Duration

  // Unified orchestration
  responseTeam: string[];          // Auto-assigned by criticality
  escalationRequired: boolean;
  executiveNotificationRequired: boolean;
  recommendedActions: string[];
  targetResponseTime: number;      // Minutes
  targetResolutionTime: number;    // Minutes
}
```

### Response Team Assignment

Response teams are auto-assigned based on **business criticality** (from BSM):

| Criticality | Response Team |
|-------------|---------------|
| **Tier 0** (Business-Stopping) | Executive On-Call, Senior SRE Team, Product Management, Customer Success |
| **Tier 1** (Business-Critical) | Senior SRE Team, Platform Engineering, Product On-Call |
| **Tier 2** (Important) | Platform Engineering, Application Support |
| **Tier 3** (Standard) | Application Support |
| **Tier 4** (Low Priority) | Service Desk |

### Example: Enriched Incident Creation

**Input (Basic Incident)**:
```json
{
  "affectedCIId": "ci-prod-db-001",
  "title": "Database connection pool exhausted",
  "description": "Production database rejecting connections",
  "reportedBy": "monitoring@company.com",
  "symptoms": ["Connection timeouts", "Error rate spike"]
}
```

**Output (Enriched Incident)**:
```json
{
  "id": "inc-20251106-001",
  "title": "Database connection pool exhausted",
  "description": "Production database rejecting connections",
  "affectedCIId": "ci-prod-db-001",
  "affectedCIName": "Production PostgreSQL Primary",

  "itilPriority": {
    "priority": 1,
    "impact": "critical",
    "urgency": "critical",
    "reasoning": "Affects business-stopping service with complete service outage",
    "requiresEscalation": true
  },

  "businessImpact": {
    "criticality": "tier_0",
    "impactScore": 98,
    "customersImpacted": 2500000,
    "revenueAtRiskPerHour": 51370,
    "complianceImpact": "high"
  },

  "blastRadius": {
    "totalCIsImpacted": 47,
    "totalServicesImpacted": 12,
    "totalCustomersImpacted": 2500000,
    "totalRevenueAtRisk": 102740
  },

  "downtimeCostPerHour": 125000,
  "totalEstimatedCost": 250000,

  "responseTeam": [
    "Executive On-Call",
    "Senior SRE Team",
    "Product Management",
    "Customer Success"
  ],
  "escalationRequired": true,
  "executiveNotificationRequired": true,

  "recommendedActions": [
    "Initiate emergency response protocol",
    "Notify executive leadership immediately",
    "Update status page",
    "Prepare customer communication",
    "Assemble war room with all affected service owners",
    "Enable detailed logging and monitoring",
    "Prepare rollback plan if change-related"
  ],

  "targetResponseTime": 15,
  "targetResolutionTime": 60,
  "enrichedAt": "2025-11-06T10:23:45Z"
}
```

---

## Unified Change Risk Assessment

Unified Change Risk Assessment combines risk factors from all three frameworks to provide comprehensive change approval guidance.

### Multi-Framework Risk Analysis

```
┌──────────────────┐
│ Change Request   │
└────────┬─────────┘
         │
    ┌────▼─────────────────────────────────────┐
    │  Unified Risk Assessment                 │
    └────┬───────────┬──────────┬──────────────┘
         │           │          │
    ┌────▼────┐ ┌────▼────┐ ┌──▼──────────┐
    │  ITIL   │ │   BSM   │ │    TBM      │
    │  Risk   │ │ Impact  │ │ Cost Est.   │
    │ (5 fac) │ │Analysis │ │             │
    └────┬────┘ └────┬────┘ └──┬──────────┘
         │           │          │
    ┌────▼───────────▼──────────▼──────────┐
    │    Unified Change Risk Report        │
    │  + Overall Risk, Approvals Required  │
    │  + Optimal Change Window, Recs       │
    └──────────────────────────────────────┘
```

### Risk Assessment Components

#### 1. ITIL Risk Factors (5-Factor Model)

From `@cmdb/itil-service-manager`:

| Factor | Weight | Description |
|--------|--------|-------------|
| **Complexity** | 25% | Number of affected CIs, implementation steps |
| **Business Impact** | 30% | Service criticality, customer-facing |
| **Implementation Risk** | 20% | Team experience, rollback difficulty |
| **Testing Coverage** | 15% | Test plan completeness, environment parity |
| **Timing Risk** | 10% | Business hours, freeze periods |

**ITIL Risk Score**: 0-100 (weighted average)

**Risk Levels**:
- **Very High**: 75-100 (CAB required)
- **High**: 50-74 (Management approval required)
- **Medium**: 25-49 (Team lead approval)
- **Low**: 0-24 (Standard approval)

#### 2. BSM Business Impact

From `@cmdb/bsm-impact-engine`:

- Business criticality tier (Tier 0-4)
- Customers impacted
- Revenue at risk
- Compliance frameworks affected
- Customer-facing indicator

#### 3. TBM Cost Estimation

From `@cmdb/tbm-cost-engine`:

```typescript
interface CostEstimate {
  laborCost: number;               // Implementation hours × rate
  estimatedDowntimeMinutes: number;
  downtimeCost: number;
  rollbackCost: number;
  testingCost: number;
  totalCost: number;
  riskAdjustedCost: number;        // Total × (1 + Risk Factor)
  confidence: 'high' | 'medium' | 'low';
}
```

### Approval Requirements

Approval requirements are automatically determined based on:

| Approval Type | Trigger Conditions |
|---------------|-------------------|
| **CAB Approval** | ITIL risk ≥ High OR Overall risk = Very High |
| **Executive Approval** | Criticality = Tier 0 |
| **Finance Approval** | Total cost > $50,000 |
| **Security Approval** | Compliance impact ≠ None |
| **Compliance Approval** | Affects regulated frameworks (SOX, HIPAA, PCI-DSS) |

### Example: Unified Change Risk Assessment

**Input (Change Request)**:
```json
{
  "affectedCIIds": ["ci-prod-app-001", "ci-prod-lb-001"],
  "title": "Deploy new authentication service",
  "description": "Migrate from legacy auth to OAuth 2.0",
  "changeType": "major",
  "category": "upgrade",
  "plannedStart": "2025-11-15T02:00:00Z",
  "plannedEnd": "2025-11-15T06:00:00Z",
  "implementationPlan": "1. Deploy new auth service...",
  "backoutPlan": "Revert load balancer config...",
  "requestedBy": "engineering@company.com"
}
```

**Output (Unified Risk Assessment)**:
```json
{
  "changeId": "chg-20251106-002",
  "changeTitle": "Deploy new authentication service",
  "changeType": "major",

  "itilRisk": {
    "overallRiskScore": 68,
    "riskLevel": "high",
    "requiresCABApproval": true,
    "factors": {
      "complexity": 75,
      "businessImpact": 90,
      "implementationRisk": 60,
      "testingCoverage": 80,
      "timingRisk": 20
    },
    "recommendations": [
      "Conduct comprehensive testing in staging environment",
      "Prepare detailed rollback procedures",
      "Schedule during maintenance window"
    ]
  },

  "businessImpact": {
    "criticality": "tier_1",
    "impactScore": 85,
    "customersImpacted": 2500000,
    "revenueAtRiskPerHour": 51370,
    "complianceFrameworks": ["SOC2", "GDPR"],
    "complianceImpact": "high"
  },

  "costEstimate": {
    "laborCost": 12000,
    "estimatedDowntimeMinutes": 30,
    "downtimeCost": 25685,
    "rollbackCost": 3000,
    "testingCost": 5000,
    "totalCost": 45685,
    "riskAdjustedCost": 76449,
    "confidence": "medium"
  },

  "approvalRequirements": {
    "cabApproval": true,
    "businessOwnerApproval": true,
    "technicalOwnerApproval": true,
    "executiveApproval": false,
    "financeApproval": false,
    "securityApproval": true,
    "complianceApproval": true,
    "estimatedApprovalDuration": 48,
    "approvalReasons": [
      "High ITIL risk score: 68",
      "Compliance scope: SOC2, GDPR",
      "Affects 2.5M customers"
    ]
  },

  "requiresCABApproval": true,
  "requiresExecutiveApproval": false,
  "requiresFinancialApproval": false,

  "overallRiskLevel": "high",

  "recommendations": [
    "Conduct comprehensive testing in staging environment",
    "Prepare detailed rollback procedures",
    "Schedule during maintenance window",
    "Consider maintenance window during lowest traffic period",
    "Prepare customer communication plan",
    "Schedule status page updates"
  ],

  "optimalChangeWindow": {
    "start": "2025-11-15T02:00:00Z",
    "end": "2025-11-15T06:00:00Z",
    "reason": "Low traffic period (2 AM - 6 AM) minimizes customer impact"
  },

  "assessedAt": "2025-11-06T10:45:00Z"
}
```

---

## REST API Reference

The Unified Framework provides **12 REST API endpoints** for programmatic access.

### Base URL

```
https://happycmdb.example.com/api/v1/unified
```

### Authentication

All endpoints require JWT authentication:

```http
Authorization: Bearer <jwt-token>
```

---

### 1. Get Complete Service View

Get a comprehensive 360° view of a business service.

**Endpoint**: `GET /services/:serviceId/complete`

**Parameters**:
- `serviceId` (path, required): Business service ID
- `useCache` (query, optional): Use cached data (default: `true`)

**Example Request**:
```bash
curl -X GET "https://happycmdb.example.com/api/v1/unified/services/bs-payment-001/complete?useCache=true" \
  -H "Authorization: Bearer <token>"
```

**Example Response**:
```json
{
  "success": true,
  "data": {
    "serviceId": "bs-payment-001",
    "serviceName": "Payment Processing Service",
    "itil": { ... },
    "tbm": { ... },
    "bsm": { ... },
    "kpis": { ... }
  }
}
```

---

### 2. Get Unified KPIs

Get only the 10 unified KPIs for a service.

**Endpoint**: `GET /services/:serviceId/kpis`

**Example Request**:
```bash
curl -X GET "https://happycmdb.example.com/api/v1/unified/services/bs-payment-001/kpis" \
  -H "Authorization: Bearer <token>"
```

**Example Response**:
```json
{
  "success": true,
  "data": {
    "serviceHealth": 96.5,
    "costEfficiency": {
      "costPerTransaction": 0.0083,
      "costPerUser": 3.57,
      "costPerRevenue": 0.0033,
      "trend": "stable",
      "budgetVariance": 5000
    },
    "riskScore": 18.2,
    "valueScore": 300,
    "complianceScore": 95.8,
    "availability": 99.98,
    "roi": 2.99,
    "mttr": 45,
    "mtbf": 720,
    "changeSuccessRate": 91.7
  }
}
```

---

### 3. Get Service Dashboard

Get complete dashboard data including trends, incidents, changes, and alerts.

**Endpoint**: `GET /services/:serviceId/dashboard`

**Example Request**:
```bash
curl -X GET "https://happycmdb.example.com/api/v1/unified/services/bs-payment-001/dashboard" \
  -H "Authorization: Bearer <token>"
```

**Example Response**:
```json
{
  "success": true,
  "data": {
    "service": { ... },
    "recentIncidents": [...],
    "recentChanges": [...],
    "costTrends": [...],
    "healthTrends": [...],
    "alerts": [
      {
        "severity": "warning",
        "message": "Over budget by $5,000",
        "timestamp": "2025-11-06T10:00:00Z"
      }
    ],
    "generatedAt": "2025-11-06T10:30:00Z"
  }
}
```

---

### 4. Create Enriched Incident

Create an incident with automatic multi-framework enrichment.

**Endpoint**: `POST /incidents/enriched`

**Request Body**:
```json
{
  "affectedCIId": "ci-prod-db-001",
  "title": "Database connection pool exhausted",
  "description": "Production database rejecting connections",
  "reportedBy": "monitoring@company.com",
  "category": "availability",
  "symptoms": ["Connection timeouts", "Error rate spike"]
}
```

**Example Request**:
```bash
curl -X POST "https://happycmdb.example.com/api/v1/unified/incidents/enriched" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d @incident.json
```

**Example Response**:
```json
{
  "success": true,
  "data": {
    "id": "inc-20251106-001",
    "title": "Database connection pool exhausted",
    "itilPriority": {
      "priority": 1,
      "impact": "critical",
      "urgency": "critical"
    },
    "businessImpact": { ... },
    "downtimeCostPerHour": 125000,
    "responseTeam": ["Executive On-Call", "Senior SRE Team"],
    "recommendedActions": [...]
  },
  "message": "Enriched incident created successfully"
}
```

---

### 5. Assess Unified Change Risk

Assess change risk across all three frameworks.

**Endpoint**: `POST /changes/assess-unified`

**Request Body**:
```json
{
  "affectedCIIds": ["ci-prod-app-001"],
  "title": "Deploy new authentication service",
  "description": "Migrate from legacy auth to OAuth 2.0",
  "changeType": "major",
  "plannedStart": "2025-11-15T02:00:00Z",
  "plannedEnd": "2025-11-15T06:00:00Z",
  "implementationPlan": "1. Deploy new auth service...",
  "backoutPlan": "Revert load balancer config...",
  "requestedBy": "engineering@company.com"
}
```

**Example Request**:
```bash
curl -X POST "https://happycmdb.example.com/api/v1/unified/changes/assess-unified" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d @change-request.json
```

**Example Response**:
```json
{
  "success": true,
  "data": {
    "changeId": "",
    "changeTitle": "Deploy new authentication service",
    "itilRisk": { "overallRiskScore": 68, "riskLevel": "high" },
    "businessImpact": { ... },
    "costEstimate": { "totalCost": 45685 },
    "requiresCABApproval": true,
    "overallRiskLevel": "high",
    "recommendations": [...]
  }
}
```

---

### 6. Query Services

Query services with unified filters (criticality, cost, health, risk).

**Endpoint**: `POST /services/query`

**Request Body**:
```json
{
  "criticality": ["tier_0", "tier_1"],
  "costRange": { "min": 50000, "max": 200000 },
  "healthScoreRange": { "min": 80 },
  "sortBy": "cost",
  "sortDirection": "desc",
  "limit": 20
}
```

**Example Request**:
```bash
curl -X POST "https://happycmdb.example.com/api/v1/unified/services/query" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d @query-filters.json
```

**Example Response**:
```json
{
  "success": true,
  "data": [
    { "serviceId": "bs-payment-001", ... },
    { "serviceId": "bs-order-002", ... }
  ],
  "meta": {
    "total": 45,
    "offset": 0,
    "limit": 20,
    "returned": 20
  }
}
```

---

### 7. Get Service Health Details

Get detailed breakdown of service health score calculation.

**Endpoint**: `GET /services/:serviceId/health-details`

**Example Response**:
```json
{
  "success": true,
  "data": {
    "overallScore": 96.5,
    "availabilityScore": 99.98,
    "incidentScore": 80,
    "changeScore": 91.7,
    "complianceScore": 95.8,
    "performanceScore": 85,
    "operationalStatus": "operational",
    "trend": "improving",
    "calculatedAt": "2025-11-06T10:30:00Z"
  }
}
```

---

### 8. Get Risk Score Details

Get detailed breakdown of risk score calculation.

**Endpoint**: `GET /services/:serviceId/risk-details`

**Example Response**:
```json
{
  "success": true,
  "data": {
    "overallScore": 18.2,
    "changeRisk": 20,
    "criticalityRisk": 100,
    "incidentRisk": 0,
    "driftRisk": 4.2,
    "complianceRisk": 0,
    "riskLevel": "low",
    "trend": "stable",
    "topRiskFactors": [
      "High business criticality",
      "1 CIs with configuration drift"
    ],
    "calculatedAt": "2025-11-06T10:30:00Z"
  }
}
```

---

### 9. Get Value Score Details

Get detailed breakdown of value score calculation.

**Endpoint**: `GET /services/:serviceId/value-details`

**Example Response**:
```json
{
  "success": true,
  "data": {
    "overallScore": 300,
    "annualRevenue": 450000000,
    "annualCost": 1500000,
    "roiPercentage": 299.9,
    "valueClassification": "high_value",
    "revenuePerDollar": 300,
    "costOptimizationOpportunities": [],
    "trend": "stable",
    "calculatedAt": "2025-11-06T10:30:00Z"
  }
}
```

---

### 10. Get Top Services by Cost

Get top N services ranked by monthly cost.

**Endpoint**: `GET /services/top-by-cost`

**Query Parameters**:
- `limit` (optional, default: 10): Number of services to return

**Example Request**:
```bash
curl -X GET "https://happycmdb.example.com/api/v1/unified/services/top-by-cost?limit=5" \
  -H "Authorization: Bearer <token>"
```

---

### 11. Get Top Services by Risk

Get top N services ranked by risk score.

**Endpoint**: `GET /services/top-by-risk`

**Query Parameters**:
- `limit` (optional, default: 10): Number of services to return

**Example Request**:
```bash
curl -X GET "https://happycmdb.example.com/api/v1/unified/services/top-by-risk?limit=5" \
  -H "Authorization: Bearer <token>"
```

---

### 12. Get Top Services by Value

Get top N services ranked by value score.

**Endpoint**: `GET /services/top-by-value`

**Query Parameters**:
- `limit` (optional, default: 10): Number of services to return

**Example Request**:
```bash
curl -X GET "https://happycmdb.example.com/api/v1/unified/services/top-by-value?limit=5" \
  -H "Authorization: Bearer <token>"
```

---

## GraphQL API Reference

The Unified Framework also provides a comprehensive GraphQL API with **12 operations** (7 queries + 2 mutations + 3 detail queries).

### GraphQL Endpoint

```
https://happycmdb.example.com/graphql
```

### Schema Overview

```graphql
type Query {
  completeServiceView(serviceId: ID!, useCache: Boolean): CompleteServiceView!
  unifiedKPIs(serviceId: ID!): UnifiedKPIs!
  serviceDashboard(serviceId: ID!): ServiceDashboard!
  queryServices(filters: UnifiedQueryFilters): [CompleteServiceView!]!
  topServicesByCost(limit: Int): [CompleteServiceView!]!
  topServicesByRisk(limit: Int): [CompleteServiceView!]!
  topServicesByValue(limit: Int): [CompleteServiceView!]!
  serviceHealthDetails(serviceId: ID!): ServiceHealthDetails!
  riskScoreDetails(serviceId: ID!): RiskScoreDetails!
  valueScoreDetails(serviceId: ID!): ValueScoreDetails!
}

type Mutation {
  createEnrichedIncident(input: CreateEnrichedIncidentInput!): EnrichedIncident!
  assessUnifiedChangeRisk(input: AssessUnifiedChangeRiskInput!): UnifiedChangeRisk!
}
```

---

### Query 1: Complete Service View

**Query**:
```graphql
query GetCompleteServiceView($serviceId: ID!) {
  completeServiceView(serviceId: $serviceId) {
    serviceId
    serviceName
    serviceDescription

    itil {
      openIncidents
      averageMTTR
      availability
      changeSuccessRate
      criticalIncidents
    }

    tbm {
      monthlyCost
      costTrend
      budgetVariance
      topCostDrivers {
        ciName
        cost
        percentage
      }
    }

    bsm {
      criticality
      impactScore
      annualRevenue
      customerCount
      customerFacing
      revenueAtRiskPerHour
    }

    kpis {
      serviceHealth
      riskScore
      valueScore
      availability
      roi
      mttr
      mtbf
      changeSuccessRate
    }

    generatedAt
  }
}
```

**Variables**:
```json
{
  "serviceId": "bs-payment-001"
}
```

---

### Query 2: Unified KPIs

**Query**:
```graphql
query GetUnifiedKPIs($serviceId: ID!) {
  unifiedKPIs(serviceId: $serviceId) {
    serviceHealth
    costEfficiency {
      costPerTransaction
      costPerUser
      costPerRevenue
      trend
      budgetVariance
    }
    riskScore
    valueScore
    complianceScore
    availability
    roi
    mttr
    mtbf
    changeSuccessRate
  }
}
```

---

### Query 3: Service Dashboard

**Query**:
```graphql
query GetServiceDashboard($serviceId: ID!) {
  serviceDashboard(serviceId: $serviceId) {
    service {
      serviceId
      serviceName
      kpis {
        serviceHealth
        riskScore
        valueScore
      }
    }

    recentIncidents {
      id
      title
      priority
      status
      createdAt
      resolvedAt
    }

    recentChanges {
      id
      title
      changeType
      status
      scheduledStart
      outcome
    }

    costTrends {
      month
      cost
      change
    }

    healthTrends {
      date
      healthScore
      availability
    }

    alerts {
      severity
      message
      timestamp
    }

    generatedAt
  }
}
```

---

### Query 4: Query Services with Filters

**Query**:
```graphql
query QueryServices($filters: UnifiedQueryFilters) {
  queryServices(filters: $filters) {
    serviceId
    serviceName
    bsm {
      criticality
    }
    tbm {
      monthlyCost
    }
    kpis {
      serviceHealth
      riskScore
      valueScore
    }
  }
}
```

**Variables**:
```json
{
  "filters": {
    "criticality": ["TIER_0", "TIER_1"],
    "costRange": {
      "min": 50000,
      "max": 200000
    },
    "healthScoreRange": {
      "min": 80
    },
    "sortBy": "COST",
    "sortDirection": "DESC",
    "limit": 20
  }
}
```

---

### Mutation 1: Create Enriched Incident

**Mutation**:
```graphql
mutation CreateEnrichedIncident($input: CreateEnrichedIncidentInput!) {
  createEnrichedIncident(input: $input) {
    id
    title
    affectedCIId
    affectedCIName

    itilPriority {
      priority
      impact
      urgency
      reasoning
      requiresEscalation
    }

    businessImpact {
      criticality
      impactScore
      customersImpacted
      revenueAtRiskPerHour
      complianceImpact
    }

    blastRadius {
      totalCIsImpacted
      totalServicesImpacted
      totalCustomersImpacted
      totalRevenueAtRisk
    }

    downtimeCostPerHour
    totalEstimatedCost

    responseTeam
    escalationRequired
    executiveNotificationRequired

    recommendedActions

    targetResponseTime
    targetResolutionTime

    enrichedAt
  }
}
```

**Variables**:
```json
{
  "input": {
    "affectedCIId": "ci-prod-db-001",
    "title": "Database connection pool exhausted",
    "description": "Production database rejecting connections",
    "reportedBy": "monitoring@company.com",
    "symptoms": ["Connection timeouts", "Error rate spike"]
  }
}
```

---

### Mutation 2: Assess Unified Change Risk

**Mutation**:
```graphql
mutation AssessUnifiedChangeRisk($input: AssessUnifiedChangeRiskInput!) {
  assessUnifiedChangeRisk(input: $input) {
    changeId
    changeTitle
    changeType

    itilRisk {
      overallRiskScore
      riskLevel
      requiresCABApproval
    }

    businessImpact {
      criticality
      impactScore
      customersImpacted
      revenueAtRiskPerHour
    }

    costEstimate {
      laborCost
      estimatedDowntimeMinutes
      downtimeCost
      totalCost
      riskAdjustedCost
      confidence
    }

    approvalRequirements {
      cabApproval
      businessOwnerApproval
      technicalOwnerApproval
      executiveApproval
      financeApproval
      securityApproval
      complianceApproval
      estimatedApprovalDuration
      approvalReasons
    }

    requiresCABApproval
    requiresExecutiveApproval
    requiresFinancialApproval

    overallRiskLevel
    recommendations

    optimalChangeWindow {
      start
      end
      reason
    }

    assessedAt
  }
}
```

**Variables**:
```json
{
  "input": {
    "affectedCIIds": ["ci-prod-app-001"],
    "title": "Deploy new authentication service",
    "description": "Migrate from legacy auth to OAuth 2.0",
    "changeType": "MAJOR",
    "plannedStart": "2025-11-15T02:00:00Z",
    "plannedEnd": "2025-11-15T06:00:00Z",
    "implementationPlan": "1. Deploy new auth service...",
    "backoutPlan": "Revert load balancer config...",
    "requestedBy": "engineering@company.com"
  }
}
```

---

## Integration Patterns

### Pattern 1: Dashboard Integration

Use Complete Service Views to build executive dashboards.

**Example: Executive Dashboard**

```typescript
import { UnifiedServiceInterface } from '@cmdb/framework-integration';

const unifiedService = new UnifiedServiceInterface();

async function buildExecutiveDashboard() {
  // Get all Tier 0 and Tier 1 services
  const filters = {
    criticality: ['tier_0', 'tier_1'],
    sortBy: 'cost',
    sortDirection: 'desc',
    limit: 50
  };

  const services = await fetch('/api/v1/unified/services/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filters)
  });

  const data = await services.json();

  // Aggregate KPIs
  const totalMonthlyCost = data.data.reduce((sum, s) => sum + s.tbm.monthlyCost, 0);
  const avgServiceHealth = data.data.reduce((sum, s) => sum + s.kpis.serviceHealth, 0) / data.data.length;
  const totalRevenue = data.data.reduce((sum, s) => sum + s.bsm.annualRevenue, 0);

  return {
    totalMonthlyCost,
    avgServiceHealth,
    totalRevenue,
    services: data.data
  };
}
```

---

### Pattern 2: Incident Response Workflow

Automate incident response with enriched incidents.

**Example: Auto-Response Workflow**

```typescript
async function handleIncident(basicIncident) {
  // Step 1: Create enriched incident
  const enriched = await fetch('/api/v1/unified/incidents/enriched', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(basicIncident)
  });

  const incident = await enriched.json();

  // Step 2: Auto-assign to response team
  for (const team of incident.data.responseTeam) {
    await notifyTeam(team, incident.data);
  }

  // Step 3: Executive notification if required
  if (incident.data.executiveNotificationRequired) {
    await notifyExecutives(incident.data);
  }

  // Step 4: Update status page if customer-facing
  if (incident.data.businessImpact.customerFacing) {
    await updateStatusPage(incident.data);
  }

  // Step 5: Create Jira ticket with enrichment data
  await createJiraTicket({
    title: incident.data.title,
    priority: mapPriorityToJira(incident.data.itilPriority.priority),
    description: formatIncidentDescription(incident.data),
    labels: ['enriched-incident', `p${incident.data.itilPriority.priority}`]
  });

  return incident.data;
}
```

---

### Pattern 3: Change Approval Automation

Automate change approval routing based on unified risk assessment.

**Example: Auto-Approval Router**

```typescript
async function routeChangeApproval(changeRequest) {
  // Step 1: Assess unified risk
  const assessment = await fetch('/api/v1/unified/changes/assess-unified', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changeRequest)
  });

  const risk = await assessment.json();

  // Step 2: Route approvals based on requirements
  const approvals = risk.data.approvalRequirements;

  if (approvals.cabApproval) {
    await submitToCAB(risk.data);
  }

  if (approvals.executiveApproval) {
    await requestExecutiveApproval(risk.data);
  }

  if (approvals.financeApproval) {
    await requestFinanceApproval(risk.data);
  }

  if (approvals.securityApproval) {
    await requestSecurityApproval(risk.data);
  }

  if (approvals.complianceApproval) {
    await requestComplianceApproval(risk.data);
  }

  // Step 3: Schedule notifications for optimal change window
  if (risk.data.optimalChangeWindow) {
    await scheduleChangeNotification(risk.data.optimalChangeWindow);
  }

  return risk.data;
}
```

---

### Pattern 4: Cost Optimization Workflow

Identify cost optimization opportunities using value scores.

**Example: Cost Optimization Scanner**

```typescript
async function scanForCostOptimization() {
  // Get all services
  const services = await fetch('/api/v1/unified/services/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sortBy: 'value',
      sortDirection: 'asc',
      limit: 100
    })
  });

  const data = await services.json();
  const opportunities = [];

  for (const service of data.data) {
    const valueDetails = await fetch(
      `/api/v1/unified/services/${service.serviceId}/value-details`
    );
    const details = await valueDetails.json();

    // Low value services (< 2) with optimization opportunities
    if (details.data.valueClassification === 'low_value' ||
        details.data.valueClassification === 'cost_center') {

      opportunities.push({
        serviceId: service.serviceId,
        serviceName: service.serviceName,
        valueScore: details.data.overallScore,
        monthlyCost: service.tbm.monthlyCost,
        opportunities: details.data.costOptimizationOpportunities
      });
    }
  }

  return opportunities;
}
```

---

## Configuration & Setup

### 1. Enable Framework Integration

Update environment variables:

```bash
# .env

# Enable v3.0 unified framework
V3_UNIFIED_FRAMEWORK_ENABLED=true

# Framework-specific configurations
ITIL_ENABLED=true
TBM_ENABLED=true
BSM_ENABLED=true

# Cache settings
UNIFIED_VIEW_CACHE_TTL=300  # 5 minutes
```

---

### 2. Initialize Unified Service Interface

```typescript
import { UnifiedServiceInterface } from '@cmdb/framework-integration';

const unifiedService = new UnifiedServiceInterface();

// Get complete service view
const view = await unifiedService.getCompleteServiceView('bs-payment-001');

// Create enriched incident
const incident = await unifiedService.createEnrichedIncident({
  affectedCIId: 'ci-prod-db-001',
  title: 'Database connection pool exhausted',
  description: 'Production database rejecting connections',
  reportedBy: 'monitoring@company.com'
});

// Assess change risk
const risk = await unifiedService.assessChangeRisk(changeRequest);
```

---

### 3. Configure KPI Thresholds

Create custom thresholds for KPI alerts:

```typescript
// config/kpi-thresholds.json
{
  "serviceHealth": {
    "excellent": 90,
    "good": 75,
    "poor": 60
  },
  "riskScore": {
    "critical": 80,
    "high": 60,
    "medium": 40
  },
  "availability": {
    "tier_0": 99.99,
    "tier_1": 99.95,
    "tier_2": 99.9,
    "tier_3": 99.5,
    "tier_4": 99.0
  },
  "mttr": {
    "p1": 60,
    "p2": 240,
    "p3": 480,
    "p4": 1440
  }
}
```

---

## Use Cases

### Use Case 1: Executive Dashboard

**Scenario**: CTO wants a single dashboard showing health, cost, and risk for all Tier 0 services.

**Solution**:
```typescript
const tier0Services = await unifiedService.queryServices({
  criticality: ['tier_0'],
  sortBy: 'risk',
  sortDirection: 'desc'
});

const dashboard = {
  totalServices: tier0Services.length,
  totalMonthlyCost: tier0Services.reduce((sum, s) => sum + s.tbm.monthlyCost, 0),
  avgHealth: tier0Services.reduce((sum, s) => sum + s.kpis.serviceHealth, 0) / tier0Services.length,
  highRiskServices: tier0Services.filter(s => s.kpis.riskScore > 60),
  services: tier0Services.map(s => ({
    name: s.serviceName,
    health: s.kpis.serviceHealth,
    cost: s.tbm.monthlyCost,
    risk: s.kpis.riskScore,
    revenue: s.bsm.annualRevenue
  }))
};
```

---

### Use Case 2: Incident Triage Automation

**Scenario**: Automatically triage incidents based on enriched data and route to appropriate teams.

**Solution**:
```typescript
async function autoTriageIncident(alert) {
  // Create enriched incident from monitoring alert
  const enriched = await unifiedService.createEnrichedIncident({
    affectedCIId: alert.ci_id,
    title: alert.title,
    description: alert.description,
    reportedBy: 'monitoring-system',
    symptoms: alert.symptoms
  });

  // Determine escalation path
  if (enriched.executiveNotificationRequired) {
    await notifyExecs(enriched);
  }

  // Auto-assign to response team
  await assignToTeam(enriched.responseTeam[0], enriched);

  // Create war room if blast radius is large
  if (enriched.blastRadius.totalServicesImpacted > 5) {
    await createWarRoom(enriched);
  }

  return enriched;
}
```

---

### Use Case 3: Change Risk-Based Gating

**Scenario**: Automatically approve low-risk changes, route high-risk changes to CAB.

**Solution**:
```typescript
async function processChangeRequest(change) {
  // Assess unified risk
  const risk = await unifiedService.assessChangeRisk(change);

  // Auto-approve low-risk changes
  if (risk.overallRiskLevel === 'low' &&
      !risk.requiresCABApproval &&
      risk.costEstimate.totalCost < 10000) {

    await approveChange(risk.changeId);
    await notifyRequestor(change.requestedBy, 'approved');
    return { status: 'auto-approved', risk };
  }

  // Route high-risk to CAB
  if (risk.requiresCABApproval) {
    await submitToCAB(risk);
    await notifyRequestor(change.requestedBy, 'cab-review');
    return { status: 'cab-review', risk };
  }

  // Medium risk: manager approval
  await requestManagerApproval(risk);
  return { status: 'manager-review', risk };
}
```

---

## Best Practices

### 1. Caching Strategy

- **Enable caching** for frequently accessed services (default: 5 minutes)
- **Bypass cache** when real-time data is critical (incident triage)
- **Invalidate cache** after service updates or configuration changes

```typescript
// Use cache for dashboards
const view = await unifiedService.getCompleteServiceView('bs-001', { useCache: true });

// Bypass cache for incident triage
const view = await unifiedService.getCompleteServiceView('bs-001', { useCache: false });
```

---

### 2. KPI Monitoring

- **Set up alerts** for KPI thresholds (health < 70, risk > 80)
- **Track trends** over time (30-day health trends)
- **Benchmark against targets** (Tier 0 availability > 99.99%)

---

### 3. Error Handling

Always wrap unified calls in try-catch:

```typescript
try {
  const view = await unifiedService.getCompleteServiceView(serviceId);
} catch (error) {
  if (error.message.includes('not found')) {
    // Service doesn't exist
  } else if (error.message.includes('timeout')) {
    // Database timeout, retry
  } else {
    // Unexpected error
    logger.error('Unified view error', error);
  }
}
```

---

### 4. Performance Optimization

- **Parallel queries**: Unified interface already uses `Promise.all()` internally
- **GraphQL batching**: Use GraphQL for multiple services (single request)
- **Redis caching**: Complete views cached in Redis (5-minute TTL)

---

## Related Resources

- [ITIL Service Manager](/components/itil-service-manager) - ITIL v4 implementation
- [TBM Cost Engine](/components/tbm-cost-engine) - Technology Business Management
- [BSM Impact Engine](/components/bsm-impact-engine) - Business Service Mapping
- [Multi-Stakeholder Dashboards](/components/dashboards) - Executive dashboards
- [Unified Data Model](/architecture/unified-data-model) - v3.0 data model

---

**Last Updated**: 2025-11-06
**Version**: v3.0.0
**Maintainer**: HappyCMDB Team
