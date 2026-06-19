# @cmdb/itil-service-manager

ITIL v4 Service Management for HappyCMDB v3.0

## Overview

This package provides comprehensive ITIL v4 service management capabilities for HappyCMDB, including:

- **Configuration Management**: CI lifecycle management, audits, and compliance tracking
- **Incident Management**: Automated priority calculation based on ITIL matrix (Impact x Urgency)
- **Change Management**: Risk assessment with CAB approval workflows
- **Baseline Management**: Configuration drift detection and remediation

## Features

### Configuration Management

- ✅ ITIL lifecycle stage management (planning → design → build → test → deploy → operate → retire)
- ✅ Configuration status tracking (planned, ordered, in_development, active, maintenance, retired, disposed)
- ✅ Lifecycle transition validation
- ✅ CI audit scheduling and completion
- ✅ Configuration accuracy metrics

### Incident Priority Calculation

- ✅ Automated priority calculation using ITIL matrix
- ✅ Impact assessment based on business criticality and user count
- ✅ Urgency assessment based on operational status and SLA
- ✅ Business impact estimation (users, revenue, downtime cost)
- ✅ Escalation requirements
- ✅ Recommended response team assignment

### Change Risk Assessment

- ✅ Multi-factor risk scoring (business criticality, complexity, history, window, dependencies)
- ✅ Risk level determination (low, medium, high, very_high)
- ✅ CAB approval requirement calculation
- ✅ Business and financial impact analysis
- ✅ Mitigation strategy recommendations
- ✅ Optimal change window validation

### Baseline Management

- ✅ Configuration baseline creation
- ✅ Drift detection and comparison
- ✅ Severity and compliance scoring
- ✅ CI restoration from baseline
- ✅ Baseline approval workflows

## Installation

```bash
npm install @cmdb/itil-service-manager
```

## Usage Examples

### Configuration Management

```typescript
import { ConfigurationManagementService } from '@cmdb/itil-service-manager';

// Initialize service
const configService = new ConfigurationManagementService();
await configService.connect();

// Update CI lifecycle stage
const updatedCI = await configService.updateLifecycleStage(
  'ci-web-001',
  'operate',
  'john@example.com',
  'Promoted to production'
);

// Schedule audit
await configService.scheduleAudit(
  'ci-web-001',
  new Date('2025-12-01'),
  'audit-team@example.com'
);

// Complete audit
const auditResult = await configService.completeAudit(
  'ci-web-001',
  'compliant',
  'auditor@example.com',
  ['All checks passed'],
  ['Continue monthly audits']
);

// Get configuration accuracy metrics
const metrics = await configService.getConfigurationAccuracy();
console.log(`Configuration accuracy: ${metrics.accuracyPercentage}%`);
console.log(`Compliance rate: ${metrics.compliancePercentage}%`);

// Promote CI to production (validates readiness)
const productionCI = await configService.promoteToProduction(
  'ci-web-001',
  'ops-team@example.com'
);
```

### Incident Priority Calculation

```typescript
import { IncidentPriorityService } from '@cmdb/itil-service-manager';

// Initialize service
const incidentService = new IncidentPriorityService();

// Create incident input
const incidentInput = {
  affectedCIId: 'ci-web-001',
  title: 'Web application unavailable',
  description: 'Users unable to access customer portal',
  reportedBy: 'user@example.com',
  category: 'availability',
  subcategory: 'downtime',
  symptoms: ['HTTP 503 errors', 'Connection timeouts'],
};

// Calculate priority automatically
const priority = await incidentService.calculatePriority(incidentInput);

console.log(`Priority: P${priority.priority}`);
console.log(`Impact: ${priority.impact}`);
console.log(`Urgency: ${priority.urgency}`);
console.log(`Estimated users affected: ${priority.estimatedUserImpact}`);
console.log(`Estimated revenue at risk: $${priority.estimatedRevenueImpact}`);
console.log(`Requires escalation: ${priority.requiresEscalation}`);
console.log(`Response team: ${priority.recommendedResponseTeam.join(', ')}`);

// Create incident with calculated priority
const incident = await incidentService.createIncident(incidentInput);
console.log(`Incident created: ${incident.incidentNumber}`);
```

### Priority Matrix

The ITIL standard priority matrix used for incident calculation:

| Impact / Urgency | Critical | High | Medium | Low |
|------------------|----------|------|--------|-----|
| **Critical**     | P1       | P1   | P2     | P3  |
| **High**         | P1       | P2   | P2     | P3  |
| **Medium**       | P2       | P3   | P3     | P4  |
| **Low**          | P3       | P4   | P4     | P5  |

### Change Risk Assessment

```typescript
import { ChangeRiskService } from '@cmdb/itil-service-manager';

// Initialize service
const changeService = new ChangeRiskService();

// Create change request
const changeRequest = {
  affectedCIIds: ['ci-web-001', 'ci-db-001'],
  title: 'Upgrade database to version 15',
  description: 'Upgrade PostgreSQL from 14 to 15',
  changeType: 'normal' as const,
  category: 'upgrade',
  plannedStart: new Date('2025-12-01T02:00:00Z'),
  plannedEnd: new Date('2025-12-01T06:00:00Z'),
  implementationPlan: 'Detailed implementation steps...',
  backoutPlan: 'Rollback to version 14 snapshot',
  testPlan: 'Run regression tests in staging',
  requestedBy: 'dba@example.com',
};

// Assess risk automatically
const riskAssessment = await changeService.assessChangeRisk(changeRequest);

console.log(`Risk Score: ${riskAssessment.overallRiskScore}/100`);
console.log(`Risk Level: ${riskAssessment.riskLevel}`);
console.log(`Requires CAB Approval: ${riskAssessment.requiresCABApproval}`);
console.log(`Estimated Downtime: ${riskAssessment.estimatedDowntime} minutes`);
console.log(`User Impact: ${riskAssessment.estimatedUserImpact} users`);
console.log(`Revenue at Risk: $${riskAssessment.estimatedRevenueAtRisk}`);
console.log(`Total Cost: $${riskAssessment.totalCost}`);

console.log('\nMitigation Strategies:');
riskAssessment.mitigationStrategies.forEach((strategy, i) => {
  console.log(`  ${i + 1}. ${strategy}`);
});

console.log('\nRecommendations:');
riskAssessment.recommendations.forEach((rec, i) => {
  console.log(`  ${i + 1}. ${rec}`);
});

// Create change with risk assessment
const change = await changeService.createChange(changeRequest);
console.log(`Change created: ${change.changeNumber}`);
```

### Baseline Management

```typescript
import { BaselineService } from '@cmdb/itil-service-manager';

// Initialize service
const baselineService = new BaselineService();

// Create configuration baseline
const baseline = await baselineService.createBaseline(
  'Production Q4 2025',
  ['ci-web-001', 'ci-db-001', 'ci-lb-001'],
  'Quarterly production configuration baseline',
  'configuration',
  'admin@example.com'
);

console.log(`Baseline created: ${baseline.name}`);

// Compare current state to baseline (detect drift)
const comparison = await baselineService.compareToBaseline(baseline.id);

console.log(`Total CIs: ${baseline.scope.ciIds.length}`);
console.log(`Drifted CIs: ${comparison.totalDriftCount}`);
console.log(`Drift Percentage: ${comparison.driftPercentage.toFixed(2)}%`);
console.log(`Compliance Score: ${comparison.complianceScore.toFixed(2)}%`);

// Review drifted CIs
if (comparison.driftedCIs.length > 0) {
  console.log('\nConfiguration Drift Detected:');
  comparison.driftedCIs.forEach((drift) => {
    console.log(`\n  CI: ${drift.ciName} (${drift.ciId})`);
    console.log(`  Severity: ${drift.severity}`);
    console.log(`  Changes:`);
    drift.changedAttributes.forEach((change) => {
      console.log(`    - ${change.attribute}:`);
      console.log(`      Baseline: ${JSON.stringify(change.baselineValue)}`);
      console.log(`      Current:  ${JSON.stringify(change.currentValue)}`);
    });
  });
}

// Restore CI from baseline
const restoredCI = await baselineService.restoreFromBaseline(
  'ci-web-001',
  baseline.id,
  'admin@example.com'
);

// Approve baseline
const approvedBaseline = await baselineService.approveBaseline(
  baseline.id,
  'manager@example.com'
);

// Get compliance summary across all baselines
const summary = await baselineService.getComplianceSummary();
console.log(`\nCompliance Summary:`);
console.log(`  Total Baselines: ${summary.totalBaselines}`);
console.log(`  Compliant CIs: ${summary.compliantCIs}`);
console.log(`  Drifted CIs: ${summary.driftedCIs}`);
console.log(`  Average Compliance: ${summary.averageComplianceScore.toFixed(2)}%`);
```

### Utility Classes

#### Priority Calculator

```typescript
import { PriorityCalculator } from '@cmdb/itil-service-manager';

// Calculate priority from impact and urgency
const priority = PriorityCalculator.calculatePriority('critical', 'high');
console.log(`Priority: P${priority}`); // P1

// Calculate impact
const impact = PriorityCalculator.calculateImpact('tier_1', 5000, true);
console.log(`Impact: ${impact}`); // critical

// Check if escalation required
const needsEscalation = PriorityCalculator.requiresEscalation(1);
console.log(`Escalation required: ${needsEscalation}`); // true

// Get response time SLA
const responseTime = PriorityCalculator.getRecommendedResponseTime(1);
console.log(`Response time: ${responseTime} minutes`); // 15 minutes
```

#### Risk Assessor

```typescript
import { RiskAssessor } from '@cmdb/itil-service-manager';

// Calculate risk factors
const riskFactors = {
  businessCriticalityScore: 90,
  complexityScore: 60,
  historicalRiskScore: 40,
  changeWindowScore: 30,
  dependencyScore: 50,
};

// Calculate overall risk
const riskScore = RiskAssessor.calculateOverallRiskScore(riskFactors);
const riskLevel = RiskAssessor.determineRiskLevel(riskScore);

console.log(`Risk Score: ${riskScore}/100`);
console.log(`Risk Level: ${riskLevel}`);

// Check if CAB approval required
const requiresCAB = RiskAssessor.requiresCABApproval(riskLevel, 'major', 50000);
console.log(`Requires CAB: ${requiresCAB}`);
```

#### Lifecycle Manager

```typescript
import { LifecycleManager } from '@cmdb/itil-service-manager';

// Validate lifecycle transition
const isValid = LifecycleManager.isValidLifecycleTransition('build', 'test');
console.log(`Valid transition: ${isValid}`); // true

// Get valid next stages
const nextStages = LifecycleManager.getValidNextLifecycleStages('build');
console.log(`Next stages: ${nextStages.join(', ')}`); // test, design, retire

// Check if CI is in production
const inProduction = LifecycleManager.isInProduction('operate', 'active');
console.log(`In production: ${inProduction}`); // true

// Get recommended audit frequency
const auditFrequency = LifecycleManager.getRecommendedAuditFrequency('operate', 'tier_1');
console.log(`Audit every ${auditFrequency} days`); // 45 days
```

## Architecture

### Service Layer
- `ConfigurationManagementService`: CI lifecycle and audit management
- `IncidentPriorityService`: Automated incident priority calculation
- `ChangeRiskService`: Change risk assessment and approval
- `BaselineService`: Configuration baseline and drift management

### Repository Layer
- `CIRepository`: Configuration Item database access
- `IncidentRepository`: Incident database access
- `ChangeRepository`: Change database access
- `BaselineRepository`: Baseline database access
- `BusinessServiceRepository`: Business Service database access

### Utility Layer
- `PriorityCalculator`: ITIL priority matrix calculations
- `RiskAssessor`: Multi-factor risk assessment
- `LifecycleManager`: Lifecycle transition validation

## Integration

### Database
- **Neo4j**: Primary CI and relationship storage
- **PostgreSQL**: ITIL records (incidents, changes, baselines)

### Event Streaming
- Publishes events for all ITIL operations via `@cmdb/event-streaming`
- Event types: `ci.updated`, `incident.created`, `change.created`

## Testing

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests only
npm run test:integration

# Run with coverage
npm run test:coverage
```

## Configuration

No configuration required. The package uses singleton database clients from `@cmdb/database` which are configured via environment variables.

## License

MIT

## Contributing

Contributions welcome! Please follow the HappyCMDB contribution guidelines.
