# BSM Impact Engine

The Business Service Mapping (BSM) Impact Engine is a comprehensive analysis framework that calculates business impact, financial risk, and blast radius for IT infrastructure and business services. It provides automated business criticality classification, revenue impact modeling, and compliance risk assessment to support data-driven decision making.

## Overview

The BSM Impact Engine transforms technical infrastructure data into business intelligence by:

- **Automatic Criticality Classification**: Categorizes services into Tier 0-4 based on revenue, customers, compliance, and transactions
- **Impact Scoring**: Calculates 0-100 impact scores with weighted component analysis
- **Risk Assessment**: Determines critical/high/medium/low risk ratings based on incidents, changes, and compliance
- **Blast Radius Analysis**: Maps all CIs and business services affected by infrastructure failures
- **Financial Modeling**: Estimates downtime costs, revenue at risk, and productivity losses
- **Compliance Impact**: Assesses regulatory penalties and breach notification requirements

The engine integrates with ITIL Service Management, TBM Cost Engine, and Discovery systems to provide complete business context for every configuration item in your CMDB.

## Architecture

### Core Components

```
@cmdb/bsm-impact-engine
├── Services                      # High-level analysis services
│   ├── CriticalityCalculatorService   # Tier 0-4 classification
│   ├── ImpactScoringService           # 0-100 impact scores
│   ├── RiskRatingService              # Risk rating matrix
│   └── BlastRadiusService             # Dependency impact analysis
├── Calculators                   # Specialized calculators
│   ├── RevenueImpactCalculator        # Downtime cost estimation
│   ├── UserImpactCalculator           # User impact analysis
│   └── ComplianceImpactCalculator     # Regulatory impact
└── Utilities
    └── GraphTraversal                 # Neo4j graph operations
```

### Data Flow

```
┌─────────────────────┐
│  Business Service   │ (Annual Revenue, Customers, Compliance)
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ BSM Impact Engine   │
├─────────────────────┤
│ • Criticality Calc  │ → Tier 0-4
│ • Impact Scoring    │ → 0-100 Score
│ • Risk Assessment   │ → Critical/High/Medium/Low
│ • Blast Radius      │ → Impacted CIs/Services
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Business Insights  │
├─────────────────────┤
│ • Revenue at Risk   │
│ • Downtime Cost     │
│ • Compliance Penalties│
│ • User Impact       │
└─────────────────────┘
```

## Business Criticality Classification

### Tier System

Business services are automatically classified into 5 tiers based on business impact:

| Tier | Name | Criteria | Availability Target | Support Hours |
|------|------|----------|---------------------|---------------|
| **Tier 0** | Mission-Critical | >$1M annual revenue | 99.99% (52 min/year) | 24x7 |
| **Tier 1** | Business-Critical | $500K-$1M revenue | 99.9% (8.76 hr/year) | 24x7 |
| **Tier 2** | Important | $100K-$500K revenue | 99.5% (43.8 hr/year) | 12x5 |
| **Tier 3** | Standard | $10K-$100K revenue | 99.0% (87.6 hr/year) | 8x5 |
| **Tier 4** | Low Priority | <$10K revenue | 95.0% (438 hr/year) | Best Effort |

### Scoring Formula

Criticality is calculated using a weighted scoring model:

**Components** (Total: 100 points):
- **Revenue (40%)**: Logarithmic scale, $0 to $100M+
- **Customers (25%)**: Logarithmic scale, 0 to 1M+
- **Transactions (15%)**: Linear scale, 0 to 1M/day
- **Compliance (10%)**: Regulatory framework weight (GDPR=10, HIPAA=9.5, etc.)
- **Users (10%)**: Internal user count, 0 to 1000+

**Formula**:
```typescript
impactScore = (revenueScore × 0.40) +
              (customerScore × 0.25) +
              (transactionScore × 0.15) +
              (complianceScore × 0.10) +
              (userScore × 0.10)
```

**Tier Assignment**:
- Primary: Annual revenue thresholds
- Secondary: Impact score (>80 = Tier 1, >60 = Tier 2, >40 = Tier 3)

### Usage Example

```typescript
import { getCriticalityCalculatorService } from '@cmdb/bsm-impact-engine';

const criticalityService = getCriticalityCalculatorService();

// Calculate criticality for a business service
const calculation = await criticalityService.calculateCriticality(businessService);

console.log(`Criticality: ${calculation.calculatedCriticality}`);
console.log(`Impact Score: ${calculation.impactScore}/100`);
console.log(`Confidence: ${(calculation.confidence * 100).toFixed(0)}%`);
console.log(`Recommendation: ${calculation.recommendation}`);

// Example Output:
// Criticality: tier_1
// Impact Score: 78.5/100
// Confidence: 85%
// Recommendation: Business-critical service requiring high availability...
```

### Custom Thresholds

Override default tier thresholds for your organization:

```typescript
const calculation = await criticalityService.calculateCriticality(businessService, {
  thresholds: {
    tier_0: 5_000_000,    // $5M for Tier 0
    tier_1: 2_000_000,    // $2M for Tier 1
    tier_2: 500_000,      // $500K for Tier 2
    tier_3: 100_000,      // $100K for Tier 3
  },
  weights: {
    revenue: 0.50,        // Increase revenue weight to 50%
    customers: 0.20,      // Decrease customer weight to 20%
    transactions: 0.15,
    compliance: 0.10,
    users: 0.05,
  },
});
```

## Impact Scoring

### 0-100 Impact Scale

The impact score provides a normalized 0-100 metric for comparing business services:

| Score Range | Impact Level | Description |
|-------------|--------------|-------------|
| **80-100** | Critical | Mission-critical services, severe business impact |
| **60-79** | High | Important services, significant business impact |
| **40-59** | Medium | Standard services, moderate business impact |
| **0-39** | Low | Low-priority services, minimal business impact |

### Component Breakdown

```typescript
import { getImpactScoringService } from '@cmdb/bsm-impact-engine';

const scoringService = getImpactScoringService();
const impactScore = scoringService.calculateImpactScore(businessService);

console.log(`Total Score: ${impactScore.totalScore}/100`);
console.log('Component Breakdown:');
console.log(`  Revenue: ${impactScore.components.revenue}/40`);
console.log(`  Customers: ${impactScore.components.customers}/25`);
console.log(`  Transactions: ${impactScore.components.transactions}/15`);
console.log(`  Compliance: ${impactScore.components.compliance}/10`);
console.log(`  Users: ${impactScore.components.users}/10`);

// Generate human-readable summary
const summary = scoringService.generateImpactSummary(impactScore);
console.log(summary);

// Example Output:
// Total Score: 78.5/100
// Component Breakdown:
//   Revenue: 32.1/40
//   Customers: 21.3/25
//   Transactions: 8.5/15
//   Compliance: 10.0/10
//   Users: 6.6/10
//
// Impact Level: HIGH (Score: 78.5/100).
// Primary impact drivers: Revenue and Compliance.
// Supports $5.2M in annual revenue.
// Serves 125,000 customers.
// Subject to GDPR, HIPAA regulations.
```

### Batch Scoring

Calculate impact scores for multiple services efficiently:

```typescript
const businessServices = await getBusinessServices();
const scores = scoringService.batchCalculateImpactScores(businessServices);

// Sort by impact score descending
scores.sort((a, b) => b.totalScore - a.totalScore);

// Display top 10 highest-impact services
console.log('Top 10 Highest-Impact Services:');
scores.slice(0, 10).forEach((score, index) => {
  console.log(`${index + 1}. ${score.totalScore.toFixed(1)}/100`);
});
```

## Risk Rating

### Risk Matrix

Risk rating combines business criticality with operational metrics:

| Criticality | High Incidents | Medium Incidents | Low Incidents |
|-------------|----------------|------------------|---------------|
| **Tier 0** | CRITICAL | HIGH | MEDIUM |
| **Tier 1** | CRITICAL | HIGH | MEDIUM |
| **Tier 2** | HIGH | MEDIUM | LOW |
| **Tier 3** | MEDIUM | MEDIUM | LOW |
| **Tier 4** | MEDIUM | LOW | LOW |

### Risk Factors

Risk assessment evaluates 5 weighted factors (total: 100 points):

1. **Incident Frequency (30%)**: Incidents in last 30 days
   - 0 incidents = 0 points
   - 1-3 incidents = 20 points
   - 4-10 incidents = 50 points
   - 11-20 incidents = 75 points
   - 21+ incidents = 100 points

2. **Change Management (25%)**: Change failure rate
   - <5% failure rate = 15 points
   - 5-15% failure rate = 40 points
   - 15-25% failure rate = 70 points
   - >25% failure rate = 100 points

3. **Availability (25%)**: Availability vs. SLA target
   - Meets/exceeds SLA = 0 points
   - 0-0.5% below SLA = 30 points
   - 0.5-1% below SLA = 60 points
   - 1-2% below SLA = 85 points
   - >2% below SLA = 100 points

4. **Compliance (10%)**: Compliance status
   - 100% compliant = 0 points
   - 80-99% compliant = 40 points
   - 50-79% compliant = 75 points
   - <50% compliant = 100 points

5. **Audit Status (10%)**: Days since last audit
   - <90 days = 0 points
   - 90-180 days = 30 points
   - 180-365 days = 60 points
   - >365 days = 100 points

### Usage Example

```typescript
import { getRiskRatingService } from '@cmdb/bsm-impact-engine';

const riskService = getRiskRatingService();
const assessment = await riskService.calculateRiskAssessment(businessService);

console.log(`Risk Rating: ${assessment.riskRating.toUpperCase()}`);
console.log(`Risk Score: ${assessment.riskScore}/100`);
console.log(`Business Criticality: ${assessment.businessCriticality}`);

console.log('\nRisk Factors:');
assessment.factors.forEach(factor => {
  console.log(`  ${factor.factor} (${factor.weight * 100}% weight)`);
  console.log(`    Score: ${factor.score}/100`);
  console.log(`    ${factor.description}`);
});

console.log('\nRecommendations:');
assessment.recommendations.forEach(rec => {
  console.log(`  - ${rec}`);
});

// Example Output:
// Risk Rating: HIGH
// Risk Score: 62.5/100
// Business Criticality: tier_1
//
// Risk Factors:
//   Incident Frequency (30% weight)
//     Score: 75/100
//     15 incidents in the last 30 days - high risk
//   Change Management (25% weight)
//     Score: 40/100
//     8 changes with 12.3% failure rate - moderate risk
//   ...
//
// Recommendations:
//   - Conduct root cause analysis for recurring incidents
//   - Implement proactive monitoring and alerting
//   - Review and improve change management processes
```

## Blast Radius Analysis

### Overview

Blast radius analysis identifies all CIs and business services impacted when a specific CI fails or is taken offline. This supports:

- **Change Impact Assessment**: What's affected by planned maintenance?
- **Incident Management**: What's the scope of an outage?
- **Risk Analysis**: What are single points of failure?
- **DR Planning**: What redundancy is needed?

### Performance

- **Target**: <5 minutes for 100K+ CI graphs
- **Optimization**: Neo4j graph traversal with indexed queries
- **Parallelization**: Multiple analysis jobs run concurrently

### Usage Example

```typescript
import { getBlastRadiusService } from '@cmdb/bsm-impact-engine';

const blastRadiusService = getBlastRadiusService();

// Analyze blast radius for a CI
const analysis = await blastRadiusService.analyzeBlastRadius('ci-db-001', {
  maxHops: 10,                // Traverse up to 10 hops
  includeInactive: false,     // Exclude inactive CIs
  minImpactScore: 20,         // Filter low-impact services
});

console.log(`CIs Impacted: ${analysis.totalCIsImpacted}`);
console.log(`Services Impacted: ${analysis.totalServicesImpacted}`);
console.log(`Revenue at Risk: $${(analysis.totalRevenueAtRisk / 1_000_000).toFixed(1)}M`);
console.log(`Customers Impacted: ${analysis.totalCustomersImpacted.toLocaleString()}`);
console.log(`Downtime Cost: $${analysis.estimatedDowntimeCostPerHour.toLocaleString()}/hour`);
console.log(`Analysis Time: ${analysis.analysisTime}ms`);

// List impacted business services
console.log('\nImpacted Business Services:');
analysis.impactedBusinessServices
  .sort((a, b) => b.annualRevenue - a.annualRevenue)
  .slice(0, 10)
  .forEach(service => {
    console.log(`  - ${service.serviceName} (${service.criticality})`);
    console.log(`    Revenue: $${(service.annualRevenue / 1_000_000).toFixed(1)}M`);
    console.log(`    Customers: ${service.customerCount.toLocaleString()}`);
  });

// Generate report
const report = blastRadiusService.generateBlastRadiusReport(analysis);
console.log(report);
```

### Example Output

```
=== BLAST RADIUS ANALYSIS REPORT ===

Source CI: PostgreSQL Primary Database (database)
Analysis Date: 2025-11-06T10:30:00.000Z
Analysis Time: 2847ms

--- IMPACT SUMMARY ---
Total CIs Impacted: 47
Total Business Services Impacted: 12
Maximum Graph Depth: 6 hops

--- FINANCIAL IMPACT ---
Total Revenue at Risk: $12.50M annually
Estimated Downtime Cost: $25,342/hour
Total Customers Impacted: 387,000

--- TOP IMPACTED BUSINESS SERVICES ---
  - E-Commerce Platform (tier_0): $5.2M, 250,000 customers
  - Customer Portal (tier_1): $3.1M, 120,000 customers
  - Mobile App API (tier_1): $2.8M, 150,000 customers
  ...

--- CRITICAL IMPACTED CIs ---
  - Web Application Server 1 (virtual-machine) - tier_0 - 2 hops
  - Web Application Server 2 (virtual-machine) - tier_0 - 2 hops
  - API Gateway (load-balancer) - tier_1 - 3 hops
  ...

--- RECOMMENDATIONS ---
  ! HIGH IMPACT: This CI affects many business services
  - Consider implementing redundancy and failover mechanisms
  - Ensure comprehensive monitoring and alerting
  ! HIGH COST: Downtime cost exceeds $25K/hour
  - Implement disaster recovery plan
  - Consider active-active configuration
  ! HIGH USER IMPACT: Over 100K customers affected
  - Prepare customer communication plan
  - Ensure support team is staffed appropriately

=== END OF REPORT ===
```

### Multi-CI Analysis

Analyze combined impact of multiple CIs (scenario planning):

```typescript
const analysis = await blastRadiusService.analyzeMultipleCIBlastRadius([
  'ci-db-001',
  'ci-db-002',
  'ci-cache-001',
], {
  maxHops: 10,
  includeInactive: false,
});

// Results are deduplicated - shows unique impact
console.log(`Total Combined Impact: ${analysis.totalCIsImpacted} CIs`);
```

### Single Points of Failure

Identify CIs with no redundancy:

```typescript
const spofs = await blastRadiusService.findSinglePointsOfFailure('bs-ecommerce-001');

console.log('Single Points of Failure:');
spofs.forEach(spof => {
  console.log(`  - ${spof.ciName} (${spof.ciType})`);
  console.log(`    Reason: ${spof.criticalityReason}`);
});
```

## Revenue Impact Calculator

### Downtime Cost Estimation

Calculate financial impact of service outages:

```typescript
import { getRevenueImpactCalculator } from '@cmdb/bsm-impact-engine';

const revenueCalculator = getRevenueImpactCalculator();

// Calculate downtime cost
const downtimeCost = revenueCalculator.calculateDowntimeCost(businessService, 2); // 2 hours
console.log(`2-hour downtime cost: $${downtimeCost.toLocaleString()}`);

// Detailed revenue impact analysis
const impact = revenueCalculator.calculateRevenueImpact(
  businessService,
  2,
  'Database outage'
);

console.log(`Annual Revenue: $${(impact.annualRevenue / 1_000_000).toFixed(1)}M`);
console.log(`Revenue per Hour: $${impact.revenuePerHour.toLocaleString()}`);
console.log(`Downtime Cost per Hour: $${impact.downtimeCostPerHour.toLocaleString()}`);
console.log(`Criticality Multiplier: ${impact.criticalityMultiplier}x`);
console.log(`Estimated Loss: $${impact.estimatedLoss.toLocaleString()}`);
```

### Criticality Multipliers

Downtime costs are adjusted based on business criticality:

| Tier | Multiplier | Reason |
|------|------------|--------|
| **Tier 0** | 2.0x | Mission-critical, business-stopping impact |
| **Tier 1** | 1.5x | Business-critical, significant revenue loss |
| **Tier 2** | 1.2x | Important, moderate impact |
| **Tier 3** | 1.0x | Standard, baseline impact |
| **Tier 4** | 0.8x | Low priority, minimal impact |

### Formula

```typescript
// Base calculation
revenuePerHour = annualRevenue / 8760  // 365 days × 24 hours

// Apply criticality multiplier
downtimeCostPerHour = revenuePerHour × criticalityMultiplier

// Total downtime cost
totalCost = downtimeCostPerHour × downtimeHours
```

### Degradation Impact

Calculate cost for partial outages (service degraded but not down):

```typescript
// 50% service degradation for 4 hours
const degradationCost = revenueCalculator.calculateDegradationImpact(
  businessService,
  50,  // 50% degradation
  4    // 4 hours
);

console.log(`50% degradation for 4 hours: $${degradationCost.toLocaleString()}`);
```

### Time Period Analysis

Calculate impact for specific incident time ranges:

```typescript
const startTime = new Date('2025-11-06T08:00:00Z');
const endTime = new Date('2025-11-06T10:30:00Z');

const impact = revenueCalculator.calculateTimePeriodImpact(
  businessService,
  startTime,
  endTime,
  75  // 75% degradation
);

console.log(`Impact: $${impact.estimatedLoss.toLocaleString()}`);
console.log(`Duration: ${impact.calculatedFor.downtimeHours.toFixed(2)} hours`);
```

### Cumulative Impact

Calculate total impact across multiple incidents:

```typescript
const incidents = [
  { businessService: service1, startTime: incident1Start, endTime: incident1End },
  { businessService: service2, startTime: incident2Start, endTime: incident2End, degradationPercentage: 50 },
  { businessService: service3, startTime: incident3Start, endTime: incident3End },
];

const totalImpact = revenueCalculator.calculateCumulativeImpact(incidents);
console.log(`Total Monthly Impact: $${totalImpact.toLocaleString()}`);
```

### Revenue at Risk

Calculate total revenue at risk across multiple services:

```typescript
const impactedServices = [service1, service2, service3];
const revenueAtRisk = revenueCalculator.calculateRevenueAtRisk(impactedServices);

console.log(`Total Revenue at Risk: $${(revenueAtRisk / 1_000_000).toFixed(1)}M`);
```

## User Impact Calculator

### User Segments

Analyzes impact on different user populations:

```typescript
import { getUserImpactCalculator } from '@cmdb/bsm-impact-engine';

const userCalculator = getUserImpactCalculator();
const userImpact = userCalculator.calculateUserImpact(businessService);

console.log(`Total Users: ${userImpact.totalUsers.toLocaleString()}`);
console.log(`Internal Users: ${userImpact.internalUsers.toLocaleString()}`);
console.log(`External Users: ${userImpact.externalUsers.toLocaleString()}`);
console.log(`Daily Active Users: ${userImpact.dailyActiveUsers.toLocaleString()}`);
console.log(`Peak Concurrent Users: ${userImpact.peakConcurrentUsers.toLocaleString()}`);

console.log('\nUser Segments:');
userImpact.userSegments.forEach(segment => {
  console.log(`  ${segment.segmentName}: ${segment.userCount.toLocaleString()}`);
  console.log(`    Impact Severity: ${segment.impactSeverity}`);
  console.log(`    ${segment.description}`);
});

// Example Output:
// Total Users: 125,500
// Internal Users: 500
// External Users: 125,000
// Daily Active Users: 50,000
// Peak Concurrent Users: 4,000
//
// User Segments:
//   Premium Customers: 6,250
//     Impact Severity: critical
//     High-value customers with premium support agreements
//   Standard Customers: 118,750
//     Impact Severity: high
//     General customer base with standard service levels
//   Internal Users: 500
//     Impact Severity: medium
//     Employees and internal users
```

### Productivity Loss

Calculate cost of lost employee productivity:

```typescript
const productivityLoss = userCalculator.calculateProductivityLoss(
  500,   // 500 internal users
  4,     // 4 hours downtime
  50     // $50/hour average wage
);

console.log(`Productivity Loss: $${productivityLoss.toLocaleString()}`);
// Output: Productivity Loss: $100,000
```

### Customer Satisfaction Impact

Estimate impact on customer satisfaction (0-100 scale):

```typescript
const satisfactionImpact = userCalculator.calculateSatisfactionImpact(
  125000,  // 125K customers affected
  2,       // 2 hours downtime
  'tier_1' // Business-critical service
);

console.log(`Customer Satisfaction Impact: ${satisfactionImpact}/100`);
// Output: Customer Satisfaction Impact: 68/100
```

## Compliance Impact Calculator

### Regulatory Frameworks

Assesses impact across 7 compliance frameworks:

| Framework | Penalty Risk | Weight | Key Requirements |
|-----------|--------------|--------|------------------|
| **GDPR** | $20M | 1.0 | 72-hour breach notification, DPIA |
| **HIPAA** | $1.5M | 0.95 | 60-day breach notification, 6-year audit logs |
| **PCI DSS** | $500K | 0.9 | Quarterly scans, annual penetration testing |
| **SOX** | $5M | 0.85 | IT general controls, audit trails |
| **FINRA** | $1M | 0.8 | Financial recordkeeping, operations compliance |
| **ISO27001** | $100K | 0.5 | ISMS, annual certification audit |
| **SOC2** | $250K | 0.4 | Type II audit, control effectiveness |

### Usage Example

```typescript
import { getComplianceImpactCalculator } from '@cmdb/bsm-impact-engine';

const complianceCalculator = getComplianceImpactCalculator();
const complianceImpact = complianceCalculator.assessComplianceImpact(businessService);

console.log(`Applicable Frameworks: ${complianceImpact.applicableFrameworks.join(', ')}`);
console.log(`Data Classification: ${complianceImpact.dataClassification}`);
console.log(`Penalty Risk: $${complianceImpact.penaltyRisk.toLocaleString()}`);
console.log(`Data Subjects: ${complianceImpact.dataSubjects.toLocaleString()}`);
console.log(`Breach Notification Required: ${complianceImpact.breachNotificationRequired}`);

console.log('\nRegulatory Scope:');
complianceImpact.regulatoryScope.forEach(scope => {
  console.log(`  - ${scope}`);
});

console.log('\nAudit Requirements:');
complianceImpact.auditRequirements.forEach(requirement => {
  console.log(`  - ${requirement}`);
});

console.log(`\n${complianceImpact.impactDescription}`);

// Example Output:
// Applicable Frameworks: GDPR, HIPAA, PCI_DSS
// Data Classification: confidential
// Penalty Risk: $6,000,000
// Data Subjects: 125,000
// Breach Notification Required: true
//
// Regulatory Scope:
//   - EU personal data processing and privacy
//   - Protected Health Information (PHI) security and privacy
//   - Payment card data security and handling
//
// Audit Requirements:
//   - 72-hour breach notification to supervisory authority
//   - Maintain data processing records
//   - Conduct Data Protection Impact Assessment (DPIA)
//   - Breach notification within 60 days
//   - Maintain audit logs for 6 years
//   - Conduct annual risk assessment
//   - Quarterly vulnerability scans
//   - Annual penetration testing
//   - Maintain PCI compliance attestation
//
// This service is subject to GDPR, HIPAA, PCI_DSS regulations and handles
// confidential data. Approximately 125,000 individuals' data could be affected.
// Regulatory breach notification would be required for data exposure.
// Estimated regulatory penalty risk: $6,000,000.
```

### Penalty Risk Calculation

```typescript
// Calculate compliance score (0-10 for impact scoring)
const complianceScore = complianceCalculator.calculateComplianceScore(businessService);
console.log(`Compliance Score: ${complianceScore}/10`);

// Get compliance weight for impact calculations
const weight = complianceCalculator.calculateComplianceWeight(businessService);
console.log(`Compliance Weight: ${weight.weight.toFixed(2)}`);
console.log(`Frameworks: ${weight.frameworks.join(', ')}`);
console.log(`Penalty Risk: $${weight.penaltyRisk.toLocaleString()}`);
```

## Integration with HappyCMDB

### ITIL Service Manager Integration

BSM enriches ITIL processes with business context:

```typescript
import { getUnifiedService } from '@cmdb/framework-integration';

const unifiedService = getUnifiedService();

// Create enriched incident with BSM context
const incident = await unifiedService.createEnrichedIncident({
  businessServiceId: 'bs-ecommerce-001',
  title: 'Database connection pool exhausted',
  description: 'Application cannot connect to database',
  reportedBy: 'monitoring-system',
});

// BSM automatically enriches with:
// - Business criticality
// - Revenue at risk
// - Customers impacted
// - Compliance implications
// - Recommended priority

console.log(`Incident Priority: ${incident.priority}`);
console.log(`Estimated Impact: $${incident.estimated_revenue_impact.toLocaleString()}/hour`);
console.log(`Customers Impacted: ${incident.affected_users}`);
```

### TBM Cost Engine Integration

Combine BSM impact with TBM cost data:

```typescript
// Get complete service view with BSM + TBM
const completeView = await unifiedService.getCompleteServiceView('bs-ecommerce-001');

// BSM metrics
console.log(`Business Criticality: ${completeView.bsm_metrics.criticality}`);
console.log(`Impact Score: ${completeView.bsm_metrics.impact_score}/100`);
console.log(`Risk Rating: ${completeView.bsm_metrics.risk_rating}`);

// TBM metrics
console.log(`Monthly Cost: $${completeView.tbm_metrics.monthly_cost.toLocaleString()}`);
console.log(`Cost per Transaction: $${completeView.tbm_metrics.cost_per_transaction.toFixed(4)}`);

// Combined insights
console.log(`ROI: ${completeView.business_insights.roi.toFixed(2)}x`);
console.log(`Downtime Cost: $${completeView.business_insights.downtime_cost_per_hour.toLocaleString()}/hour`);
```

### Discovery Enrichment

BSM enriches discovered CIs automatically:

```typescript
// Discovery engine automatically calls BSM for enrichment
// After discovery, CIs have BSM attributes:

const ci = await getCIById('ci-web-001');

console.log(`Business Criticality: ${ci.business_criticality}`);
console.log(`Impact Score: ${ci.impact_score}`);
console.log(`Risk Rating: ${ci.risk_rating}`);
console.log(`Impacted Services: ${ci.upstream_services.length}`);
```

## Configuration

### Environment Variables

```bash
# BSM Configuration
BSM_ENABLED=true
BSM_BATCH_SIZE=100
BSM_MAX_BLAST_RADIUS_HOPS=10

# Criticality Thresholds (USD)
BSM_TIER_0_THRESHOLD=1000000    # $1M
BSM_TIER_1_THRESHOLD=500000     # $500K
BSM_TIER_2_THRESHOLD=100000     # $100K
BSM_TIER_3_THRESHOLD=10000      # $10K

# Scoring Weights (0-1 scale)
BSM_WEIGHT_REVENUE=0.40
BSM_WEIGHT_CUSTOMERS=0.25
BSM_WEIGHT_TRANSACTIONS=0.15
BSM_WEIGHT_COMPLIANCE=0.10
BSM_WEIGHT_USERS=0.10

# Risk Assessment
BSM_RISK_INCIDENT_WEIGHT=0.30
BSM_RISK_CHANGE_WEIGHT=0.25
BSM_RISK_AVAILABILITY_WEIGHT=0.25
BSM_RISK_COMPLIANCE_WEIGHT=0.10
BSM_RISK_AUDIT_WEIGHT=0.10

# Performance
BSM_BLAST_RADIUS_TIMEOUT=300000  # 5 minutes
BSM_GRAPH_TRAVERSAL_CACHE_TTL=300  # 5 minutes
```

### Custom Configuration

```typescript
import { getCriticalityCalculatorService } from '@cmdb/bsm-impact-engine';

const config = {
  thresholds: {
    tier_0: 2_000_000,
    tier_1: 1_000_000,
    tier_2: 250_000,
    tier_3: 50_000,
  },
  weights: {
    revenue: 0.35,
    customers: 0.30,
    transactions: 0.20,
    compliance: 0.10,
    users: 0.05,
  },
  propagateToChildren: true,  // Auto-propagate criticality to dependent CIs
};

const criticalityService = getCriticalityCalculatorService();
const calculation = await criticalityService.calculateCriticality(
  businessService,
  config
);
```

## Performance Optimization

### Blast Radius Performance

**Optimization Techniques**:

1. **Graph Indexing**: Ensure Neo4j indexes on critical properties
   ```cypher
   CREATE INDEX ci_id_index FOR (ci:CI) ON (ci.id);
   CREATE INDEX ci_type_index FOR (ci:CI) ON (ci.type);
   CREATE INDEX bs_id_index FOR (bs:BusinessService) ON (bs.id);
   ```

2. **Limit Traversal Depth**: Set reasonable `maxHops` (default: 10)
   ```typescript
   const analysis = await blastRadiusService.analyzeBlastRadius(ciId, {
     maxHops: 8,  // Reduce from 10 to 8 for faster results
   });
   ```

3. **Filter Low-Impact Services**: Use `minImpactScore` to exclude noise
   ```typescript
   const analysis = await blastRadiusService.analyzeBlastRadius(ciId, {
     minImpactScore: 30,  // Only include services with score >= 30
   });
   ```

4. **Exclude Inactive CIs**: Skip decommissioned CIs
   ```typescript
   const analysis = await blastRadiusService.analyzeBlastRadius(ciId, {
     includeInactive: false,
   });
   ```

### Caching Strategy

```typescript
// Cache impact scores for 5 minutes (default)
import { Redis } from 'ioredis';
const redis = new Redis();

const cacheKey = `impact-score:${businessService.id}`;
const cached = await redis.get(cacheKey);

if (cached) {
  return JSON.parse(cached);
}

const impactScore = scoringService.calculateImpactScore(businessService);
await redis.setex(cacheKey, 300, JSON.stringify(impactScore));
return impactScore;
```

### Batch Processing

```typescript
// Process 1000 services in batches of 100
const allServices = await getBusinessServices();
const batchSize = 100;

for (let i = 0; i < allServices.length; i += batchSize) {
  const batch = allServices.slice(i, i + batchSize);
  const calculations = await criticalityService.batchCalculateCriticality(batch);

  // Store calculations
  await storeCriticalityCalculations(calculations);

  console.log(`Processed ${i + batch.length} of ${allServices.length} services`);
}
```

## Use Cases

### 1. Change Impact Assessment

**Scenario**: Planning database maintenance window

```typescript
// Analyze blast radius before change
const analysis = await blastRadiusService.analyzeBlastRadius('ci-db-primary-001');

if (analysis.totalServicesImpacted > 5) {
  console.log('HIGH IMPACT: Requires CAB approval');
  console.log(`Revenue at Risk: $${(analysis.totalRevenueAtRisk / 1_000_000).toFixed(1)}M`);
  console.log(`Downtime Cost: $${analysis.estimatedDowntimeCostPerHour.toLocaleString()}/hour`);

  // Schedule maintenance during low-traffic period
  const maintenanceWindow = findLowestTrafficWindow(analysis.impactedBusinessServices);
  console.log(`Recommended Window: ${maintenanceWindow}`);
} else {
  console.log('LOW IMPACT: Standard change process');
}
```

### 2. Incident Prioritization

**Scenario**: Multiple incidents reported, need to prioritize response

```typescript
const incidents = await getOpenIncidents();

// Calculate impact scores for all incidents
const prioritizedIncidents = await Promise.all(
  incidents.map(async (incident) => {
    const service = await getBusinessService(incident.businessServiceId);
    const impactScore = scoringService.calculateImpactScore(service);
    const riskAssessment = await riskService.calculateRiskAssessment(service);

    return {
      incident,
      impactScore: impactScore.totalScore,
      riskRating: riskAssessment.riskRating,
      revenueAtRisk: service.bsm_attributes.annual_revenue_supported,
    };
  })
);

// Sort by impact score descending
prioritizedIncidents.sort((a, b) => b.impactScore - a.impactScore);

console.log('Prioritized Incident Queue:');
prioritizedIncidents.forEach((item, index) => {
  console.log(`${index + 1}. ${item.incident.title}`);
  console.log(`   Impact: ${item.impactScore}/100, Risk: ${item.riskRating}`);
  console.log(`   Revenue: $${(item.revenueAtRisk / 1_000_000).toFixed(1)}M`);
});
```

### 3. Cost-Benefit Analysis

**Scenario**: Justify investment in high-availability infrastructure

```typescript
// Calculate current downtime risk
const currentService = await getBusinessService('bs-ecommerce-001');
const currentRisk = await riskService.calculateRiskAssessment(currentService);

// Estimate annual downtime (based on incident history)
const avgDowntimeHours = 8; // 8 hours/year
const downtimeCost = revenueCalculator.calculateDowntimeCost(currentService, avgDowntimeHours);

// Calculate HA infrastructure cost
const haInfrastructureCost = 500_000; // $500K investment

// Calculate breakeven
const yearsToBreakeven = haInfrastructureCost / downtimeCost;

console.log('High-Availability Cost-Benefit Analysis:');
console.log(`Current Downtime Risk: ${currentRisk.riskRating}`);
console.log(`Annual Downtime Cost: $${downtimeCost.toLocaleString()}`);
console.log(`HA Infrastructure Cost: $${haInfrastructureCost.toLocaleString()}`);
console.log(`Breakeven Period: ${yearsToBreakeven.toFixed(1)} years`);

if (yearsToBreakeven <= 2) {
  console.log('RECOMMENDATION: Invest in HA infrastructure');
} else {
  console.log('RECOMMENDATION: Consider alternative risk mitigation strategies');
}
```

### 4. Service Portfolio Optimization

**Scenario**: Identify services for consolidation or decommissioning

```typescript
const allServices = await getBusinessServices();
const scores = scoringService.batchCalculateImpactScores(allServices);

// Find low-impact, high-cost services
const candidates = scores
  .filter(score => score.totalScore < 30) // Low impact
  .map(score => {
    const service = allServices.find(s => s.id === score.serviceId);
    return {
      service,
      impactScore: score.totalScore,
      monthlyCost: service.tbm_attributes.monthly_cost,
    };
  })
  .filter(candidate => candidate.monthlyCost > 10_000) // High cost
  .sort((a, b) => b.monthlyCost - a.monthlyCost);

console.log('Service Rationalization Candidates:');
candidates.forEach(candidate => {
  console.log(`- ${candidate.service.name}`);
  console.log(`  Impact Score: ${candidate.impactScore}/100`);
  console.log(`  Monthly Cost: $${candidate.monthlyCost.toLocaleString()}`);
  console.log(`  RECOMMENDATION: Evaluate for decommissioning`);
});
```

### 5. Compliance Risk Reporting

**Scenario**: Generate quarterly compliance risk report

```typescript
const services = await getBusinessServices();

const complianceReport = services
  .map(service => {
    const complianceImpact = complianceCalculator.assessComplianceImpact(service);
    const riskAssessment = await riskService.calculateRiskAssessment(service);

    return {
      serviceName: service.name,
      frameworks: complianceImpact.applicableFrameworks,
      penaltyRisk: complianceImpact.penaltyRisk,
      dataSubjects: complianceImpact.dataSubjects,
      riskRating: riskAssessment.riskRating,
      breachNotificationRequired: complianceImpact.breachNotificationRequired,
    };
  })
  .filter(item => item.frameworks.length > 0)
  .sort((a, b) => b.penaltyRisk - a.penaltyRisk);

console.log('Quarterly Compliance Risk Report');
console.log('=================================\n');

const totalPenaltyRisk = complianceReport.reduce((sum, item) => sum + item.penaltyRisk, 0);
const totalDataSubjects = complianceReport.reduce((sum, item) => sum + item.dataSubjects, 0);

console.log(`Total Penalty Risk: $${totalPenaltyRisk.toLocaleString()}`);
console.log(`Total Data Subjects: ${totalDataSubjects.toLocaleString()}\n`);

console.log('High-Risk Services:');
complianceReport
  .filter(item => item.riskRating === 'critical' || item.riskRating === 'high')
  .forEach(item => {
    console.log(`- ${item.serviceName}`);
    console.log(`  Frameworks: ${item.frameworks.join(', ')}`);
    console.log(`  Penalty Risk: $${item.penaltyRisk.toLocaleString()}`);
    console.log(`  Data Subjects: ${item.dataSubjects.toLocaleString()}`);
    console.log(`  Risk Rating: ${item.riskRating}`);
  });
```

## API Reference

### getCriticalityCalculatorService()

Returns singleton instance of CriticalityCalculatorService.

#### Methods

**calculateCriticality(businessService, options?)**
- **Parameters**:
  - `businessService`: BusinessService object
  - `options?`: CriticalityCalculationOptions
- **Returns**: Promise<CriticalityCalculation>
- **Description**: Calculates business criticality tier (0-4)

**batchCalculateCriticality(businessServices, options?)**
- **Parameters**:
  - `businessServices`: BusinessService[]
  - `options?`: CriticalityCalculationOptions
- **Returns**: Promise<CriticalityCalculation[]>
- **Description**: Batch calculates criticality for multiple services

### getImpactScoringService()

Returns singleton instance of ImpactScoringService.

#### Methods

**calculateImpactScore(businessService)**
- **Parameters**: `businessService`: BusinessService
- **Returns**: ImpactScore
- **Description**: Calculates 0-100 impact score with component breakdown

**classifyImpactLevel(totalScore)**
- **Parameters**: `totalScore`: number (0-100)
- **Returns**: 'critical' | 'high' | 'medium' | 'low'
- **Description**: Classifies impact level based on score

**generateImpactSummary(impactScore)**
- **Parameters**: `impactScore`: ImpactScore
- **Returns**: string
- **Description**: Generates human-readable impact summary

**batchCalculateImpactScores(businessServices)**
- **Parameters**: `businessServices`: BusinessService[]
- **Returns**: ImpactScore[]
- **Description**: Batch calculates impact scores

**calculateAggregateImpact(businessServices)**
- **Parameters**: `businessServices`: BusinessService[]
- **Returns**: ImpactScore
- **Description**: Calculates aggregate impact across multiple services

### getRiskRatingService()

Returns singleton instance of RiskRatingService.

#### Methods

**calculateRiskAssessment(businessService)**
- **Parameters**: `businessService`: BusinessService
- **Returns**: Promise<RiskAssessment>
- **Description**: Calculates comprehensive risk assessment with factors

### getBlastRadiusService()

Returns singleton instance of BlastRadiusService.

#### Methods

**analyzeBlastRadius(ciId, options?)**
- **Parameters**:
  - `ciId`: string
  - `options?`: BlastRadiusOptions
- **Returns**: Promise<BlastRadiusAnalysis>
- **Description**: Analyzes blast radius for a CI

**analyzeMultipleCIBlastRadius(ciIds, options?)**
- **Parameters**:
  - `ciIds`: string[]
  - `options?`: BlastRadiusOptions
- **Returns**: Promise<BlastRadiusAnalysis>
- **Description**: Analyzes combined blast radius for multiple CIs

**generateBlastRadiusReport(analysis)**
- **Parameters**: `analysis`: BlastRadiusAnalysis
- **Returns**: string
- **Description**: Generates human-readable blast radius report

**findSinglePointsOfFailure(businessServiceId)**
- **Parameters**: `businessServiceId`: string
- **Returns**: Promise<Array<{ciId, ciName, ciType, criticalityReason}>>
- **Description**: Identifies single points of failure for a service

### getRevenueImpactCalculator()

Returns singleton instance of RevenueImpactCalculator.

#### Methods

**calculateDowntimeCost(businessService, downtimeHours)**
- **Parameters**:
  - `businessService`: BusinessService
  - `downtimeHours`: number
- **Returns**: number
- **Description**: Calculates downtime cost in USD

**calculateRevenueImpact(businessService, downtimeHours, scenario?)**
- **Parameters**:
  - `businessService`: BusinessService
  - `downtimeHours`: number
  - `scenario?`: string
- **Returns**: RevenueImpactAnalysis
- **Description**: Detailed revenue impact analysis

**calculateRevenueAtRisk(impactedServices)**
- **Parameters**: `impactedServices`: BusinessService[]
- **Returns**: number
- **Description**: Total revenue at risk across services

**calculateDegradationImpact(businessService, degradationPercentage, durationHours)**
- **Parameters**:
  - `businessService`: BusinessService
  - `degradationPercentage`: number (0-100)
  - `durationHours`: number
- **Returns**: number
- **Description**: Calculates cost for partial outages

**calculateTimePeriodImpact(businessService, startTime, endTime, degradationPercentage?)**
- **Parameters**:
  - `businessService`: BusinessService
  - `startTime`: Date
  - `endTime`: Date
  - `degradationPercentage?`: number (default: 100)
- **Returns**: RevenueImpactAnalysis
- **Description**: Calculates impact for specific time period

**calculateCumulativeImpact(incidents)**
- **Parameters**: `incidents`: Array<{businessService, startTime, endTime, degradationPercentage?}>
- **Returns**: number
- **Description**: Calculates total impact across multiple incidents

### getUserImpactCalculator()

Returns singleton instance of UserImpactCalculator.

#### Methods

**calculateUserImpact(businessService)**
- **Parameters**: `businessService`: BusinessService
- **Returns**: UserImpact
- **Description**: Calculates user impact with segments

**calculateAggregateUserImpact(businessServices)**
- **Parameters**: `businessServices`: BusinessService[]
- **Returns**: UserImpact
- **Description**: Calculates aggregate user impact

**calculateProductivityLoss(internalUsers, downtimeHours, averageHourlyWage?)**
- **Parameters**:
  - `internalUsers`: number
  - `downtimeHours`: number
  - `averageHourlyWage?`: number (default: 50)
- **Returns**: number
- **Description**: Calculates productivity loss in USD

**calculateSatisfactionImpact(customerCount, downtimeHours, criticality)**
- **Parameters**:
  - `customerCount`: number
  - `downtimeHours`: number
  - `criticality`: string
- **Returns**: number (0-100)
- **Description**: Estimates customer satisfaction impact

### getComplianceImpactCalculator()

Returns singleton instance of ComplianceImpactCalculator.

#### Methods

**assessComplianceImpact(businessService)**
- **Parameters**: `businessService`: BusinessService
- **Returns**: ComplianceImpact
- **Description**: Assesses comprehensive compliance impact

**calculateComplianceWeight(businessService)**
- **Parameters**: `businessService`: BusinessService
- **Returns**: ComplianceImpactWeight
- **Description**: Calculates compliance weight for scoring (0-1)

**calculateComplianceScore(businessService)**
- **Parameters**: `businessService`: BusinessService
- **Returns**: number (0-10)
- **Description**: Calculates compliance score for impact scoring

## Best Practices

::: tip Automated Enrichment
Enable automatic BSM enrichment during discovery to ensure all CIs have up-to-date business context.
:::

::: tip Regular Recalculation
Schedule nightly batch jobs to recalculate criticality, impact scores, and risk ratings as business metrics change.
:::

::: tip Blast Radius Pre-Calculation
Pre-calculate blast radius for critical CIs (Tier 0-1) and cache results for faster change approval workflows.
:::

::: warning Performance Considerations
Blast radius analysis on large graphs (100K+ CIs) can take several minutes. Use appropriate `maxHops` and `minImpactScore` filters.
:::

::: danger Compliance Data Sensitivity
Compliance penalty estimates are approximations. Consult legal/compliance teams for accurate regulatory risk assessment.
:::

## Troubleshooting

### Issue 1: Blast Radius Analysis Timeout

**Problem**: Blast radius analysis exceeds 5-minute timeout

**Solution**: Optimize graph traversal parameters

```typescript
// Reduce max hops
const analysis = await blastRadiusService.analyzeBlastRadius(ciId, {
  maxHops: 6,  // Reduce from 10 to 6
  minImpactScore: 40,  // Increase threshold
  includeInactive: false,
});

// Check Neo4j indexes
// Ensure indexes exist on CI.id, CI.type, BusinessService.id
```

### Issue 2: Inaccurate Criticality Classification

**Problem**: Services classified into wrong tier

**Solution**: Verify business service data and adjust thresholds

```typescript
// Check business service attributes
console.log('Annual Revenue:', businessService.bsm_attributes.annual_revenue_supported);
console.log('Customer Count:', businessService.bsm_attributes.customer_count);
console.log('Transactions:', businessService.bsm_attributes.transaction_volume_daily);

// Adjust thresholds if needed
const calculation = await criticalityService.calculateCriticality(businessService, {
  thresholds: {
    tier_0: 2_000_000,  // Increase Tier 0 threshold
    tier_1: 1_000_000,
    tier_2: 250_000,
    tier_3: 50_000,
  },
});
```

### Issue 3: Missing Compliance Data

**Problem**: Compliance impact returns no frameworks

**Solution**: Ensure compliance requirements are populated

```typescript
// Check compliance requirements
console.log('Compliance Requirements:',
  businessService.bsm_attributes.compliance_requirements);

// Add compliance requirements
const updatedService = await updateBusinessService(businessService.id, {
  bsm_attributes: {
    ...businessService.bsm_attributes,
    compliance_requirements: [
      {
        framework: 'GDPR',
        applicable: true,
        compliance_status: 'compliant',
        last_audit: new Date('2025-09-01'),
      },
    ],
  },
});
```

## Related Resources

- [ITIL Service Manager](/components/itil-service-manager) - Incident and change management with BSM context
- [TBM Cost Engine](/components/tbm-cost-engine) - Cost allocation and financial analysis
- [Unified Framework](/components/unified-framework) - Integrated ITIL + TBM + BSM views
- [Discovery Agents](/components/discovery-agents) - Automatic BSM enrichment during discovery
- [Business Services](/architecture/unified-data-model#business-services) - Business service data model

## Next Steps

- [ ] Configure criticality thresholds for your organization
- [ ] Define compliance requirements for business services
- [ ] Set up automated nightly BSM calculations
- [ ] Pre-calculate blast radius for critical infrastructure
- [ ] Integrate BSM metrics into dashboards and reports
- [ ] Train service owners on criticality classification
- [ ] Establish change approval workflows based on blast radius

---

**Last Updated**: 2025-11-06
**Maintainer**: HappyCMDB Team
**Package Version**: 3.0.0
**Status**: Production-Ready
