# @cmdb/bsm-impact-engine

Business Service Mapping (BSM) Impact Engine for HappyCMDB v3.0 Phase 4.

Provides comprehensive impact analysis, blast radius calculation, risk assessment, and business criticality scoring for IT infrastructure and business services.

## Features

- **Business Criticality Calculation** - Auto-classify services into Tier 0-4 based on revenue, customers, compliance, and transactions
- **Impact Scoring** - Calculate 0-100 impact scores with weighted factors
- **Blast Radius Analysis** - Find all CIs and business services affected by a failure
- **Risk Assessment** - Calculate risk ratings (Critical/High/Medium/Low) based on incidents, changes, and compliance
- **Revenue Impact** - Estimate downtime costs and revenue at risk
- **User Impact** - Calculate internal and external user impact
- **Compliance Impact** - Assess regulatory penalties and breach notification requirements
- **Graph Traversal** - Efficient Neo4j graph traversal with performance optimization

## Installation

```bash
npm install @cmdb/bsm-impact-engine
```

## Usage

### 1. Business Criticality Calculation

Automatically classify business services into tiers (0-4):

```typescript
import { getCriticalityCalculatorService } from '@cmdb/bsm-impact-engine';

const criticalityService = getCriticalityCalculatorService();

// Calculate criticality for a business service
const calculation = await criticalityService.calculateCriticality(businessService);

console.log(`Criticality: ${calculation.calculatedCriticality}`);
console.log(`Impact Score: ${calculation.impactScore}/100`);
console.log(`Confidence: ${(calculation.confidence * 100).toFixed(0)}%`);
console.log(`Recommendation: ${calculation.recommendation}`);

// Result:
// Criticality: tier_1
// Impact Score: 78.5/100
// Confidence: 85%
// Recommendation: Business-critical service requiring high availability...
```

**Tier Classification:**
- **Tier 0**: Mission-critical, >$1M annual revenue
- **Tier 1**: Business-critical, $500K-$1M revenue
- **Tier 2**: Important, $100K-$500K revenue
- **Tier 3**: Standard, $10K-$100K revenue
- **Tier 4**: Low priority, <$10K revenue

### 2. Impact Scoring

Calculate comprehensive 0-100 impact scores:

```typescript
import { getImpactScoringService } from '@cmdb/bsm-impact-engine';

const scoringService = getImpactScoringService();

// Calculate impact score
const impactScore = scoringService.calculateImpactScore(businessService);

console.log(`Total Score: ${impactScore.totalScore}/100`);
console.log(`Revenue Impact: $${(impactScore.revenueImpact / 1_000_000).toFixed(1)}M`);
console.log(`Customer Impact: ${impactScore.customerImpact.toLocaleString()}`);
console.log(`Compliance: ${impactScore.complianceImpact.frameworks.join(', ')}`);

// Component breakdown
console.log('Score Components:');
console.log(`  Revenue: ${impactScore.components.revenue}/40`);
console.log(`  Customers: ${impactScore.components.customers}/25`);
console.log(`  Transactions: ${impactScore.components.transactions}/15`);
console.log(`  Compliance: ${impactScore.components.compliance}/10`);
console.log(`  Users: ${impactScore.components.users}/10`);

// Generate summary
const summary = scoringService.generateImpactSummary(impactScore);
console.log(summary);
```

**Scoring Formula:**
- Revenue (40%): Logarithmic scale, $0 to $100M+
- Customers (25%): Logarithmic scale, 0 to 1M+
- Transactions (15%): Linear scale, 0 to 1M/day
- Compliance (10%): Regulatory framework weight
- Users (10%): Internal user count

### 3. Blast Radius Analysis

Find all CIs and business services impacted by a failure:

```typescript
import { getBlastRadiusService } from '@cmdb/bsm-impact-engine';

const blastRadiusService = getBlastRadiusService();

// Analyze blast radius for a CI
const analysis = await blastRadiusService.analyzeBlastRadius('ci-web-001', {
  maxHops: 10,
  includeInactive: false,
  minImpactScore: 20,
});

console.log(`CIs Impacted: ${analysis.totalCIsImpacted}`);
console.log(`Services Impacted: ${analysis.totalServicesImpacted}`);
console.log(`Revenue at Risk: $${(analysis.totalRevenueAtRisk / 1_000_000).toFixed(1)}M`);
console.log(`Customers Impacted: ${analysis.totalCustomersImpacted.toLocaleString()}`);
console.log(`Downtime Cost: $${analysis.estimatedDowntimeCostPerHour.toLocaleString()}/hour`);
console.log(`Analysis Time: ${analysis.analysisTime}ms`);

// List impacted business services
console.log('\nImpacted Business Services:');
for (const service of analysis.impactedBusinessServices) {
  console.log(`  - ${service.serviceName} (${service.criticality})`);
  console.log(`    Revenue: $${(service.annualRevenue / 1_000_000).toFixed(1)}M`);
  console.log(`    Customers: ${service.customerCount.toLocaleString()}`);
}

// Generate report
const report = blastRadiusService.generateBlastRadiusReport(analysis);
console.log(report);
```

**Performance:**
- Target: <5 minutes for 100K+ CI graphs
- Uses optimized Neo4j graph traversal
- Supports parallel analysis of multiple CIs

### 4. Risk Assessment

Calculate risk ratings based on multiple factors:

```typescript
import { getRiskRatingService } from '@cmdb/bsm-impact-engine';

const riskService = getRiskRatingService();

// Calculate risk assessment
const assessment = await riskService.calculateRiskAssessment(businessService);

console.log(`Risk Rating: ${assessment.riskRating.toUpperCase()}`);
console.log(`Risk Score: ${assessment.riskScore}/100`);
console.log(`Business Criticality: ${assessment.businessCriticality}`);

// Risk factors
console.log('\nRisk Factors:');
for (const factor of assessment.factors) {
  console.log(`  ${factor.factor} (${factor.weight * 100}% weight)`);
  console.log(`    Score: ${factor.score}/100`);
  console.log(`    ${factor.description}`);
}

// Recommendations
console.log('\nRecommendations:');
for (const recommendation of assessment.recommendations) {
  console.log(`  - ${recommendation}`);
}
```

**Risk Matrix:**
- **Critical**: Tier 0 + High incidents
- **High**: Tier 0-1 + Medium incidents
- **Medium**: Tier 2-3 + Low incidents
- **Low**: Tier 4 + Low incidents

**Risk Factors:**
- Incident Frequency (30%)
- Change Management (25%)
- Availability (25%)
- Compliance (10%)
- Audit Status (10%)

### 5. Revenue Impact Calculation

Estimate downtime costs and revenue impact:

```typescript
import { getRevenueImpactCalculator } from '@cmdb/bsm-impact-engine';

const revenueCalculator = getRevenueImpactCalculator();

// Calculate downtime cost
const downtimeCost = revenueCalculator.calculateDowntimeCost(businessService, 2); // 2 hours
console.log(`2-hour downtime cost: $${downtimeCost.toLocaleString()}`);

// Detailed revenue impact analysis
const impact = revenueCalculator.calculateRevenueImpact(businessService, 2, 'Database outage');
console.log(`Annual Revenue: $${(impact.annualRevenue / 1_000_000).toFixed(1)}M`);
console.log(`Revenue per Hour: $${impact.revenuePerHour.toLocaleString()}`);
console.log(`Downtime Cost per Hour: $${impact.downtimeCostPerHour.toLocaleString()}`);
console.log(`Criticality Multiplier: ${impact.criticalityMultiplier}x`);
console.log(`Estimated Loss: $${impact.estimatedLoss.toLocaleString()}`);

// Calculate degradation impact (partial outage)
const degradationCost = revenueCalculator.calculateDegradationImpact(
  businessService,
  50, // 50% degradation
  4 // 4 hours
);
console.log(`50% degradation for 4 hours: $${degradationCost.toLocaleString()}`);

// Calculate revenue at risk across multiple services
const revenueAtRisk = revenueCalculator.calculateRevenueAtRisk([service1, service2, service3]);
console.log(`Total revenue at risk: $${(revenueAtRisk / 1_000_000).toFixed(1)}M`);
```

### 6. User Impact Analysis

Calculate internal and external user impact:

```typescript
import { getUserImpactCalculator } from '@cmdb/bsm-impact-engine';

const userCalculator = getUserImpactCalculator();

// Calculate user impact
const userImpact = userCalculator.calculateUserImpact(businessService);

console.log(`Total Users: ${userImpact.totalUsers.toLocaleString()}`);
console.log(`Internal Users: ${userImpact.internalUsers.toLocaleString()}`);
console.log(`External Users: ${userImpact.externalUsers.toLocaleString()}`);
console.log(`Daily Active Users: ${userImpact.dailyActiveUsers.toLocaleString()}`);
console.log(`Peak Concurrent Users: ${userImpact.peakConcurrentUsers.toLocaleString()}`);

// User segments
console.log('\nUser Segments:');
for (const segment of userImpact.userSegments) {
  console.log(`  ${segment.segmentName}: ${segment.userCount.toLocaleString()}`);
  console.log(`    Impact Severity: ${segment.impactSeverity}`);
  console.log(`    ${segment.description}`);
}

// Calculate productivity loss
const productivityLoss = userCalculator.calculateProductivityLoss(
  userImpact.internalUsers,
  4, // 4 hours downtime
  50 // $50/hour average wage
);
console.log(`Productivity Loss: $${productivityLoss.toLocaleString()}`);

// Calculate satisfaction impact
const satisfactionImpact = userCalculator.calculateSatisfactionImpact(
  userImpact.externalUsers,
  2, // 2 hours downtime
  'tier_1'
);
console.log(`Customer Satisfaction Impact: ${satisfactionImpact}/100`);
```

### 7. Compliance Impact Assessment

Assess regulatory compliance impact:

```typescript
import { getComplianceImpactCalculator } from '@cmdb/bsm-impact-engine';

const complianceCalculator = getComplianceImpactCalculator();

// Assess compliance impact
const complianceImpact = complianceCalculator.assessComplianceImpact(businessService);

console.log(`Applicable Frameworks: ${complianceImpact.applicableFrameworks.join(', ')}`);
console.log(`Data Classification: ${complianceImpact.dataClassification}`);
console.log(`Penalty Risk: $${complianceImpact.penaltyRisk.toLocaleString()}`);
console.log(`Data Subjects: ${complianceImpact.dataSubjects.toLocaleString()}`);
console.log(`Breach Notification Required: ${complianceImpact.breachNotificationRequired}`);

console.log('\nRegulatory Scope:');
for (const scope of complianceImpact.regulatoryScope) {
  console.log(`  - ${scope}`);
}

console.log('\nAudit Requirements:');
for (const requirement of complianceImpact.auditRequirements) {
  console.log(`  - ${requirement}`);
}

console.log(`\n${complianceImpact.impactDescription}`);

// Calculate compliance score (0-10)
const complianceScore = complianceCalculator.calculateComplianceScore(businessService);
console.log(`Compliance Score: ${complianceScore}/10`);
```

### 8. Graph Traversal

Efficient Neo4j graph traversal utilities:

```typescript
import { getGraphTraversal } from '@cmdb/bsm-impact-engine';

const graphTraversal = getGraphTraversal();

// Find downstream dependencies
const dependencyTree = await graphTraversal.findDownstreamDependencies('ci-web-001', 10);
console.log(`Total Dependencies: ${dependencyTree.totalNodes}`);
console.log(`Max Depth: ${dependencyTree.maxDepth}`);

// Find upstream business services
const upstreamServices = await graphTraversal.findUpstreamBusinessServices('ci-db-001');
console.log(`Upstream Services: ${upstreamServices.length}`);

// Find critical path
const criticalPath = await graphTraversal.findCriticalPath('ci-app-001', 'bs-ecommerce-001');
console.log(`Path Length: ${criticalPath.pathLength} hops`);
console.log(`Bottlenecks: ${criticalPath.bottlenecks.join(', ')}`);

// Propagate criticality
const updatedCount = await graphTraversal.propagateCriticality('bs-payment-001', 'tier_0', 5);
console.log(`Propagated to ${updatedCount} CIs`);

// Find blast radius
const impactedCIs = await graphTraversal.findBlastRadius('ci-web-001', {
  maxHops: 10,
  includeInactive: false,
  minImpactScore: 20,
});
console.log(`Found ${impactedCIs.length} impacted CIs`);
```

## Architecture

### Services

- **CriticalityCalculatorService** - Business criticality tier classification
- **ImpactScoringService** - 0-100 impact score calculation
- **RiskRatingService** - Risk rating (Critical/High/Medium/Low)
- **BlastRadiusService** - Blast radius and impact analysis

### Calculators

- **RevenueImpactCalculator** - Revenue and downtime cost calculations
- **UserImpactCalculator** - User impact analysis
- **ComplianceImpactCalculator** - Compliance and regulatory impact

### Utilities

- **GraphTraversal** - Efficient Neo4j graph traversal

## Performance

- **Blast Radius Analysis**: <5 minutes for 100K+ CI graphs
- **Impact Scoring**: <100ms per service
- **Graph Traversal**: Optimized with Neo4j indexes and parameterized queries
- **Singleton Pattern**: All services use singleton instances for efficiency

## Integration Points

- **@cmdb/unified-model** - Unified v3.0 data types
- **@cmdb/database** - Neo4j client (singleton)
- **@cmdb/itil-service-manager** - Incident and change data
- **@cmdb/tbm-cost-engine** - Cost allocation data

## Testing

```bash
# Run all tests
npm test

# Run unit tests
npm run test:unit

# Run integration tests
npm run test:integration

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

## Building

```bash
# Build TypeScript
npm run build

# Watch mode
npm run build:watch

# Clean build artifacts
npm run clean
```

## License

MIT

## Author

HappyCMDB Team
