# AI/ML Engine

## Overview

The HappyCMDB AI/ML Engine provides intelligent automation for CMDB operations through three integrated machine learning engines. These engines analyze CI behavior patterns, detect configuration drift, and predict change impacts to enable proactive IT operations management.

**Key Capabilities**:
- **Anomaly Detection** - Statistical analysis of CI change patterns, relationships, and configurations
- **Configuration Drift Detection** - Baseline tracking and drift analysis with field-level granularity
- **Impact Prediction** - Dependency graph analysis for change risk assessment and blast radius calculation

The AI/ML Engine integrates with HappyCMDB's event streaming infrastructure (Kafka) to provide real-time analysis and automated remediation workflows.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    AI/ML Engine                                 │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │  Anomaly         │  │  Drift           │  │  Impact      │  │
│  │  Detection       │  │  Detection       │  │  Prediction  │  │
│  │  Engine          │  │  Engine          │  │  Engine      │  │
│  │                  │  │                  │  │              │  │
│  │  - Change freq   │  │  - Baselines     │  │  - Blast     │  │
│  │  - Relationships │  │  - Drift score   │  │    radius    │  │
│  │  - Configuration │  │  - Remediation   │  │  - Critical  │  │
│  │  - Performance   │  │    workflows     │  │    path      │  │
│  └─────────┬────────┘  └────────┬─────────┘  └──────┬───────┘  │
│            │                    │                    │          │
└────────────┼────────────────────┼────────────────────┼──────────┘
             │                    │                    │
             ▼                    ▼                    ▼
┌────────────────────────────────────────────────────────────────┐
│              Event Streaming (Kafka)                           │
│  Topics: ci.discovered, ci.updated, ci.changes                 │
└────────────┬───────────────────────────────────────────────────┘
             │
             ▼
┌────────────────────────────────────────────────────────────────┐
│              Data Storage                                      │
│  - PostgreSQL: Anomalies, baselines, drift results            │
│  - Neo4j: CI graph, dependency analysis                       │
└────────────────────────────────────────────────────────────────┘
```

## Anomaly Detection Engine

The Anomaly Detection Engine uses statistical analysis and machine learning to identify unusual patterns in CI behavior.

### Anomaly Types

#### 1. Change Frequency Anomalies

Detects CIs with abnormal change rates using Z-score statistical analysis:

- **Excessive Changes** - CIs changing significantly more than peers
- **Unusual Change Patterns** - Irregular change timing or frequency
- **Unexpected Downtime** - Unplanned service interruptions

**Algorithm**: Z-score approach with configurable sensitivity
```
z_score = (actual_changes - mean_changes) / standard_deviation
anomaly_detected = z_score > threshold
```

**Statistical Thresholds**:
- **Low Sensitivity**: Z-score > 2.5 (fewer anomalies)
- **Medium Sensitivity**: Z-score > 2.0 (default)
- **High Sensitivity**: Z-score > 1.5 (more anomalies)

**Example Detection**:
```typescript
// CI with 45 changes when average is 10
// Z-score = (45 - 10) / 8 = 4.375
// Severity: CRITICAL (Z > 4)
// Confidence: 95%
```

#### 2. Relationship Anomalies

Identifies unusual relationship patterns in the CI dependency graph:

- **Orphaned CIs** - CIs with no relationships (potentially stale)
- **Unusual Dependency Count** - CIs with excessive dependencies (>50)
- **Circular Dependencies** - Dependency cycles that may cause issues

**Detection Criteria**:
- Orphaned CIs: No incoming/outgoing relationships for 7+ days
- High dependency count: More than 50 outgoing relationships
- Circular dependencies: Cypher query detecting cycles of length 2-5

#### 3. Configuration Anomalies

Detects configuration issues and policy violations:

- **Missing Required Attributes** - Critical fields not populated (e.g., `ip_address`, `hostname`)
- **Configuration Drift** - Unauthorized changes from approved baseline
- **Unauthorized Changes** - Changes without proper approval workflow

#### 4. Performance Anomalies

Identifies performance degradation patterns:

- **Degraded Performance** - Metrics below historical baselines
- **Resource Exhaustion** - CPU, memory, disk, or network saturation

### Severity Classification

Anomalies are classified into five severity levels:

| Severity | Z-Score Range | Description | Example |
|----------|---------------|-------------|---------|
| **CRITICAL** | > 4.0 | Extreme deviation requiring immediate action | 10x normal change rate |
| **HIGH** | 3.0 - 4.0 | Significant deviation requiring urgent review | 5x normal change rate |
| **MEDIUM** | 2.0 - 3.0 | Moderate deviation requiring investigation | 3x normal change rate |
| **LOW** | 1.5 - 2.0 | Minor deviation for awareness | 2x normal change rate |
| **INFO** | < 1.5 | Informational only | Minor variations |

### Configuration

```typescript
interface AnomalyDetectionConfig {
  enabled: boolean;
  sensitivity: 'low' | 'medium' | 'high';
  min_confidence_score: number; // 0-100
  check_interval_minutes: number;
  lookback_days: number;
  notification_enabled: boolean;
}
```

**Default Configuration**:
```json
{
  "enabled": true,
  "sensitivity": "medium",
  "min_confidence_score": 70,
  "check_interval_minutes": 60,
  "lookback_days": 30,
  "notification_enabled": true
}
```

**Configuration Storage**: Stored in PostgreSQL `system_config` table with key `anomaly_detection`

### API Usage

#### Retrieve Anomalies for a CI

```typescript
import { getAnomalyDetectionEngine } from '@cmdb/ai-ml-engine';

const engine = getAnomalyDetectionEngine();

// Get anomalies for specific CI
const anomalies = await engine.getAnomaliesForCI('ci-12345', 50);

anomalies.forEach(anomaly => {
  console.log(`[${anomaly.severity}] ${anomaly.anomaly_type}`);
  console.log(`  Confidence: ${anomaly.confidence_score}%`);
  console.log(`  Description: ${anomaly.description}`);
  console.log(`  Metrics:`, anomaly.metrics);
});
```

**Response Example**:
```json
{
  "id": "anom-7890",
  "ci_id": "ci-12345",
  "ci_name": "prod-web-server-01",
  "anomaly_type": "excessive_changes",
  "severity": "high",
  "confidence_score": 92,
  "detected_at": "2025-11-06T10:30:00Z",
  "description": "CI has 45 changes (437% above normal)",
  "metrics": {
    "actual_value": 45,
    "expected_value": 10.2,
    "deviation_percentage": 341,
    "historical_average": 10.2,
    "standard_deviation": 8.1
  },
  "context": {
    "lookback_days": 30,
    "z_score": 4.29
  },
  "status": "detected"
}
```

#### Get Recent Anomalies Across All CIs

```typescript
// Get anomalies detected in last 24 hours
const recentAnomalies = await engine.getRecentAnomalies(24, 100);

// Group by severity
const grouped = recentAnomalies.reduce((acc, anom) => {
  acc[anom.severity] = (acc[anom.severity] || 0) + 1;
  return acc;
}, {});

console.log('Anomalies by severity:', grouped);
// Output: { critical: 3, high: 12, medium: 28, low: 15 }
```

#### Run Manual Anomaly Detection

```typescript
// Trigger on-demand scan
const detectedAnomalies = await engine.detectAnomalies();

console.log(`Detected ${detectedAnomalies.length} anomalies`);
```

### Event Integration

High-severity anomalies (CRITICAL and HIGH) automatically emit Kafka events:

```typescript
// Event emitted for CRITICAL/HIGH anomalies
{
  "event_type": "anomaly_detected",
  "source": "anomaly-detection-engine",
  "payload": {
    "conflict_id": "anom-7890",
    "conflict_type": "anomaly_detected",
    "source_data": {
      "anomaly_type": "excessive_changes",
      "severity": "critical",
      "confidence": 95
    }
  }
}
```

**Consumer Integration**:
```typescript
consumer.on('anomaly_detected', async (event) => {
  // Create ServiceNow incident for critical anomalies
  if (event.payload.severity === 'critical') {
    await createIncident({
      title: `Critical anomaly detected: ${event.payload.ci_name}`,
      urgency: 1,
      impact: 1
    });
  }
});
```

---

## Configuration Drift Detector

The Configuration Drift Detector tracks changes to CI configurations by comparing current state against approved baselines.

### Baseline Snapshots

Three types of baselines can be captured:

#### 1. Configuration Baselines

Captures all CI properties (excluding system fields):

```typescript
{
  "snapshot_type": "configuration",
  "snapshot_data": {
    "hostname": "prod-web-01",
    "ip_address": "10.0.1.50",
    "os_type": "linux",
    "os_version": "Ubuntu 22.04",
    "cpu_cores": 8,
    "memory_gb": 32,
    "environment": "production",
    "department": "engineering",
    "tags": ["web", "critical", "public-facing"]
  }
}
```

**Excluded System Fields**: `id`, `created_at`, `updated_at`, `last_seen_at`

#### 2. Performance Baselines

Captures 24-hour metric averages and maximums:

```typescript
{
  "snapshot_type": "performance",
  "snapshot_data": {
    "cpu_utilization": { "average": 45.2, "max": 78.5 },
    "memory_utilization": { "average": 62.1, "max": 88.3 },
    "disk_io_read_mbps": { "average": 120.5, "max": 450.2 },
    "disk_io_write_mbps": { "average": 85.3, "max": 320.1 },
    "network_rx_mbps": { "average": 220.4, "max": 850.3 },
    "network_tx_mbps": { "average": 180.2, "max": 720.5 }
  }
}
```

#### 3. Relationship Baselines

Captures all CI relationships (dependencies and dependents):

```typescript
{
  "snapshot_type": "relationships",
  "snapshot_data": {
    "outgoing": [
      {
        "type": "DEPENDS_ON",
        "ci_id": "db-prod-01",
        "ci_name": "Production PostgreSQL"
      },
      {
        "type": "USES",
        "ci_id": "redis-cache-01",
        "ci_name": "Redis Cache Cluster"
      }
    ],
    "incoming": [
      {
        "type": "HOSTED_ON",
        "ci_id": "vm-host-03",
        "ci_name": "VMware ESXi Host 03"
      }
    ]
  }
}
```

### Drift Detection Algorithm

The drift detector compares current state against approved baseline using field-level analysis:

**Change Types**:
- **Added** - Field exists in current but not in baseline
- **Removed** - Field exists in baseline but not in current
- **Modified** - Field exists in both but value changed

**Drift Severity Assessment**:

| Field Category | Change Type | Severity |
|----------------|-------------|----------|
| Critical fields (`ip_address`, `hostname`, `status`, `environment`) | Removed | CRITICAL |
| Critical fields | Modified | HIGH |
| High priority (`version`, `port`, `credentials`) | Any | HIGH |
| Medium priority (`config`, `setting`, `parameter`) | Any | MEDIUM |
| Other fields | Any | LOW |

**Drift Score Calculation** (0-100):
```
drift_score = sum(severity_weights for all drifted_fields)
severity_weights = {
  CRITICAL: 40,
  HIGH: 25,
  MEDIUM: 15,
  LOW: 10,
  INFO: 5
}
```

### Auto-Baseline Workflow

HappyCMDB automatically creates baselines for newly discovered CIs:

```typescript
// Triggered on ci.discovered event
consumer.on('ci.discovered', async (event) => {
  // Create configuration baseline automatically
  await driftDetector.createBaseline(
    event.ci_id,
    'configuration',
    'auto-baseline'
  );
});
```

**Baseline Approval Workflow**:
1. System creates baseline (status: `is_approved = false`)
2. CAB reviews baseline snapshot
3. CAB approves baseline → `is_approved = true`
4. Drift detection uses only approved baselines

### API Usage

#### Create Configuration Baseline

```typescript
import { getConfigurationDriftDetector } from '@cmdb/ai-ml-engine';

const driftDetector = getConfigurationDriftDetector();

// Create configuration baseline
const baseline = await driftDetector.createBaseline(
  'ci-12345',
  'configuration',
  'admin@company.com'
);

console.log('Baseline created:', baseline.id);
console.log('Approved:', baseline.is_approved);
```

**Response**:
```json
{
  "id": "baseline-abc123",
  "ci_id": "ci-12345",
  "snapshot_type": "configuration",
  "snapshot_data": { /* CI properties */ },
  "created_at": "2025-11-06T10:00:00Z",
  "created_by": "admin@company.com",
  "is_approved": false
}
```

#### Approve Baseline

```typescript
// CAB approves baseline
const approvedBaseline = await driftDetector.approveBaseline(
  'baseline-abc123',
  'cab-approver@company.com'
);

console.log('Approved by:', approvedBaseline.approved_by);
console.log('Approved at:', approvedBaseline.approved_at);
```

#### Detect Configuration Drift

```typescript
// Detect drift against approved baseline
const driftResult = await driftDetector.detectDrift('ci-12345');

if (driftResult.has_drift) {
  console.log(`Drift Score: ${driftResult.drift_score}/100`);
  console.log(`Drifted Fields: ${driftResult.drifted_fields.length}`);

  driftResult.drifted_fields.forEach(field => {
    console.log(`  [${field.severity}] ${field.field_name}`);
    console.log(`    Change: ${field.change_type}`);
    console.log(`    Baseline: ${field.baseline_value}`);
    console.log(`    Current: ${field.current_value}`);
  });
}
```

**Drift Result Example**:
```json
{
  "ci_id": "ci-12345",
  "ci_name": "prod-web-server-01",
  "has_drift": true,
  "drift_score": 65,
  "baseline_snapshot_id": "baseline-abc123",
  "detected_at": "2025-11-06T14:30:00Z",
  "drifted_fields": [
    {
      "field_name": "os_version",
      "baseline_value": "Ubuntu 22.04",
      "current_value": "Ubuntu 22.04.3",
      "change_type": "modified",
      "severity": "high"
    },
    {
      "field_name": "cpu_cores",
      "baseline_value": 8,
      "current_value": 16,
      "change_type": "modified",
      "severity": "medium"
    },
    {
      "field_name": "backup_enabled",
      "baseline_value": null,
      "current_value": true,
      "change_type": "added",
      "severity": "low"
    }
  ]
}
```

#### Get Drift History

```typescript
// Get drift detection history for a CI
const history = await driftDetector.getDriftHistory('ci-12345', 50);

history.forEach(result => {
  console.log(`${result.detected_at}: Drift Score ${result.drift_score}`);
});
```

### Remediation Workflows

When drift is detected (score > 30), a Kafka event is emitted for automated remediation:

```typescript
// Event emitted for significant drift
{
  "event_type": "configuration_drift",
  "source": "configuration-drift-detector",
  "payload": {
    "ci_id": "ci-12345",
    "drift_score": 65,
    "drifted_fields": 3
  }
}
```

**Automated Remediation Actions**:
1. **Create change ticket** for review
2. **Alert infrastructure team** via PagerDuty/Slack
3. **Auto-remediate** low-risk drift (if configured)
4. **Update baseline** if drift is intentional

---

## Impact Prediction Engine

The Impact Prediction Engine analyzes the dependency graph to predict the impact of changes on downstream CIs.

### Change Impact Analysis

When planning a change to a CI, the impact engine:
1. Finds all affected CIs (downstream dependencies)
2. Calculates blast radius (number of affected CIs)
3. Identifies critical path (longest dependency chain)
4. Scores impact based on criticality and change type
5. Determines risk level and estimated downtime

### Blast Radius Calculation

The engine traverses the Neo4j dependency graph to find all CIs that depend on the source CI:

```cypher
MATCH path = (source:CI {id: $ciId})<-[*1..5]-(dependent:CI)
WHERE ALL(r IN relationships(path)
  WHERE type(r) IN ['DEPENDS_ON', 'USES', 'HOSTED_ON'])
RETURN dependent, length(path) as hop_count
```

**Hop Count Analysis**:
- **Hop 1** (Direct dependencies): 90% impact probability
- **Hop 2** (1 intermediary): 70% impact probability
- **Hop 3** (2 intermediaries): 50% impact probability
- **Hop 4+**: Exponential decay (10% minimum)

### Criticality Scoring

Each CI receives a criticality score (0-100) based on multiple factors:

```typescript
interface CriticalityFactors {
  dependent_count: number;      // How many CIs depend on this
  dependent_weight: number;      // Sum of dependent criticalities
  change_frequency: number;      // How often it changes
  failure_history: number;       // Historical failure rate
  business_impact: number;       // Business criticality (manual)
}
```

**Criticality Score Formula**:
```
criticality_score =
  (dependent_count × 10) +              // High impact if many depend on it
  (dependent_weight × 0.3) +            // Weighted contribution of dependents
  ((100 - change_frequency) × 0.2) +    // Stable CIs are more critical
  (business_impact × 0.5)               // Manual business importance
```

**Score Caching**: Criticality scores are cached for 7 days to improve performance

### Change Type Weighting

Different change types have different risk weights:

| Change Type | Risk Weight | Typical Downtime |
|-------------|-------------|------------------|
| **DECOMMISSION** | 2.0 | Variable (blast_radius × 10 min) |
| **VERSION_UPGRADE** | 1.5 | 30 min + (blast_radius × 5 min) |
| **NETWORK_CHANGE** | 1.3 | Not estimated |
| **SECURITY_CHANGE** | 1.3 | Not estimated |
| **RESTART** | 1.0 | 5 min + (blast_radius × 2 min) |
| **CONFIGURATION_CHANGE** | 0.8 | Not estimated |
| **PERFORMANCE_TUNING** | 0.8 | Not estimated |

### Impact Score Calculation

```
impact_score = (blast_radius × 2 + criticality) × change_type_weight × 0.5
```

### Risk Level Classification

| Risk Level | Conditions | Recommended Action |
|------------|-----------|-------------------|
| **CRITICAL** | Impact score > 80 OR blast radius > 50 | CAB approval required, maintenance window mandatory |
| **HIGH** | Impact score > 60 OR blast radius > 20 | CAB approval required, communication plan needed |
| **MEDIUM** | Impact score > 40 OR blast radius > 10 | Manager approval required, rollback plan needed |
| **LOW** | Impact score > 20 OR blast radius > 5 | Peer review sufficient |
| **MINIMAL** | Impact score ≤ 20 AND blast radius ≤ 5 | Standard change process |

### API Usage

#### Predict Change Impact

```typescript
import { getImpactPredictionEngine, ChangeType } from '@cmdb/ai-ml-engine';

const impactEngine = getImpactPredictionEngine();

// Predict impact of restarting a database server
const impact = await impactEngine.predictChangeImpact(
  'db-prod-01',
  ChangeType.RESTART
);

console.log('Impact Analysis:');
console.log(`  Impact Score: ${impact.impact_score}/100`);
console.log(`  Blast Radius: ${impact.blast_radius} CIs`);
console.log(`  Risk Level: ${impact.risk_level}`);
console.log(`  Est. Downtime: ${impact.estimated_downtime_minutes} min`);
console.log(`  Critical Path Length: ${impact.critical_path.length}`);

// List affected CIs
impact.affected_cis.forEach(affected => {
  console.log(`  - ${affected.ci_name} (${affected.impact_type})`);
  console.log(`    Impact Probability: ${affected.impact_probability}%`);
  console.log(`    Hop Count: ${affected.hop_count}`);
});
```

**Response Example**:
```json
{
  "id": "impact-xyz789",
  "source_ci_id": "db-prod-01",
  "source_ci_name": "Production PostgreSQL Database",
  "change_type": "restart",
  "impact_score": 72,
  "blast_radius": 28,
  "risk_level": "high",
  "estimated_downtime_minutes": 61,
  "critical_path": [
    "db-prod-01",
    "api-server-prod-01",
    "load-balancer-01",
    "cdn-edge-server-01"
  ],
  "affected_cis": [
    {
      "ci_id": "api-server-prod-01",
      "ci_name": "Production API Server 01",
      "ci_type": "application",
      "impact_type": "direct",
      "dependency_path": ["db-prod-01", "api-server-prod-01"],
      "hop_count": 1,
      "impact_probability": 90,
      "estimated_impact": "Direct dependency - immediate impact expected"
    },
    {
      "ci_id": "worker-queue-01",
      "ci_name": "Background Worker Queue",
      "ci_type": "application",
      "impact_type": "direct",
      "dependency_path": ["db-prod-01", "worker-queue-01"],
      "hop_count": 1,
      "impact_probability": 90,
      "estimated_impact": "Direct dependency - immediate impact expected"
    },
    {
      "ci_id": "web-frontend-01",
      "ci_name": "Web Frontend 01",
      "ci_type": "application",
      "impact_type": "indirect",
      "dependency_path": ["db-prod-01", "api-server-prod-01", "web-frontend-01"],
      "hop_count": 2,
      "impact_probability": 70,
      "estimated_impact": "Indirect impact through 1 intermediary"
    }
  ]
}
```

#### Get CI Criticality Score

```typescript
// Get or calculate criticality score
const criticality = await impactEngine.getCriticalityScore('db-prod-01');

console.log('Criticality Analysis:');
console.log(`  Score: ${criticality.criticality_score}/100`);
console.log(`  Dependent Count: ${criticality.factors.dependent_count}`);
console.log(`  Dependent Weight: ${criticality.factors.dependent_weight}`);
console.log(`  Change Frequency: ${criticality.factors.change_frequency}`);
console.log(`  Business Impact: ${criticality.factors.business_impact}`);
```

#### Build Dependency Graph for Visualization

```typescript
// Build dependency graph for visualization (max depth 3 hops)
const graph = await impactEngine.buildDependencyGraph('db-prod-01', 3);

console.log(`Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

// Export for visualization (D3.js, vis.js, Cytoscape.js)
fs.writeFileSync('dependency-graph.json', JSON.stringify(graph, null, 2));
```

**Graph Structure**:
```json
{
  "nodes": [
    {
      "id": "db-prod-01",
      "ci_id": "db-prod-01",
      "ci_name": "Production PostgreSQL Database",
      "ci_type": "database",
      "criticality": 85,
      "dependencies_count": 2,
      "dependents_count": 28
    }
  ],
  "edges": [
    {
      "source_id": "api-server-prod-01",
      "target_id": "db-prod-01",
      "relationship_type": "DEPENDS_ON",
      "weight": 1.0,
      "is_critical": true
    }
  ],
  "metadata": {
    "total_nodes": 45,
    "total_edges": 92,
    "max_depth": 3,
    "generated_at": "2025-11-06T15:00:00Z"
  }
}
```

---

## Configuration & Thresholds

### System Configuration

AI/ML Engine settings are stored in PostgreSQL:

```sql
-- Configuration table
CREATE TABLE system_config (
  config_key VARCHAR(255) PRIMARY KEY,
  config_value JSONB NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_by VARCHAR(255)
);

-- Anomaly detection configuration
INSERT INTO system_config (config_key, config_value, updated_by)
VALUES (
  'anomaly_detection',
  '{
    "enabled": true,
    "sensitivity": "medium",
    "min_confidence_score": 70,
    "check_interval_minutes": 60,
    "lookback_days": 30,
    "notification_enabled": true
  }'::jsonb,
  'system'
);
```

### Tuning Sensitivity

**Low Sensitivity** (fewer false positives):
```json
{
  "sensitivity": "low",
  "min_confidence_score": 85,
  "lookback_days": 60
}
```
- Z-score threshold: 2.5
- Use case: Production environments with established patterns
- Trade-off: May miss subtle anomalies

**High Sensitivity** (detect more anomalies):
```json
{
  "sensitivity": "high",
  "min_confidence_score": 60,
  "lookback_days": 14
}
```
- Z-score threshold: 1.5
- Use case: New deployments, critical infrastructure
- Trade-off: More false positives requiring investigation

### Performance Tuning

**Scheduled Scan Intervals**:
- **Anomaly Detection**: Every 60 minutes (default)
- **Drift Detection**: Event-driven (on CI updates)
- **Impact Prediction**: On-demand (before changes)

**Database Indexes** (for optimal performance):
```sql
-- Anomaly detection indexes
CREATE INDEX idx_anomalies_ci_id ON anomalies(ci_id);
CREATE INDEX idx_anomalies_severity ON anomalies(severity);
CREATE INDEX idx_anomalies_detected_at ON anomalies(detected_at);
CREATE INDEX idx_anomalies_status ON anomalies(status);

-- Drift detection indexes
CREATE INDEX idx_baselines_ci_id ON baseline_snapshots(ci_id);
CREATE INDEX idx_baselines_approved ON baseline_snapshots(is_approved);
CREATE INDEX idx_drift_results_ci_id ON drift_detection_results(ci_id);

-- Impact prediction indexes
CREATE INDEX idx_criticality_ci_id ON ci_criticality_scores(ci_id);
CREATE INDEX idx_criticality_calculated ON ci_criticality_scores(calculated_at);
```

---

## Event Streaming Integration

The AI/ML Engine integrates with HappyCMDB's Kafka event infrastructure for real-time analysis.

### Event Consumers

```typescript
import { startMLEngines } from '@cmdb/ai-ml-engine';

// Start all ML engines with event integration
await startMLEngines();
```

**Subscribed Topics**:
- `ci.discovered` - Create baseline for new CIs
- `ci.updated` - Check for drift
- `ci.changes` - Track change frequency

### Auto-Baseline on Discovery

When a new CI is discovered, a configuration baseline is automatically created:

```typescript
consumer.on('ci.discovered', async (event) => {
  try {
    logger.debug('Creating baseline for new CI', { ci_id: event.ci_id });
    await driftDetector.createBaseline(
      event.ci_id,
      'configuration',
      'auto-baseline'
    );
  } catch (error) {
    logger.error('Failed to create baseline', { ci_id: event.ci_id, error });
  }
});
```

### Drift Detection on Updates

When a CI is updated, drift is automatically checked:

```typescript
consumer.on('ci.updated', async (event) => {
  try {
    const driftResult = await driftDetector.detectDrift(event.ci_id);

    if (driftResult.has_drift && driftResult.drift_score > 50) {
      logger.warn('Significant drift detected', {
        ci_id: event.ci_id,
        drift_score: driftResult.drift_score,
        drifted_fields: driftResult.drifted_fields.length
      });

      // Emit drift event for remediation
      await eventProducer.emit('configuration_drift', 'drift-detector', {
        ci_id: event.ci_id,
        drift_score: driftResult.drift_score
      });
    }
  } catch (error) {
    logger.debug('Drift detection skipped (no baseline)', { ci_id: event.ci_id });
  }
});
```

### Scheduled Anomaly Detection

Periodic anomaly scans run every hour:

```typescript
setInterval(async () => {
  try {
    logger.info('Running scheduled anomaly detection');
    const anomalies = await anomalyEngine.detectAnomalies();
    logger.info('Anomaly detection completed', {
      anomalies_found: anomalies.length
    });
  } catch (error) {
    logger.error('Anomaly detection failed', { error });
  }
}, 60 * 60 * 1000); // 1 hour
```

---

## Use Cases

### Use Case 1: Proactive Incident Prevention

**Scenario**: Detect excessive changes to production database before failure occurs

**Workflow**:
1. Anomaly engine detects `db-prod-01` has 50 changes in 7 days (average: 5)
2. Z-score = 5.6 → Severity: CRITICAL
3. Kafka event emitted → ServiceNow incident created
4. DBA investigates and discovers misconfigured automation
5. Automation fixed before database corruption occurs

**Benefits**:
- Prevent outages before they happen
- Reduce MTTR (Mean Time To Resolve)
- Improve infrastructure stability

### Use Case 2: Unauthorized Configuration Changes

**Scenario**: Detect unauthorized changes to critical production server

**Workflow**:
1. Approved baseline exists for `prod-web-01`
2. CI updated: `environment: production → staging` (unauthorized)
3. Drift detector calculates drift score: 40 (HIGH severity field)
4. Kafka event triggers alert to security team
5. Change rolled back and investigated

**Benefits**:
- Detect security policy violations
- Maintain configuration compliance
- Audit trail for changes

### Use Case 3: Change Impact Analysis for CAB

**Scenario**: CAB needs to assess risk of upgrading critical database

**Workflow**:
1. Change request submitted: Upgrade `db-prod-01` from PostgreSQL 14 to 15
2. Impact engine analyzes dependencies
3. Blast radius: 82 CIs, Critical path: 6 hops
4. Risk level: CRITICAL, Estimated downtime: 175 minutes
5. CAB schedules maintenance window based on analysis

**Benefits**:
- Data-driven change approval decisions
- Accurate downtime estimates
- Identify affected stakeholders

### Use Case 4: Orphaned Resource Cleanup

**Scenario**: Identify and decommission orphaned CIs

**Workflow**:
1. Anomaly engine detects 45 orphaned CIs (no relationships for 30+ days)
2. Report generated for infrastructure team
3. Team reviews orphaned resources
4. 38 CIs confirmed as decommissioned in cloud but not CMDB
5. CIs removed, saving $2,400/month in cloud costs

**Benefits**:
- Cost optimization
- Accurate CMDB data
- Reduced technical debt

### Use Case 5: Performance Degradation Detection

**Scenario**: Detect performance anomalies before user impact

**Workflow**:
1. Performance baseline created for `api-server-prod-01`
2. Average response time: 150ms
3. Current response time: 850ms (5.6× baseline)
4. Anomaly detected: Performance degradation (HIGH severity)
5. Alert sent to on-call engineer
6. Memory leak identified and patched

**Benefits**:
- Proactive performance monitoring
- Reduce user-reported incidents
- Faster root cause analysis

---

## Best Practices

### Baseline Management

::: tip Best Practice
Create approved baselines for all critical production infrastructure within 30 days of deployment.
:::

**Recommended Baseline Strategy**:
1. **Immediate**: Auto-baseline on discovery (unapproved)
2. **Week 1**: Review and approve configuration baseline
3. **Week 2**: Create performance baseline (after stabilization)
4. **Week 4**: Create relationship baseline (after integrations complete)

### Anomaly Tuning

::: warning Important
Start with LOW sensitivity in production, gradually increase to MEDIUM after tuning false positives.
:::

**Tuning Process**:
1. Deploy with LOW sensitivity for 2 weeks
2. Review detected anomalies daily
3. Mark false positives as "ignored"
4. Adjust `min_confidence_score` based on findings
5. Increase to MEDIUM sensitivity after 80%+ true positive rate

### Change Risk Assessment

::: tip Best Practice
Always run impact analysis before HIGH/CRITICAL risk changes to production infrastructure.
:::

**Integration with Change Management**:
```typescript
// Before approving change request
async function assessChangeRisk(changeRequest: ChangeRequest) {
  const impact = await impactEngine.predictChangeImpact(
    changeRequest.ci_id,
    changeRequest.change_type
  );

  // Auto-reject HIGH/CRITICAL risk changes without CAB approval
  if (impact.risk_level === 'critical' || impact.risk_level === 'high') {
    if (!changeRequest.cab_approved) {
      throw new Error('CAB approval required for high-risk changes');
    }
  }

  // Require maintenance window for changes with downtime
  if (impact.estimated_downtime_minutes && impact.estimated_downtime_minutes > 5) {
    if (!changeRequest.maintenance_window) {
      throw new Error('Maintenance window required for changes with downtime');
    }
  }

  return impact;
}
```

### Data Retention

**Recommended Retention Policies**:
- **Anomalies**: 90 days (CRITICAL/HIGH), 30 days (MEDIUM/LOW)
- **Baselines**: Keep all approved baselines indefinitely
- **Drift Results**: 180 days
- **Impact Analyses**: 365 days

```sql
-- Cleanup old anomalies (run daily)
DELETE FROM anomalies
WHERE detected_at < NOW() - INTERVAL '90 days'
AND severity IN ('critical', 'high');

DELETE FROM anomalies
WHERE detected_at < NOW() - INTERVAL '30 days'
AND severity IN ('medium', 'low', 'info');
```

---

## Troubleshooting

### Issue 1: Anomaly Detection Not Running

**Problem**: No anomalies detected for several days

**Diagnosis**:
```bash
# Check if ML engines are running
docker logs cmdb-api-server | grep "ML engines started"

# Check configuration
psql -d cmdb -c "SELECT * FROM system_config WHERE config_key = 'anomaly_detection';"
```

**Solution**:
```typescript
// Verify configuration is loaded
const engine = getAnomalyDetectionEngine();
await engine.loadConfiguration();

// Run manual detection
const anomalies = await engine.detectAnomalies();
console.log(`Detected ${anomalies.length} anomalies`);
```

### Issue 2: Drift Detection Throws "No Approved Baseline"

**Problem**: `Error: No approved baseline found for CI: ci-12345`

**Diagnosis**:
```sql
-- Check if baseline exists
SELECT * FROM baseline_snapshots
WHERE ci_id = 'ci-12345'
ORDER BY created_at DESC;

-- Check if any baselines are approved
SELECT is_approved, COUNT(*)
FROM baseline_snapshots
WHERE ci_id = 'ci-12345'
GROUP BY is_approved;
```

**Solution**:
```typescript
// Create and approve baseline
const baseline = await driftDetector.createBaseline(
  'ci-12345',
  'configuration',
  'admin@company.com'
);

await driftDetector.approveBaseline(
  baseline.id,
  'cab-approver@company.com'
);

// Now drift detection will work
const drift = await driftDetector.detectDrift('ci-12345');
```

### Issue 3: High Memory Usage During Impact Analysis

**Problem**: Impact prediction engine consuming excessive memory for large dependency graphs

**Diagnosis**:
```bash
# Check Neo4j query performance
docker exec cmdb-neo4j cypher-shell "
  MATCH path = (root:CI {id: 'ci-12345'})-[*0..3]-(related:CI)
  RETURN count(path)
"
```

**Solution**:
```typescript
// Reduce max_depth for large graphs
const graph = await impactEngine.buildDependencyGraph(
  'ci-12345',
  2  // Reduce from 3 to 2 hops
);

// Or limit affected CIs in query
const impact = await impactEngine.predictChangeImpact(
  'ci-12345',
  ChangeType.RESTART
);
// Internal query already limits to 200 CIs
```

### Issue 4: False Positive Anomalies

**Problem**: Too many LOW severity anomalies for normal operations

**Diagnosis**:
```sql
-- Analyze anomaly distribution
SELECT anomaly_type, severity, COUNT(*)
FROM anomalies
WHERE detected_at >= NOW() - INTERVAL '7 days'
GROUP BY anomaly_type, severity
ORDER BY COUNT(*) DESC;
```

**Solution**:
```json
// Adjust configuration to reduce false positives
{
  "sensitivity": "low",
  "min_confidence_score": 80,
  "lookback_days": 60
}
```

---

## Database Schema

### Anomalies Table

```sql
CREATE TABLE anomalies (
  id UUID PRIMARY KEY,
  ci_id VARCHAR(255) NOT NULL,
  ci_name VARCHAR(500),
  anomaly_type VARCHAR(100) NOT NULL,
  severity VARCHAR(50) NOT NULL,
  confidence_score INTEGER NOT NULL CHECK (confidence_score BETWEEN 0 AND 100),
  detected_at TIMESTAMP NOT NULL DEFAULT NOW(),
  description TEXT,
  metrics JSONB,
  context JSONB,
  status VARCHAR(50) NOT NULL DEFAULT 'detected',
  resolved_at TIMESTAMP,
  resolved_by VARCHAR(255),

  CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  CHECK (status IN ('detected', 'investigating', 'confirmed', 'false_positive', 'resolved', 'ignored'))
);

CREATE INDEX idx_anomalies_ci_id ON anomalies(ci_id);
CREATE INDEX idx_anomalies_severity ON anomalies(severity);
CREATE INDEX idx_anomalies_detected_at ON anomalies(detected_at);
CREATE INDEX idx_anomalies_status ON anomalies(status);
```

### Baseline Snapshots Table

```sql
CREATE TABLE baseline_snapshots (
  id UUID PRIMARY KEY,
  ci_id VARCHAR(255) NOT NULL,
  snapshot_type VARCHAR(50) NOT NULL,
  snapshot_data JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_by VARCHAR(255) NOT NULL,
  is_approved BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by VARCHAR(255),
  approved_at TIMESTAMP,

  CHECK (snapshot_type IN ('configuration', 'performance', 'relationships'))
);

CREATE INDEX idx_baselines_ci_id ON baseline_snapshots(ci_id);
CREATE INDEX idx_baselines_approved ON baseline_snapshots(is_approved);
CREATE INDEX idx_baselines_type ON baseline_snapshots(snapshot_type);
```

### Drift Detection Results Table

```sql
CREATE TABLE drift_detection_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ci_id VARCHAR(255) NOT NULL,
  ci_name VARCHAR(500),
  has_drift BOOLEAN NOT NULL,
  drift_score INTEGER NOT NULL CHECK (drift_score BETWEEN 0 AND 100),
  drifted_fields JSONB NOT NULL,
  baseline_snapshot_id UUID REFERENCES baseline_snapshots(id),
  detected_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_drift_results_ci_id ON drift_detection_results(ci_id);
CREATE INDEX idx_drift_results_detected_at ON drift_detection_results(detected_at);
```

### Impact Analyses Table

```sql
CREATE TABLE impact_analyses (
  id UUID PRIMARY KEY,
  source_ci_id VARCHAR(255) NOT NULL,
  source_ci_name VARCHAR(500),
  change_type VARCHAR(100) NOT NULL,
  impact_score INTEGER NOT NULL CHECK (impact_score BETWEEN 0 AND 100),
  blast_radius INTEGER NOT NULL,
  critical_path JSONB,
  risk_level VARCHAR(50) NOT NULL,
  analyzed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  estimated_downtime_minutes INTEGER,
  affected_cis JSONB,

  CHECK (risk_level IN ('critical', 'high', 'medium', 'low', 'minimal'))
);

CREATE INDEX idx_impact_source_ci ON impact_analyses(source_ci_id);
CREATE INDEX idx_impact_analyzed_at ON impact_analyses(analyzed_at);
CREATE INDEX idx_impact_risk_level ON impact_analyses(risk_level);
```

### CI Criticality Scores Table

```sql
CREATE TABLE ci_criticality_scores (
  ci_id VARCHAR(255) PRIMARY KEY,
  ci_name VARCHAR(500),
  criticality_score INTEGER NOT NULL CHECK (criticality_score BETWEEN 0 AND 100),
  factors JSONB NOT NULL,
  calculated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_criticality_calculated ON ci_criticality_scores(calculated_at);
CREATE INDEX idx_criticality_score ON ci_criticality_scores(criticality_score DESC);
```

---

## Related Resources

### Architecture Documentation
- [System Overview](/architecture/system-overview) - HappyCMDB architecture
- [Event Streaming](/architecture/event-streaming) - Kafka integration (future)
- [Database Design](/architecture/database/overview) - Neo4j and PostgreSQL

### Component Guides
- [AI Discovery](/components/ai-discovery) - Agentic AI discovery
- [Pattern Learning](/components/pattern-learning) - ML pattern compilation
- [ITIL Service Manager](/components/itil-service-manager) - ITIL v4 workflows

### API Reference
- [REST API](/api/rest/discovery) - Discovery REST endpoints
- [GraphQL API](/api/graphql) - GraphQL schema

### Operations
- [Daily Operations](/operations/daily-operations) - Operational procedures
- [Troubleshooting](/operations/troubleshooting) - Common issues

---

## Next Steps

- [ ] Configure anomaly detection thresholds for your environment
- [ ] Create approved baselines for critical production infrastructure
- [ ] Set up Kafka event consumers for automated remediation
- [ ] Integrate impact analysis with change management workflows
- [ ] Configure drift detection alerts in PagerDuty/Slack

---

**Last Updated**: 2025-11-06
**Maintainer**: HappyCMDB Team
**Package Version**: @cmdb/ai-ml-engine v2.0.0
