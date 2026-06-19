# @cmdb/framework-integration

Unified Interface for HappyCMDB v3.0 combining ITIL v4, TBM v5.0.1, and BSM frameworks into a single, comprehensive service management platform.

## Overview

The `framework-integration` package provides a unified interface that orchestrates three enterprise frameworks:

- **ITIL v4** (Phase 2): IT Service Management with incident/change management, configuration baselines, and compliance tracking
- **TBM v5.0.1** (Phase 3): Technology Business Management with cost allocation, tower mapping, and financial transparency
- **BSM** (Phase 4): Business Service Mapping with criticality scoring, impact analysis, and blast radius calculation

## Key Features

### 🎯 Complete Service Views
Get a 360-degree view of any service combining operational health, financial cost, and business impact in a single API call.

### 📊 Unified KPIs
Calculate cross-framework KPIs:
- **Service Health Score**: Combines availability, incident rate, change success
- **Cost Efficiency**: Cost per transaction, cost per user, cost per revenue
- **Risk Score**: Composite of change risk, criticality, and incident frequency
- **Value Score**: Revenue-to-cost ratio (ROI)
- **Compliance Score**: Audit status and baseline adherence

### 🚨 Enriched Incident Management
Create incidents that automatically include:
- ITIL priority calculation (impact × urgency)
- Business impact analysis (revenue at risk, customers affected)
- Downtime cost estimation (per hour)
- Blast radius analysis (cascading service impact)
- Response team assignment based on criticality
- Recommended actions and escalation requirements

### 🔄 Unified Change Risk Assessment
Assess changes across all three frameworks:
- ITIL 5-factor risk calculation
- Business criticality and compliance impact
- Cost estimation (labor, downtime, rollback, testing)
- Unified approval workflow (CAB, executive, financial, security)
- Optimal change window recommendations

## Installation

```bash
npm install @cmdb/framework-integration
```

### Dependencies

This package requires the following HappyCMDB packages:
- `@cmdb/itil-service-manager` - Phase 2 ITIL implementation
- `@cmdb/tbm-cost-engine` - Phase 3 TBM implementation
- `@cmdb/bsm-impact-engine` - Phase 4 BSM implementation (built by Agent 11)
- `@cmdb/unified-model` - Unified data types
- `@cmdb/database` - Database clients (Neo4j, PostgreSQL, Redis)

## Quick Start

```typescript
import { UnifiedServiceInterface } from '@cmdb/framework-integration';

const unifiedService = new UnifiedServiceInterface();

// Get complete service view
const view = await unifiedService.getCompleteServiceView('bs-customer-portal-001');

console.log(`Service: ${view.serviceName}`);
console.log(`Health Score: ${view.kpis.serviceHealth}/100`);
console.log(`Monthly Cost: $${view.tbm.monthlyCost.toLocaleString()}`);
console.log(`Annual Revenue: $${view.bsm.annualRevenue.toLocaleString()}`);
console.log(`ROI: ${(view.kpis.roi * 100).toFixed(1)}%`);
console.log(`Risk Score: ${view.kpis.riskScore}/100`);
```

## Usage Examples

### Complete Service View

Get a comprehensive view of a service combining all three frameworks:

```typescript
import { UnifiedServiceInterface } from '@cmdb/framework-integration';

const unifiedService = new UnifiedServiceInterface();

// Get complete service view with caching
const view = await unifiedService.getCompleteServiceView(
  'bs-customer-portal-001',
  { useCache: true }
);

// Access ITIL metrics
console.log('ITIL Metrics:');
console.log(`  Open Incidents: ${view.itil.openIncidents}`);
console.log(`  Average MTTR: ${view.itil.averageMTTR} minutes`);
console.log(`  Change Success Rate: ${(view.itil.changeSuccessRate * 100).toFixed(1)}%`);
console.log(`  Availability: ${(view.itil.availability * 100).toFixed(2)}%`);

// Access TBM costs
console.log('\nTBM Costs:');
console.log(`  Monthly Cost: $${view.tbm.monthlyCost.toLocaleString()}`);
console.log(`  Cost Trend: ${view.tbm.costTrend}`);
console.log(`  Budget Variance: $${view.tbm.budgetVariance.toLocaleString()}`);

// Access BSM impact
console.log('\nBSM Impact:');
console.log(`  Criticality: ${view.bsm.criticality}`);
console.log(`  Annual Revenue: $${view.bsm.annualRevenue.toLocaleString()}`);
console.log(`  Customer Count: ${view.bsm.customerCount.toLocaleString()}`);
console.log(`  Revenue at Risk (per hour): $${view.bsm.revenueAtRiskPerHour.toLocaleString()}`);

// Unified KPIs
console.log('\nUnified KPIs:');
console.log(`  Service Health: ${view.kpis.serviceHealth.toFixed(1)}/100`);
console.log(`  Risk Score: ${view.kpis.riskScore.toFixed(1)}/100`);
console.log(`  Value Score: ${view.kpis.valueScore.toFixed(2)}x`);
console.log(`  ROI: ${(view.kpis.roi * 100).toFixed(1)}%`);
```

### Enriched Incident Creation

Create an incident with automatic ITIL priority, business impact, and cost calculation:

```typescript
import { UnifiedServiceInterface } from '@cmdb/framework-integration';

const unifiedService = new UnifiedServiceInterface();

const enrichedIncident = await unifiedService.createEnrichedIncident({
  affectedCIId: 'ci-prod-db-001',
  title: 'Database connection pool exhausted',
  description: 'Production database rejecting connections due to pool exhaustion',
  reportedBy: 'monitoring@company.com',
  category: 'availability',
  subcategory: 'database',
  symptoms: [
    'Connection timeouts increasing',
    'Error rate spike in application logs',
    'User-facing errors on checkout flow'
  ]
});

console.log('Enriched Incident Created:');
console.log(`  Priority: P${enrichedIncident.itilPriority.priority} (${enrichedIncident.itilPriority.impact} impact, ${enrichedIncident.itilPriority.urgency} urgency)`);
console.log(`  Business Criticality: ${enrichedIncident.businessImpact.criticality}`);
console.log(`  Downtime Cost: $${enrichedIncident.downtimeCostPerHour.toLocaleString()}/hour`);
console.log(`  Estimated Total Cost: $${enrichedIncident.totalEstimatedCost.toLocaleString()}`);
console.log(`  Estimated Revenue Impact: $${enrichedIncident.estimatedRevenueImpact.toLocaleString()}`);
console.log(`  Estimated Customers Impacted: ${enrichedIncident.estimatedCustomerImpact.toLocaleString()}`);
console.log(`  Services in Blast Radius: ${enrichedIncident.blastRadius.totalServicesImpacted}`);
console.log(`  CIs in Blast Radius: ${enrichedIncident.blastRadius.totalCIsImpacted}`);
console.log(`  Response Team: ${enrichedIncident.responseTeam.join(', ')}`);
console.log(`  Escalation Required: ${enrichedIncident.escalationRequired ? 'YES' : 'NO'}`);
console.log(`  Executive Notification: ${enrichedIncident.executiveNotificationRequired ? 'YES' : 'NO'}`);

console.log('\nRecommended Actions:');
enrichedIncident.recommendedActions.forEach((action, i) => {
  console.log(`  ${i + 1}. ${action}`);
});

console.log('\nSLA Targets:');
console.log(`  Response Time: ${enrichedIncident.targetResponseTime} minutes`);
console.log(`  Resolution Time: ${enrichedIncident.targetResolutionTime} minutes`);
```

### Unified Change Risk Assessment

Assess a change request across all three frameworks:

```typescript
import { UnifiedServiceInterface } from '@cmdb/framework-integration';

const unifiedService = new UnifiedServiceInterface();

const riskAssessment = await unifiedService.assessChangeRisk({
  affectedCIIds: ['ci-prod-app-001', 'ci-prod-lb-001'],
  title: 'Deploy new authentication service',
  description: 'Replace legacy auth with OAuth2-based authentication service',
  changeType: 'normal',
  category: 'enhancement',
  plannedStart: new Date('2025-11-15T02:00:00Z'),
  plannedEnd: new Date('2025-11-15T06:00:00Z'),
  implementationPlan: `
    1. Deploy new auth service to staging
    2. Run integration tests
    3. Enable feature flag for 10% of users
    4. Monitor for 1 hour
    5. Gradually increase to 100%
    6. Decommission legacy service after 24 hours
  `,
  backoutPlan: `
    1. Disable feature flag immediately
    2. Revert load balancer routing
    3. Restore legacy auth service
  `,
  testPlan: 'Integration tests, load tests, security scan',
  requestedBy: 'jane.doe@company.com'
});

console.log('Unified Change Risk Assessment:');
console.log(`  Overall Risk Level: ${riskAssessment.overallRiskLevel}`);
console.log(`  ITIL Risk Score: ${riskAssessment.itilRisk.overallRiskScore}/100`);
console.log(`  Business Criticality: ${riskAssessment.businessImpact.criticality}`);

console.log('\nApproval Requirements:');
console.log(`  CAB Approval: ${riskAssessment.requiresCABApproval ? 'REQUIRED' : 'Not required'}`);
console.log(`  Executive Approval: ${riskAssessment.requiresExecutiveApproval ? 'REQUIRED' : 'Not required'}`);
console.log(`  Financial Approval: ${riskAssessment.requiresFinancialApproval ? 'REQUIRED' : 'Not required'}`);
console.log(`  Security Approval: ${riskAssessment.approvalRequirements.securityApproval ? 'REQUIRED' : 'Not required'}`);
console.log(`  Compliance Approval: ${riskAssessment.approvalRequirements.complianceApproval ? 'REQUIRED' : 'Not required'}`);
console.log(`  Estimated Approval Duration: ${riskAssessment.approvalRequirements.estimatedApprovalDuration} hours`);

console.log('\nCost Estimate:');
console.log(`  Labor Cost: $${riskAssessment.costEstimate.laborCost.toLocaleString()}`);
console.log(`  Downtime Cost: $${riskAssessment.costEstimate.downtimeCost.toLocaleString()}`);
console.log(`  Rollback Cost: $${riskAssessment.costEstimate.rollbackCost.toLocaleString()}`);
console.log(`  Testing Cost: $${riskAssessment.costEstimate.testingCost.toLocaleString()}`);
console.log(`  Total Cost: $${riskAssessment.costEstimate.totalCost.toLocaleString()}`);
console.log(`  Risk-Adjusted Cost: $${riskAssessment.costEstimate.riskAdjustedCost.toLocaleString()}`);
console.log(`  Confidence: ${riskAssessment.costEstimate.confidence}`);

console.log('\nRecommendations:');
riskAssessment.recommendations.forEach((rec, i) => {
  console.log(`  ${i + 1}. ${rec}`);
});

if (riskAssessment.optimalChangeWindow) {
  console.log('\nOptimal Change Window:');
  console.log(`  Start: ${riskAssessment.optimalChangeWindow.start}`);
  console.log(`  End: ${riskAssessment.optimalChangeWindow.end}`);
  console.log(`  Reason: ${riskAssessment.optimalChangeWindow.reason}`);
}
```

### Service Dashboard

Get complete dashboard data for executive reporting:

```typescript
import { UnifiedServiceInterface } from '@cmdb/framework-integration';

const unifiedService = new UnifiedServiceInterface();

const dashboard = await unifiedService.getServiceDashboard('bs-customer-portal-001');

console.log('Service Dashboard:');
console.log(`  Service: ${dashboard.service.serviceName}`);
console.log(`  Health Score: ${dashboard.service.kpis.serviceHealth.toFixed(1)}/100`);
console.log(`  Risk Score: ${dashboard.service.kpis.riskScore.toFixed(1)}/100`);
console.log(`  Monthly Cost: $${dashboard.service.tbm.monthlyCost.toLocaleString()}`);

console.log('\nRecent Incidents:');
dashboard.recentIncidents.slice(0, 5).forEach(incident => {
  console.log(`  - P${incident.priority}: ${incident.title} (${incident.status})`);
});

console.log('\nRecent Changes:');
dashboard.recentChanges.slice(0, 5).forEach(change => {
  console.log(`  - ${change.changeType}: ${change.title} (${change.status})`);
});

console.log('\nAlerts:');
dashboard.alerts.forEach(alert => {
  const icon = alert.severity === 'critical' ? '🔴' : alert.severity === 'warning' ? '⚠️' : 'ℹ️';
  console.log(`  ${icon} [${alert.severity.toUpperCase()}] ${alert.message}`);
});

console.log('\nCost Trend (Last 3 Months):');
dashboard.costTrends.slice(-3).forEach(point => {
  const arrow = point.change > 0 ? '↑' : point.change < 0 ? '↓' : '→';
  console.log(`  ${point.month}: $${point.cost.toLocaleString()} ${arrow}`);
});

console.log('\nHealth Trend (Last 7 Days):');
dashboard.healthTrends.slice(-7).forEach(point => {
  console.log(`  ${point.date}: ${point.healthScore.toFixed(1)}/100 (${point.availability.toFixed(2)}% available)`);
});
```

## REST API Endpoints

The framework integration package provides REST endpoints at `/api/v1/unified/`:

### GET `/services/:serviceId/complete`
Get complete service view with all frameworks.

**Query Parameters:**
- `useCache` (boolean, default: true): Use cached data

**Response:**
```json
{
  "success": true,
  "data": {
    "serviceId": "bs-001",
    "serviceName": "Customer Portal",
    "itil": { ... },
    "tbm": { ... },
    "bsm": { ... },
    "kpis": { ... }
  }
}
```

### GET `/services/:serviceId/kpis`
Get unified KPIs only.

### GET `/services/:serviceId/dashboard`
Get complete dashboard data including trends and alerts.

### POST `/incidents/enriched`
Create enriched incident with ITIL + TBM + BSM analysis.

**Request Body:**
```json
{
  "affectedCIId": "ci-prod-db-001",
  "title": "Database connection pool exhausted",
  "description": "Production database rejecting connections",
  "reportedBy": "monitoring@company.com",
  "symptoms": ["Connection timeouts", "Error rate spike"]
}
```

### POST `/changes/assess-unified`
Assess unified change risk across all frameworks.

**Request Body:**
```json
{
  "affectedCIIds": ["ci-prod-app-001"],
  "title": "Deploy new feature",
  "description": "Deploy new authentication service",
  "changeType": "normal",
  "plannedStart": "2025-11-15T02:00:00Z",
  "plannedEnd": "2025-11-15T06:00:00Z",
  "implementationPlan": "...",
  "backoutPlan": "...",
  "requestedBy": "jane.doe@company.com"
}
```

### POST `/services/query`
Query services with unified filters.

**Request Body:**
```json
{
  "criticality": ["tier_0", "tier_1"],
  "healthScoreRange": { "min": 0, "max": 70 },
  "costRange": { "min": 10000, "max": 100000 },
  "sortBy": "risk",
  "sortDirection": "desc",
  "limit": 20
}
```

### GET `/services/top-by-cost`
Get top services by monthly cost.

### GET `/services/top-by-risk`
Get top services by risk score.

### GET `/services/top-by-value`
Get top services by value score (ROI).

## GraphQL API

All unified operations are available via GraphQL:

```graphql
query GetCompleteServiceView($serviceId: ID!) {
  completeServiceView(serviceId: $serviceId) {
    serviceId
    serviceName
    itil {
      openIncidents
      averageMTTR
      availability
    }
    tbm {
      monthlyCost
      costTrend
      budgetVariance
    }
    bsm {
      criticality
      annualRevenue
      customerCount
    }
    kpis {
      serviceHealth
      riskScore
      valueScore
      roi
    }
  }
}

mutation CreateEnrichedIncident($input: CreateEnrichedIncidentInput!) {
  createEnrichedIncident(input: $input) {
    id
    title
    itilPriority {
      priority
      impact
      urgency
    }
    downtimeCostPerHour
    estimatedCustomerImpact
    responseTeam
    recommendedActions
  }
}

mutation AssessUnifiedChangeRisk($input: AssessUnifiedChangeRiskInput!) {
  assessUnifiedChangeRisk(input: $input) {
    overallRiskLevel
    requiresCABApproval
    requiresExecutiveApproval
    costEstimate {
      totalCost
      confidence
    }
    recommendations
  }
}
```

## Architecture

### Package Structure

```
packages/framework-integration/
├── src/
│   ├── unified-service-interface.ts    # Main orchestrator
│   ├── services/
│   │   ├── itil-service-manager.ts     # ITIL wrapper
│   │   ├── tbm-service-manager.ts      # TBM wrapper
│   │   └── bsm-service-manager.ts      # BSM wrapper
│   ├── types/
│   │   ├── unified-types.ts            # Complete service views
│   │   └── kpi-types.ts                # Unified KPIs
│   └── index.ts
├── package.json
├── tsconfig.json
└── README.md
```

### Data Flow

1. **Request** → Unified Service Interface
2. **Parallel Fetch** → ITIL Manager + TBM Manager + BSM Manager
3. **Data Aggregation** → Combine framework metrics
4. **KPI Calculation** → Calculate unified KPIs
5. **Response** → Complete service view with caching

### Caching Strategy

- Complete service views cached in Redis (5-minute TTL)
- Cache key: `unified:service:{serviceId}`
- Cache invalidation on service updates
- Configurable cache usage via `useCache` parameter

## Performance Considerations

### Parallel Data Fetching

All framework data is fetched in parallel using `Promise.all()` to minimize latency:

```typescript
const [itilMetrics, tbmCosts, bsmImpact] = await Promise.all([
  this.itilManager.getServiceMetrics(serviceId),
  this.tbmManager.getServiceCosts(serviceId),
  this.bsmManager.getServiceImpact(serviceId)
]);
```

### Caching

- Default 5-minute cache TTL
- Reduces database load for frequently accessed services
- Configurable per-request via `useCache` parameter

### Query Optimization

- Limit database queries to essential data
- Use database indexes on service IDs
- Batch similar queries when possible

## Integration with Agent 11 (BSM Impact Engine)

**IMPORTANT:** The BSM Service Manager (`bsm-service-manager.ts`) is currently a **placeholder implementation**.

Agent 11 is building the actual BSM Impact Engine (`@cmdb/bsm-impact-engine`) with:
- `ImpactScoringService` - Calculate business impact scores
- `CriticalityCalculator` - Determine service criticality
- `BlastRadiusService` - Analyze cascading dependencies

**Once Agent 11 completes the BSM engine:**

1. Update `bsm-service-manager.ts` imports:
```typescript
import {
  ImpactScoringService,
  CriticalityCalculator,
  BlastRadiusService
} from '@cmdb/bsm-impact-engine';
```

2. Replace placeholder methods with actual BSM services
3. Remove mock data and implement real calculations
4. Test end-to-end integration

## Testing

```bash
# Run all tests
npm test

# Run unit tests
npm run test:unit

# Run integration tests
npm run test:integration
```

## Building

```bash
# Clean build artifacts
npm run clean

# Build TypeScript
npm run build
```

## License

MIT

## Contributing

See the main HappyCMDB repository for contribution guidelines.

## Support

For questions or issues, please open an issue in the HappyCMDB repository.
