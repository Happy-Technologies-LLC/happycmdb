# HappyCMDB Monitoring Infrastructure

**Version**: v3.0
**Last Updated**: November 2025

This directory contains the complete monitoring infrastructure for HappyCMDB v3.0, including Prometheus, Grafana dashboards, and alert rules.

## Overview

HappyCMDB v3.0 monitoring provides comprehensive observability across:

- **ITIL v4 Service Management**: Incidents, changes, baselines, drift detection
- **TBM v5.0.1 Cost Transparency**: Cost allocation, cloud spend, budget tracking
- **BSM Business Impact**: Criticality tiers, revenue at risk, blast radius
- **AI Discovery**: Costs, token usage, pattern learning, anomaly detection
- **Kafka Event Streaming**: Throughput, consumer lag, broker health
- **Base Platform**: API performance, database health, infrastructure metrics

## Directory Structure

```
monitoring/
├── README.md                           # This file
├── prometheus/
│   ├── prometheus.yml                  # Main Prometheus configuration
│   ├── recording-rules.yml             # Pre-aggregated metrics
│   └── alerts/
│       ├── application.yml             # Application-level alerts
│       ├── performance.yml             # Performance alerts
│       ├── service-health.yml          # Service health alerts
│       └── v3-alerts.yml               # v3.0 framework alerts (NEW)
├── grafana/
│   ├── README.md                       # Grafana setup guide
│   ├── dashboards/
│   │   ├── v3-platform-overview.json   # v3.0 unified dashboard (NEW)
│   │   ├── v3-ai-discovery.json        # AI discovery metrics (NEW)
│   │   ├── v3-bsm-impact.json          # BSM business impact (NEW)
│   │   ├── v3-tbm-cost.json            # TBM cost transparency (NEW)
│   │   ├── v3-itil-service-mgmt.json   # ITIL service mgmt (NEW)
│   │   ├── v3-kafka-streaming.json     # Kafka event streaming (NEW)
│   │   ├── cmdb-overview.json          # v2.0 legacy dashboard
│   │   ├── discovery-operations.json   # v2.0 discovery dashboard
│   │   └── ... (other v2.0 dashboards)
│   └── provisioning/
│       ├── datasources/                # Data source configs
│       └── dashboards/                 # Dashboard provisioning
└── alerting/
    ├── alertmanager.yml                # Alertmanager configuration
    └── alert-rules.yml                 # Alert routing rules
```

## Quick Start

### 1. Start Monitoring Stack

```bash
# Using Docker Compose
cd infrastructure/monitoring
docker-compose up -d

# Or using Kubernetes
kubectl apply -f infrastructure/kubernetes/monitoring/
```

### 2. Access Dashboards

| Service | URL | Credentials |
|---------|-----|-------------|
| **Grafana** | http://localhost:3001 | admin / [from .env] |
| **Prometheus** | http://localhost:9090 | - |
| **Alertmanager** | http://localhost:9093 | - |

### 3. Verify Metrics Collection

```bash
# Check Prometheus targets
curl http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, health: .health}'

# Check if v3.0 metrics are being scraped
curl http://localhost:9090/api/v1/label/__name__/values | grep -E "cmdb_(itil|tbm|bsm|ai)"
```

## v3.0 Metrics Reference

### ITIL Service Management Metrics

```promql
# Incident Metrics
cmdb_itil_incidents_created_total{priority="P1"}       # P1 incidents created
cmdb_itil_incidents_open{priority="P1"}                # Open P1 incidents
cmdb_itil_incident_resolution_minutes                  # MTTR

# Change Metrics
cmdb_itil_changes_total{risk_level="high"}            # Changes by risk
cmdb_itil_changes_completed_total{status="failed"}    # Failed changes
cmdb_itil_change_window_savings_hours                 # Optimized change windows

# Configuration Metrics
cmdb_itil_drift_detected_total                        # Config drift events
cmdb_itil_cis_compliant / cmdb_itil_cis_total        # Baseline compliance
cmdb_itil_ci_by_lifecycle{stage="production"}        # CIs by lifecycle

# SLA Metrics
cmdb_itil_sla_met_count / cmdb_itil_sla_total_count # SLA compliance
```

### TBM Cost Transparency Metrics

```promql
# Cost Metrics
cmdb_tbm_resource_cost_monthly                        # Total monthly cost
cmdb_tbm_cloud_cost_monthly{provider="aws"}          # Cloud costs by provider
cmdb_tbm_capability_cost_monthly{capability="CRM"}   # Cost by capability

# Allocation Metrics
cmdb_tbm_costs_allocated_total / cmdb_tbm_costs_total # Allocation efficiency
cmdb_tbm_ci_cost_monthly                             # Cost per CI

# License Metrics
cmdb_tbm_license_renewal_days_remaining              # Days until renewal
cmdb_tbm_underutilized_cost_monthly                  # Wasted spend

# Budget Metrics
(cmdb_tbm_actual_cost_monthly - cmdb_tbm_budget_monthly) / cmdb_tbm_budget_monthly # Variance
cmdb_tbm_cost_anomalies_detected_total               # Cost anomalies
```

### BSM Business Impact Metrics

```promql
# Criticality Metrics
cmdb_bsm_service_criticality{tier="Tier-0"}          # Services by tier
cmdb_bsm_impact_score                                # Business impact (0-100)
cmdb_bsm_service_risk_rating{level="critical"}       # Risk rating

# Financial Impact
cmdb_bsm_revenue_at_risk_dollars                     # Revenue at risk
cmdb_bsm_downtime_cost_per_hour_dollars              # Downtime cost

# Compliance Metrics
cmdb_bsm_compliance_penalty_risk_dollars{framework="GDPR"} # Penalty risk
cmdb_bsm_compliance_violation{severity="critical"}   # Violations

# Performance Metrics
cmdb_bsm_blast_radius_duration_seconds               # Blast radius calc time
cmdb_bsm_spof_detected_total                         # Single points of failure
cmdb_bsm_mttr_minutes{tier="Tier-0"}                 # MTTR by tier
```

### AI Discovery Metrics

```promql
# Cost Metrics
cmdb_ai_discovery_cost_dollars                       # AI discovery costs
cmdb_ai_tokens_used_total{provider="openai"}        # Token usage

# Performance Metrics
cmdb_ai_discovery_duration_seconds                   # Session duration
cmdb_ai_response_duration_seconds{provider="anthropic"} # Response latency

# Pattern Learning
cmdb_ai_patterns_learned_total{status="success"}     # Patterns learned
cmdb_ai_patterns_total{industry="retail"}            # Patterns by industry

# Anomaly Detection
cmdb_ai_anomalies_detected_total{severity="high"}    # Anomalies by severity

# Error Metrics
cmdb_ai_discovery_errors_total                       # Discovery errors
```

### Kafka Event Streaming Metrics

```promql
# Broker Metrics
up{job="kafka-jmx"}                                  # Broker status
kafka_log_log_size_value                             # Broker disk usage

# Topic Metrics
kafka_topic_partition_current_offset                 # Topic offsets
kafka_topic_partition_replicas                       # Replication factor

# Consumer Metrics
kafka_consumer_lag_records                           # Consumer lag
kafka_consumer_fetch_manager_records_lag             # Fetch lag

# Health Metrics
kafka_topic_partition_under_replicated_partition     # Under-replicated
kafka_controller_offline_partitions_count            # Offline partitions

# Processing Metrics
cmdb_kafka_processing_errors_total                   # Processing errors
```

## Alert Rules

### v3.0 Alert Severity Levels

| Severity | Description | Response Time | Action |
|----------|-------------|---------------|--------|
| **critical** | Service degradation or data loss risk | Immediate | Page on-call engineer |
| **warning** | Approaching thresholds or degraded performance | 15 minutes | Create ticket |
| **info** | Informational, no action required | - | Log only |

### Key v3.0 Alerts

#### AI Discovery Alerts
- **AIDiscoveryCostBudgetExceeded**: Monthly AI costs >$5,000
- **AIDiscoveryCostSpike**: Hourly cost rate >$10/hour
- **AIDiscoveryHighErrorRate**: Error rate >10%

#### BSM Business Impact Alerts
- **Tier0ServiceDown**: Tier 0 service down (immediate page)
- **HighRevenueAtRisk**: Revenue at risk >$1M
- **CriticalComplianceViolation**: Critical compliance issues

#### TBM Cost Alerts
- **CloudCostAnomaly**: Unexpected cost patterns detected
- **BudgetVarianceHigh**: Budget variance >15%
- **LicenseRenewalDue**: License expires in <30 days

#### ITIL Service Alerts
- **HighPriorityIncidentBacklog**: >10 P1/P2 incidents open
- **SLABreachRisk**: SLA compliance <95%
- **ChangeFailureRateHigh**: Change failure rate >5%

#### Kafka Alerts
- **KafkaBrokerDown**: Broker offline (immediate page)
- **KafkaConsumerLagCritical**: Consumer lag >500K records
- **KafkaOfflinePartitions**: Data loss risk (immediate page)

### Alert Configuration

Alerts are defined in `/infrastructure/monitoring/prometheus/alerts/v3-alerts.yml`:

```yaml
groups:
  - name: ai_discovery_alerts
    rules:
      - alert: AIDiscoveryCostBudgetExceeded
        expr: sum(increase(cmdb_ai_discovery_cost_dollars[30d])) > 5000
        for: 1h
        labels:
          severity: warning
        annotations:
          summary: "AI Discovery monthly budget exceeded"
```

### Testing Alerts

```bash
# Check if alert rules are loaded
curl http://localhost:9090/api/v1/rules | jq '.data.groups[] | select(.name | contains("v3"))'

# Manually trigger alert (for testing)
curl -X POST http://localhost:9090/api/v1/alerts

# Check active alerts
curl http://localhost:9090/api/v1/alerts | jq '.data.alerts[] | select(.state=="firing")'
```

## Grafana Dashboards

### v3.0 Dashboard Quick Links

| Dashboard | URL | Purpose |
|-----------|-----|---------|
| **v3.0 Platform Overview** | /d/v3-platform-overview | Unified v3.0 health |
| **AI Discovery** | /d/v3-ai-discovery | AI costs & patterns |
| **BSM Impact** | /d/v3-bsm-impact | Business criticality |
| **TBM Cost** | /d/v3-tbm-cost | FinOps metrics |
| **ITIL Service Mgmt** | /d/v3-itil-service-mgmt | ITSM operations |
| **Kafka Streaming** | /d/v3-kafka-streaming | Event streaming |

### Dashboard Provisioning

Dashboards are automatically provisioned on Grafana startup:

```yaml
# grafana/provisioning/dashboards/cmdb-dashboards.yml
apiVersion: 1
providers:
  - name: 'HappyCMDB v3.0'
    folder: 'HappyCMDB'
    type: file
    options:
      path: /etc/grafana/dashboards
```

### Adding Custom Dashboards

1. Create dashboard in Grafana UI
2. Export JSON (Dashboard Settings → JSON Model)
3. Save to `grafana/dashboards/custom-dashboard.json`
4. Restart Grafana to provision

## Recording Rules

Pre-aggregated metrics for better query performance:

```yaml
# v3.0 ITIL Aggregations
- record: priority:cmdb_itil_incidents_created:rate5m
  expr: sum by (priority) (rate(cmdb_itil_incidents_created_total[5m]))

# v3.0 TBM Aggregations
- record: tower:cmdb_tbm_total_cost:sum
  expr: sum by (tower) (cmdb_tbm_resource_cost_monthly)

# v3.0 BSM Aggregations
- record: tier:cmdb_bsm_services:count
  expr: count by (tier) (cmdb_bsm_service_criticality)

# v3.0 Kafka Aggregations
- record: topic:cmdb_kafka_events:rate5m
  expr: sum by (topic) (rate(kafka_topic_partition_current_offset[5m]))
```

## Prometheus Configuration

### Scrape Configs

v3.0 introduces framework-specific scrape endpoints:

```yaml
# ITIL Service Manager Metrics
- job_name: 'cmdb-itil-manager'
  metrics_path: '/metrics/itil'
  scrape_interval: 30s
  static_configs:
    - targets: ['api-server:3000']

# TBM Cost Engine Metrics
- job_name: 'cmdb-tbm-engine'
  metrics_path: '/metrics/tbm'
  scrape_interval: 60s
  static_configs:
    - targets: ['api-server:3000']

# BSM Impact Engine Metrics
- job_name: 'cmdb-bsm-engine'
  metrics_path: '/metrics/bsm'
  scrape_interval: 30s
  static_configs:
    - targets: ['api-server:3000']

# AI Discovery Metrics
- job_name: 'cmdb-ai-discovery'
  metrics_path: '/metrics/ai'
  scrape_interval: 60s
  static_configs:
    - targets: ['discovery-engine:3001']

# Kafka JMX Metrics
- job_name: 'kafka-jmx'
  static_configs:
    - targets:
        - 'kafka-0.kafka:7071'
        - 'kafka-1.kafka:7071'
        - 'kafka-2.kafka:7071'
```

### Retention Configuration

```yaml
storage:
  tsdb:
    retention.time: 30d    # Keep metrics for 30 days
    retention.size: 50GB   # Max storage size
```

For longer retention, use remote write to long-term storage (PostgreSQL data mart).

## Kubernetes Deployment

### ServiceMonitor CRDs

Prometheus Operator automatically discovers services:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: api-server
  namespace: happycmdb-cmdb
spec:
  selector:
    matchLabels:
      app: api-server
  endpoints:
    - port: http
      path: /metrics
      interval: 15s
```

### Deploy Monitoring Stack

```bash
# Apply ServiceMonitors
kubectl apply -f infrastructure/kubernetes/monitoring/servicemonitors.yaml

# Install Prometheus Operator (if not already installed)
helm install prometheus-operator prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace

# Verify scrape targets
kubectl port-forward -n monitoring svc/prometheus-operated 9090:9090
# Open http://localhost:9090/targets
```

## Troubleshooting

### Metrics Not Appearing

```bash
# Check if service is exposing metrics
curl http://api-server:3000/metrics/itil

# Check Prometheus targets
curl http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | select(.health != "up")'

# Check Prometheus logs
docker logs prometheus
# or
kubectl logs -n monitoring prometheus-0
```

### High Cardinality Issues

If Prometheus performance degrades:

```bash
# Check metric cardinality
curl http://localhost:9090/api/v1/status/tsdb | jq '.data.seriesCountByMetricName | sort_by(.value) | reverse | .[0:10]'

# Reduce cardinality by dropping labels
# Add to prometheus.yml:
metric_relabel_configs:
  - source_labels: [__name__]
    regex: 'high_cardinality_metric'
    action: drop
```

### Alert Not Firing

```bash
# Check if alert rule is loaded
curl http://localhost:9090/api/v1/rules | jq '.data.groups[] | select(.name == "ai_discovery_alerts")'

# Check alert state
curl http://localhost:9090/api/v1/alerts | jq '.data.alerts[] | select(.labels.alertname == "AIDiscoveryCostBudgetExceeded")'

# Verify expression manually
curl -G http://localhost:9090/api/v1/query --data-urlencode 'query=sum(increase(cmdb_ai_discovery_cost_dollars[30d]))'
```

### Dashboard Not Loading

```bash
# Check Grafana logs
docker logs grafana

# Verify dashboard provisioning
curl http://admin:password@localhost:3001/api/dashboards/db/v3-platform-overview

# Re-provision dashboards
docker restart grafana
# or
kubectl rollout restart deployment/grafana -n monitoring
```

## Performance Tuning

### Prometheus

```yaml
# Increase scrape parallelism
global:
  scrape_interval: 15s
  scrape_timeout: 10s

# Optimize recording rules
recording_rules:
  evaluation_interval: 30s  # Evaluate less frequently
```

### Grafana

```ini
# grafana.ini
[dashboards]
min_refresh_interval = 5s

[database]
max_open_conn = 100
max_idle_conn = 10
```

## Maintenance

### Backup Dashboards

```bash
# Export all dashboards
./scripts/backup-dashboards.sh

# Backup Prometheus data
tar czf prometheus-data-$(date +%Y%m%d).tar.gz /prometheus/data
```

### Update Alert Rules

```bash
# 1. Edit alert rules
vim infrastructure/monitoring/prometheus/alerts/v3-alerts.yml

# 2. Validate rules
promtool check rules infrastructure/monitoring/prometheus/alerts/v3-alerts.yml

# 3. Reload Prometheus
curl -X POST http://localhost:9090/-/reload
# or
kubectl rollout restart statefulset/prometheus -n monitoring
```

## Support

- **Documentation**: http://localhost:8080/operations/monitoring-dashboards
- **Runbooks**: `/docs/operations/runbooks/`
- **Slack**: #happycmdb-monitoring
- **PagerDuty**: HappyCMDB v3.0 service

## Related Documentation

- [Kubernetes Deployment](/doc-site/docs/deployment/kubernetes.md)
- [Monitoring Dashboards](/doc-site/docs/operations/monitoring-dashboards.md)
- [Operations Guide](/doc-site/docs/operations/daily-operations.md)
- [Troubleshooting](/doc-site/docs/operations/troubleshooting.md)

---

**HappyCMDB v3.0 Monitoring Infrastructure**
© 2025 HappyCMDB Project
