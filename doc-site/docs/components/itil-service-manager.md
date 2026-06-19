# ITIL Service Manager

**Package**: `@cmdb/itil-service-manager`
**Version**: v3.0+
**Framework**: ITIL v4

The ITIL Service Manager provides comprehensive IT Service Management capabilities aligned with ITIL v4 best practices.

## Overview

HappyCMDB v3.0 implements ITIL v4 service management with automated incident priority calculation, change risk assessment, configuration management, and baseline tracking.

### Key Features

- **Incident Management**: Automated priority calculation using Impact × Urgency matrix
- **Change Management**: 5-factor risk assessment with CAB approval workflow
- **Configuration Management**: CI lifecycle tracking and audit compliance
- **Baseline Management**: Configuration drift detection and remediation

---

## Incident Priority Calculation

### Priority Matrix

ITIL priority is calculated using the **Impact × Urgency** matrix:

| Impact ↓ / Urgency → | Critical | High | Medium | Low |
|----------------------|----------|------|--------|-----|
| **Critical** | P1 | P1 | P2 | P3 |
| **High** | P1 | P2 | P3 | P4 |
| **Medium** | P2 | P3 | P4 | P5 |
| **Low** | P3 | P4 | P5 | P5 |

### Impact Levels

Determined by **Business Criticality** of affected CI:

- **Critical**: Tier 0 services (mission-critical, >$1M revenue)
- **High**: Tier 1 services (business-critical, $500K-$1M revenue)
- **Medium**: Tier 2 services (important, $100K-$500K revenue)
- **Low**: Tier 3-4 services (standard/low priority)

### Urgency Levels

Determined by **Operational Impact**:

- **Critical**: Complete service outage, all users affected
- **High**: Significant degradation, >50% users affected
- **Medium**: Partial degradation, 10-50% users affected
- **Low**: Minor issues, <10% users affected

### Usage Example

```typescript
import { getIncidentPriorityService } from '@cmdb/itil-service-manager';

const priorityService = getIncidentPriorityService();

const priority = await priorityService.calculatePriority({
  affectedCIId: 'ci-db-crm-001',
  affectedUserCount: 5000,
  totalUserCount: 10000,
  operationalStatus: 'down'
});

console.log(priority);
// {
//   priority: 1,
//   impact: 'critical',
//   urgency: 'high',
//   affectedBusinessServices: ['bs-crm'],
//   estimatedUserImpact: 5000,
//   estimatedRevenueImpact: 50000,
//   responseTeam: 'Tier 0 Response Team',
//   slaTarget: {
//     responseMinutes: 15,
//     resolutionMinutes: 240
//   }
// }
```

---

## Change Risk Assessment

### 5-Factor Risk Scoring

Change risk is calculated using 5 weighted factors:

1. **Criticality** (30%): Business criticality of target CI
2. **Complexity** (25%): Technical complexity (simple/moderate/complex/very complex)
3. **History** (20%): Past change success rate on this CI
4. **Window** (15%): Change window (standard/after-hours/emergency)
5. **Dependencies** (10%): Number of dependent CIs

### Risk Score Calculation

```
riskScore = (criticality × 0.30) + (complexity × 0.25) +
            (history × 0.20) + (window × 0.15) + (dependencies × 0.10)

Scale: 0-100 (higher = riskier)
```

### Risk Levels

- **Low**: 0-25 (Standard approval)
- **Medium**: 26-50 (Manager approval)
- **High**: 51-75 (CAB approval required)
- **Critical**: 76-100 (CAB + Executive approval required)

### Usage Example

```typescript
import { getChangeRiskService } from '@cmdb/itil-service-manager';

const riskService = getChangeRiskService();

const assessment = await riskService.assessChangeRisk({
  targetCIId: 'ci-db-crm-001',
  changeType: 'major',
  complexity: 'complex',
  scheduledWindow: 'standard',
  estimatedDuration: 2 // hours
});

console.log(assessment);
// {
//   riskScore: 72,
//   riskLevel: 'high',
//   requiresCABApproval: true,
//   requiresExecutiveApproval: false,
//   factors: {
//     criticality: 27,  // Tier 0 CI
//     complexity: 18.75, // Complex change
//     history: 16,      // 80% success rate
//     window: 11.25,    // Standard window
//     dependencies: 0   // 0 dependencies
//   },
//   recommendations: [
//     'Schedule during low-traffic window',
//     'Prepare rollback plan',
//     'Notify stakeholders 24h in advance',
//     'Ensure backup is current'
//   ]
// }
```

---

## Configuration Management

### CI Lifecycle Stages

ITIL CI lifecycle follows these stages:

1. **Plan**: CI is being planned
2. **Order**: CI has been ordered
3. **Build**: CI is being built/configured
4. **Test**: CI is in testing
5. **Deploy**: CI is being deployed
6. **Operate**: CI is in production (most CIs)
7. **Retire**: CI is being decommissioned
8. **Disposed**: CI has been disposed

### Configuration Status

- **Active**: CI is operational
- **Inactive**: CI is not operational
- **Maintenance**: CI is under maintenance
- **Decommissioned**: CI has been retired

### Audit Status

- **Compliant**: CI configuration matches baseline
- **Non-Compliant**: CI has drifted from baseline
- **Unknown**: CI has not been audited

### Usage Example

```typescript
import { getConfigurationManagementService } from '@cmdb/itil-service-manager';

const cmService = getConfigurationManagementService();

// Update CI lifecycle stage
await cmService.updateLifecycleStage('ci-001', 'operate');

// Record audit
await cmService.recordAudit('ci-001', {
  auditor: 'system',
  auditDate: new Date(),
  auditStatus: 'compliant',
  findings: []
});

// Get CI configuration history
const history = await cmService.getConfigurationHistory('ci-001');
```

---

## Baseline Management

### Baseline Types

- **Configuration Baseline**: CI attributes and settings
- **Performance Baseline**: Performance metrics (CPU, memory, disk)
- **Security Baseline**: Security configuration and patches

### Drift Detection

HappyCMDB automatically detects configuration drift:

```typescript
import { getBaselineService } from '@cmdb/itil-service-manager';

const baselineService = getBaselineService();

// Create baseline
const baseline = await baselineService.createBaseline({
  name: 'CRM Database Production Baseline',
  ciId: 'ci-db-crm-001',
  description: 'Standard PostgreSQL configuration',
  attributes: {
    version: '15.3',
    max_connections: 200,
    shared_buffers: '2GB',
    effective_cache_size: '6GB'
  }
});

// Compare to baseline
const comparison = await baselineService.compareToBaseline('ci-db-crm-001', baseline.id);

console.log(comparison);
// {
//   hasDrift: true,
//   driftSeverity: 'medium',
//   differences: [
//     {
//       attribute: 'max_connections',
//       baseline: 200,
//       current: 150,
//       severity: 'medium',
//       recommendation: 'Increase to baseline value'
//     }
//   ]
// }
```

---

## REST API

### Incident Endpoints

```http
POST   /api/v1/itil/incidents
GET    /api/v1/itil/incidents/:id
GET    /api/v1/itil/incidents/:id/priority
PUT    /api/v1/itil/incidents/:id
DELETE /api/v1/itil/incidents/:id
```

### Change Endpoints

```http
POST   /api/v1/itil/changes
GET    /api/v1/itil/changes/:id
GET    /api/v1/itil/changes/:id/risk-assessment
PUT    /api/v1/itil/changes/:id
DELETE /api/v1/itil/changes/:id
```

### Configuration Endpoints

```http
GET    /api/v1/itil/configuration-items
GET    /api/v1/itil/configuration-items/:id
PUT    /api/v1/itil/configuration-items/:id/lifecycle
POST   /api/v1/itil/configuration-items/:id/audit
```

### Baseline Endpoints

```http
GET    /api/v1/itil/baselines
POST   /api/v1/itil/baselines
GET    /api/v1/itil/baselines/:id
GET    /api/v1/itil/baselines/:id/comparison
```

---

## GraphQL API

### Queries

```graphql
query {
  # Get incident with priority
  incident(id: "inc-001") {
    id
    priority
    impact
    urgency
    affectedCI {
      id
      name
    }
    estimatedRevenueImpact
  }

  # Get change risk assessment
  changeRiskAssessment(changeId: "chg-001") {
    riskScore
    riskLevel
    requiresCABApproval
    factors {
      criticality
      complexity
      history
      window
      dependencies
    }
  }

  # Get CI with ITIL attributes
  configurationItem(id: "ci-001") {
    id
    name
    itilAttributes {
      ciClass
      lifecycleStage
      configurationStatus
      auditStatus
      lastAudited
    }
  }
}
```

### Mutations

```graphql
mutation {
  # Create incident
  createIncident(input: {
    title: "CRM Database Outage"
    affectedCIId: "ci-db-crm-001"
    affectedUserCount: 5000
    totalUserCount: 10000
    operationalStatus: "down"
  }) {
    id
    priority
    impact
    urgency
  }

  # Create change request
  createChange(input: {
    title: "Upgrade CRM Database"
    targetCIId: "ci-db-crm-001"
    changeType: "major"
    complexity: "complex"
    scheduledWindow: "after-hours"
  }) {
    id
    riskScore
    riskLevel
    requiresCABApproval
  }
}
```

---

## Integration with BSM

ITIL Service Manager integrates with BSM Impact Engine to enrich incidents and changes with business impact:

```typescript
import { UnifiedServiceInterface } from '@cmdb/framework-integration';

const unified = new UnifiedServiceInterface();

// Create enriched incident (ITIL + BSM)
const incident = await unified.createEnrichedIncident({
  title: "CRM Database Outage",
  affectedCIId: "ci-db-crm-001",
  estimatedDuration: 2
});

// Includes ITIL priority + business impact + downtime cost
console.log(incident.itilPriority.priority);  // 1 (P1)
console.log(incident.businessImpact.revenueAtRisk); // $2.5M
console.log(incident.downtimeCost); // $10,416/hour
```

---

## SLA Targets

### Response Time Targets

| Priority | Response Time | Resolution Time |
|----------|---------------|-----------------|
| **P1** | 15 minutes | 4 hours |
| **P2** | 30 minutes | 8 hours |
| **P3** | 2 hours | 24 hours |
| **P4** | 4 hours | 48 hours |
| **P5** | 8 hours | 5 business days |

### Change Windows

- **Standard**: Business hours (Mon-Fri, 9am-5pm)
- **After-Hours**: Evenings/weekends (lower risk)
- **Emergency**: Immediate (highest risk)

---

## Best Practices

### Incident Management

1. **Always calculate priority automatically** - Don't rely on manual assessment
2. **Link incidents to CIs** - Essential for business impact analysis
3. **Track affected user count** - Determines urgency level
4. **Estimate downtime** - Critical for revenue impact calculation

### Change Management

1. **Assess risk before approval** - Use 5-factor risk scoring
2. **Require CAB for high-risk changes** - Tier 0/1 CIs with risk >50
3. **Schedule during low-traffic windows** - Minimize business impact
4. **Always have a rollback plan** - Test rollback before change

### Configuration Management

1. **Audit Tier 0/1 CIs monthly** - Ensure compliance
2. **Create baselines for all production CIs** - Enable drift detection
3. **Track CI lifecycle accurately** - Essential for asset management
4. **Record all configuration changes** - Audit trail for compliance

---

## Performance Metrics

- **Incident priority calculation**: <100ms
- **Change risk assessment**: <200ms
- **Baseline comparison**: <500ms (per CI)
- **Configuration history query**: <1 second (100 changes)

---

## Related Documentation

- [BSM Impact Engine](/components/bsm-impact-engine) - Business impact scoring
- [TBM Cost Engine](/components/tbm-cost-engine) - Cost allocation
- [Framework Integration](/components/framework-integration) - Unified ITIL+TBM+BSM interface
- [Dashboards](/components/dashboards) - ITSM Dashboard for IT Service Managers
