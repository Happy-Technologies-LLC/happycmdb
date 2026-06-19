# Monitoring Dashboards and Key Metrics

## Overview

This guide provides links to all monitoring dashboards, key metrics to watch, and how to interpret them for HappyCMDB production systems.

## Quick Access Links

### Primary Monitoring Systems

| System | URL | Purpose | Credentials |
|--------|-----|---------|-------------|
| **Grafana** | http://localhost:3001 | Dashboards and visualizations | admin / [from .env] |
| **Prometheus** | http://localhost:9090 | Metrics and alerts | - |
| **PagerDuty** | https://company.pagerduty.com | Alert management and escalation | SSO |
| **Status Page** | https://status.happycmdb.com | Public status and incidents | Admin SSO |

### Application Access

| Service | URL | Purpose |
|---------|-----|---------|
| **API Health** | http://localhost:3000/health | API health check |
| **GraphQL Playground** | http://localhost:3000/graphql | GraphQL API explorer |
| **Web UI** | http://localhost:3000 | User interface |
| **API Metrics** | http://localhost:3000/metrics | Prometheus metrics endpoint |

### Infrastructure Access

| Service | URL | Notes |
|---------|-----|-------|
| **Neo4j Browser** | http://localhost:7474 | Graph database UI |
| **Redis Commander** | http://localhost:8081 | Redis key browser |
| **PostgreSQL** | localhost:5432 | Use psql or database client |

## Grafana Dashboards

### v3.0 Dashboards

HappyCMDB v3.0 introduces comprehensive monitoring for ITIL, TBM, BSM, AI Discovery, and Kafka event streaming.

#### v3.0 Platform Overview

**URL**: http://localhost:3001/d/v3-platform-overview/v3-platform-overview

**Purpose**: Unified v3.0 system health across all frameworks

**Key Panels**:
- Platform health status (all services)
- ITIL incidents by priority
- TBM IT spend by tower
- BSM critical services (Tier 0-1)
- AI Discovery cost trends
- Kafka event throughput
- Change success rate by risk level
- Revenue at risk
- Configuration drift detection
- Kafka consumer lag
- AI anomalies by severity

**When to Use**: Primary dashboard for v3.0 monitoring, comprehensive view of all frameworks

#### v3.0 AI Discovery & Pattern Learning

**URL**: http://localhost:3001/d/v3-ai-discovery/ai-discovery

**Purpose**: Monitor AI-powered discovery costs, usage, and performance

**Key Panels**:
- AI discovery cost by provider (OpenAI, Anthropic, etc.)
- Monthly AI budget status with thresholds
- Token usage by provider
- Pattern learning success rate
- Patterns learned by industry
- Anomaly detection by severity
- AI session duration heatmap
- Model response latency
- Cost per discovery session
- AI discovery error rate

**Critical Metrics**:
- Monthly budget: $5,000 threshold
- Success rate: >80% expected
- Response latency: <10s target
- Error rate: <5% acceptable

#### v3.0 BSM Business Impact

**URL**: http://localhost:3001/d/v3-bsm-impact/bsm-impact

**Purpose**: Monitor business criticality, revenue at risk, and impact scoring

**Key Panels**:
- Services by criticality tier (Tier 0-4)
- Total revenue at risk ($)
- Blast radius calculation performance
- Business impact scores (Top 10 services)
- Customer impact (users affected)
- Compliance risk by framework (GDPR, HIPAA, etc.)
- Risk rating distribution
- Tier 0 service health
- Downtime cost per hour
- Single point of failure detection
- MTTR by criticality tier
- Blast radius calculation rate

**Alert Thresholds**:
- Revenue at risk: >$1M = critical alert
- Tier 0 down: immediate page
- Blast radius calc: >5min = warning

#### v3.0 TBM Cost Transparency

**URL**: http://localhost:3001/d/v3-tbm-cost/tbm-cost

**Purpose**: FinOps dashboard for cost allocation, cloud spend, and budget tracking

**Key Panels**:
- Total IT spend by resource tower
- Monthly IT spend trend
- Cloud cost by provider (AWS, Azure, GCP)
- On-prem vs cloud cost split
- Cost allocation efficiency
- Top 10 cost drivers
- Cost by business capability
- License renewal alerts (90 days)
- Underutilized resources ($)
- Budget variance %
- Depreciation by asset type
- Cloud cost anomaly detection

**FinOps Targets**:
- Allocation efficiency: >90%
- Budget variance: ±10%
- Underutilized waste: <$50K/month

#### v3.0 ITIL Service Management

**URL**: http://localhost:3001/d/v3-itil-service-mgmt/itil

**Purpose**: ITSM operations monitoring - incidents, changes, baselines

**Key Panels**:
- Open incidents by priority
- Incident creation rate (24h)
- Mean Time to Resolution (MTTR)
- Changes by risk level
- Change success rate
- Failed changes (last 7 days)
- Configuration baseline compliance
- Configuration drift detection rate
- CIs by lifecycle stage
- SLA compliance by priority
- Audit compliance status
- Top CIs with most incidents
- Change window optimization savings

**ITIL Targets**:
- MTTR: <4 hours
- Change success: >95%
- SLA compliance: >95%
- Baseline compliance: >90%

#### v3.0 Kafka Event Streaming

**URL**: http://localhost:3001/d/v3-kafka-streaming/kafka

**Purpose**: Monitor Kafka cluster health, throughput, and consumer lag

**Key Panels**:
- Kafka brokers up (should be 3/3)
- Total event throughput (events/sec)
- Total consumer lag
- Event throughput by topic
- Consumer lag by group
- Event processing latency (p95)
- Broker disk usage
- Messages per topic (24h)
- Failed message processing
- Topics by message size
- Under-replicated partitions (should be 0)
- Offline partitions (should be 0)

**Critical Kafka Metrics**:
- Brokers up: 3/3 required
- Consumer lag: <100K acceptable, >500K critical
- Under-replicated: 0 required
- Offline partitions: 0 required

### v2.0 Dashboards (Legacy)

### 1. Overview Dashboard

**URL**: http://localhost:3001/d/overview/happycmdb-overview

**Purpose**: High-level system health at a glance (v2.0 base platform)

**Key Panels**:
- **Service Status**: Up/down status of all services
- **Request Rate**: HTTP requests/sec across all endpoints
- **Error Rate**: Percentage of 5xx errors
- **Response Time**: p50, p95, p99 response times
- **Active Users**: Current logged-in users
- **Discovery Jobs**: Running, queued, failed jobs

**When to Use**: First dashboard to check during incidents or health checks

**Healthy Indicators**:
- ✅ All services showing "1" (up)
- ✅ Error rate <1%
- ✅ Response time p95 <500ms
- ✅ Discovery job success rate >95%

**Alert Indicators**:
- ⚠️ Any service showing "0" (down)
- ⚠️ Error rate >5%
- ⚠️ Response time p95 >1s
- ⚠️ Discovery job success rate <90%

### 2. API Performance Dashboard

**URL**: http://localhost:3001/d/api-perf/api-performance

**Purpose**: Detailed API performance metrics

**Key Panels**:
- **Request Rate by Endpoint**: Identify hot endpoints
- **Response Time by Endpoint**: Slow endpoint detection
- **Request Distribution**: GET/POST/PUT/DELETE breakdown
- **Status Code Distribution**: 2xx/4xx/5xx breakdown
- **Top Slowest Endpoints**: p95 response time ranked
- **Concurrent Requests**: Active requests over time

**When to Use**:
- Performance degradation incidents
- API optimization reviews
- Capacity planning

**Queries to Try**:
```promql
# Request rate by endpoint
rate(http_requests_total[5m])

# p95 response time by endpoint
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))

# Error rate by endpoint
rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m])
```

### 3. Database Performance Dashboard

**URL**: http://localhost:3001/d/db-perf/database-performance

**Purpose**: Database health and performance

**Key Panels**:

**Neo4j**:
- Query execution time (p50, p95, p99)
- Connection pool usage
- Page cache hit ratio
- Transaction rate
- Store size growth

**PostgreSQL**:
- Query execution time
- Connection count
- Cache hit ratio
- Table sizes
- Locks and deadlocks

**Redis**:
- Memory usage
- Connected clients
- Commands/sec
- Hit rate
- Evicted keys

**When to Use**:
- Database connection issues
- Slow query problems
- Performance optimization

**Healthy Indicators**:
- ✅ Neo4j cache hit ratio >90%
- ✅ PostgreSQL cache hit ratio >95%
- ✅ Redis hit rate >80%
- ✅ Connection pool usage <70%

### 4. Discovery Engine Dashboard

**URL**: http://localhost:3001/d/discovery/discovery-engine

**Purpose**: Discovery job monitoring

**Key Panels**:
- **Jobs by Status**: Running, queued, completed, failed
- **Success Rate by Connector**: Per-connector success %
- **Job Duration**: How long jobs take (p50, p95)
- **CIs Discovered**: Total CIs discovered over time
- **Rate Limiting**: Connectors being throttled
- **Credential Failures**: Authentication errors

**When to Use**:
- Discovery job failures
- Connector troubleshooting
- Data freshness verification

**Healthy Indicators**:
- ✅ Success rate >95% across all connectors
- ✅ No jobs stuck in "running" >2 hours
- ✅ Queue depth stable or decreasing
- ✅ No credential failures

### 5. Infrastructure Dashboard

**URL**: http://localhost:3001/d/infra/infrastructure

**Purpose**: Server and container health

**Key Panels**:
- **CPU Usage**: Per container and system-wide
- **Memory Usage**: Per container and system-wide
- **Disk Usage**: Per mount point
- **Network I/O**: Bytes in/out
- **Container Restarts**: Unexpected restarts
- **Disk I/O**: Read/write operations

**When to Use**:
- Resource exhaustion incidents
- Capacity planning
- Performance investigations

**Healthy Indicators**:
- ✅ CPU usage <70%
- ✅ Memory usage <75%
- ✅ Disk usage <80%
- ✅ No unexpected container restarts

### 6. Security Dashboard

**URL**: http://localhost:3001/d/security/security-metrics

**Purpose**: Security event monitoring

**Key Panels**:
- **Failed Login Attempts**: Rate of auth failures
- **Failed Login by IP**: Detect brute force
- **Suspicious Activity**: Anomaly detection
- **Rate Limit Violations**: By client/endpoint
- **JWT Token Issues**: Invalid or expired tokens
- **Access Denied Events**: 403 errors

**When to Use**:
- Security incidents
- Brute force attack detection
- Access pattern analysis

**Alert Indicators**:
- ⚠️ Failed logins >50/min from single IP
- ⚠️ Spike in rate limit violations
- ⚠️ Unusual access patterns

### 7. Business Metrics Dashboard

**URL**: http://localhost:3001/d/business/business-metrics

**Purpose**: Business KPIs and usage

**Key Panels**:
- **Total CIs**: Current CI inventory size
- **CIs by Type**: Breakdown by CI type
- **Active Users**: Daily/Weekly active users
- **API Calls**: Total API usage
- **Discovery Coverage**: % of expected CIs discovered
- **Connector Adoption**: Which connectors used

**When to Use**:
- Product reviews
- Usage reporting
- Capacity planning

### 8. SLA Dashboard

**URL**: http://localhost:3001/d/sla/sla-compliance

**Purpose**: SLA and uptime tracking

**Key Panels**:
- **Uptime %**: 99.9% SLA target
- **Availability**: Service uptime over time
- **MTTR**: Mean time to recovery
- **MTBF**: Mean time between failures
- **Incident Count**: By severity
- **SLA Violations**: Breaches over time

**When to Use**:
- SLA reporting
- Incident reviews
- Customer commitments

**SLA Targets**:
- ✅ Uptime: 99.9% (43 min downtime/month max)
- ✅ API Response Time: p95 <500ms
- ✅ MTTR: <30 minutes for Critical
- ✅ Error Rate: <0.1%

## Prometheus Alert Manager

**URL**: http://localhost:9090/alerts

**Purpose**: View current alerts and their status

### Alert States

| State | Meaning | Action |
|-------|---------|--------|
| **Inactive** | Alert condition not met | No action needed |
| **Pending** | Condition met but not for duration | Monitor |
| **Firing** | Alert actively triggering | Respond immediately |

### Current Alerts View

Shows:
- Active alerts (firing)
- Pending alerts (about to fire)
- Alert labels (severity, component, runbook)
- Alert values and thresholds
- Time alert started firing

**Quick Link**: http://localhost:9090/alerts

## Key Metrics Reference

### Critical Metrics to Watch

#### Service Health (Golden Signals)

```promql
# 1. Latency - Response time p95
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))

# 2. Traffic - Request rate
rate(http_requests_total[5m])

# 3. Errors - Error rate
rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m])

# 4. Saturation - Resource usage
(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))
```

#### Application Metrics

```promql
# API server uptime
up{job="api-server"}

# Discovery job success rate
rate(discovery_jobs_completed_total[10m]) / rate(discovery_jobs_total[10m])

# Database connection pool utilization
neo4j_connection_pool_total_used / neo4j_connection_pool_total_created

# Queue depth
queue_depth{queue="discovery:*"}
```

#### Database Metrics

```promql
# Neo4j query time p95
histogram_quantile(0.95, rate(neo4j_query_duration_seconds_bucket[5m]))

# PostgreSQL connection count
pg_stat_activity_count

# Redis memory usage
redis_memory_used_bytes / redis_memory_max_bytes

# Database uptime
up{job=~"neo4j|postgresql|redis"}
```

#### Infrastructure Metrics

```promql
# CPU usage
100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)

# Memory usage
(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))

# Disk usage
(1 - (node_filesystem_avail_bytes / node_filesystem_size_bytes))

# Network errors
rate(node_network_receive_errs_total[5m]) + rate(node_network_transmit_errs_total[5m])
```

## Dashboard Annotations

Grafana dashboards support annotations to mark deployments, incidents, and changes.

### Adding Annotations

1. In Grafana dashboard, click clock icon (top bar)
2. Select time range
3. Add description (e.g., "Deployed v2.1.0" or "INC-2025-10-19-001")
4. Add tags (deployment, incident, maintenance)
5. Save

### Viewing Annotations

Annotations appear as vertical lines on time-series graphs with descriptions on hover.

**Uses**:
- Correlate deployments with incidents
- Track incident timelines
- Document maintenance windows

## Custom Queries

### Prometheus Query Examples

Access Prometheus at: http://localhost:9090/graph

**Top 10 slowest API endpoints**:
```promql
topk(10,
  histogram_quantile(0.95,
    rate(http_request_duration_seconds_bucket[5m])
  ) by (endpoint)
)
```

**Error rate by endpoint**:
```promql
rate(http_requests_total{status=~"5.."}[5m])
  /
rate(http_requests_total[5m])
  by (endpoint) * 100
```

**Discovery jobs failing**:
```promql
increase(discovery_jobs_failed_total[1h]) by (connector)
```

**Database query time trend**:
```promql
avg(rate(database_query_duration_seconds_sum[5m]) /
    rate(database_query_duration_seconds_count[5m]))
  by (database)
```

**Container memory usage**:
```promql
container_memory_usage_bytes{container!=""}
  /
container_spec_memory_limit_bytes{container!=""}
  by (container) * 100
```

## Alert Queries

All active alerts can be queried via Prometheus API:

```bash
# Get all active alerts
curl -s http://localhost:9090/api/v1/alerts | jq '.data.alerts[] | select(.state=="firing")'

# Get alerts by severity
curl -s http://localhost:9090/api/v1/alerts | jq '.data.alerts[] | select(.labels.severity=="critical")'

# Get alerts by component
curl -s http://localhost:9090/api/v1/alerts | jq '.data.alerts[] | select(.labels.component=="api-server")'
```

## Mobile Access

### Grafana Mobile App

**Download**: iOS App Store / Google Play
**App Name**: Grafana

**Setup**:
1. Install Grafana mobile app
2. Add server: http://[server-ip]:3001
3. Login with credentials
4. Access dashboards on the go

**Limitations**: Some complex panels may not render well on mobile

### PagerDuty Mobile App

**Download**: iOS App Store / Google Play
**App Name**: PagerDuty

**Must-have for on-call**: Receive and acknowledge alerts on mobile

## Browser Extensions

### Recommended Extensions

**Chrome/Edge**:
- **Prometheus Query Builder**: Build Prometheus queries
- **JSON Viewer**: Format JSON responses
- **Grafana Image Renderer**: Better screenshot exports

**Firefox**:
- **Prometheus Query Builder**
- **JSONView**

## Dashboard Best Practices

### For On-Call Engineers

1. **Bookmark dashboards**: Save in browser for quick access
2. **Set time range**: Last 1 hour for active incidents, 24 hours for trends
3. **Use refresh**: Enable 30s auto-refresh during incidents
4. **Export graphs**: Take screenshots for incident reports
5. **Share links**: Include dashboard links in incident communications

### Reading Dashboards

**Colors**:
- 🟢 Green: Healthy, normal operation
- 🟡 Yellow: Warning, approaching threshold
- 🔴 Red: Critical, threshold exceeded
- ⚪ Gray: No data or service down

**Patterns to Recognize**:
- **Spikes**: Sudden increases (traffic surge, error spike)
- **Drops**: Sudden decreases (service outage)
- **Trends**: Gradual changes over time (resource growth)
- **Gaps**: Missing data (monitoring issue or service down)

## Troubleshooting Dashboards

### Dashboard Not Loading

```bash
# Check if Grafana is running
docker ps | grep grafana

# Check Grafana logs
docker logs grafana

# Restart Grafana
docker restart grafana
```

### No Data Showing

```bash
# Check if Prometheus is scraping
curl http://localhost:9090/api/v1/targets

# Check if metric exists
curl http://localhost:9090/api/v1/label/__name__/values | grep <metric_name>

# Check exporter is running
curl http://localhost:3000/metrics
```

### Slow Dashboard Loading

- Reduce time range (try last 1 hour instead of 24 hours)
- Increase refresh interval (30s → 1m)
- Simplify complex queries
- Archive old dashboards

## Dashboard Maintenance

### Ownership

| Dashboard | Owner | Review Frequency |
|-----------|-------|------------------|
| Overview | DevOps Lead | Weekly |
| API Performance | Backend Lead | Weekly |
| Database Performance | DBA | Weekly |
| Discovery Engine | Backend Lead | Weekly |
| Infrastructure | DevOps Lead | Daily |
| Security | Security Engineer | Daily |

### Dashboard Updates

**When to Update**:
- New services added
- New metrics available
- Alert thresholds change
- User feedback

**How to Update**:
1. Make changes in development environment
2. Test queries and panels
3. Export JSON
4. Import to production Grafana
5. Document changes in commit message

## Integration with Runbooks

Each alert in dashboards links to appropriate runbook:

**Format**: `runbook: <runbook-name>`

**Example**: Alert `APIServerDown` has annotation:
```yaml
runbook: api-server-down
```

Links to: `/docs/operations/runbooks/api-server-down.md`

## Metrics Retention

| System | Retention | Reason |
|--------|-----------|--------|
| **Prometheus** | 30 days | Recent operational data |
| **Grafana** | Dashboards retained indefinitely | Configuration only |
| **Logs** | 14 days | Compliance and troubleshooting |
| **Long-term metrics** | PostgreSQL data mart | Historical analysis |

**Note**: For historical analysis >30 days, query PostgreSQL data mart.

## External Monitoring

### Third-Party Monitoring Services

| Service | Purpose | URL |
|---------|---------|-----|
| **Pingdom** | External uptime monitoring | https://my.pingdom.com |
| **StatusCake** | Global availability checks | https://app.statuscake.com |
| **CloudWatch** (AWS) | AWS resource monitoring | https://console.aws.amazon.com/cloudwatch |

**Why External?** Detect issues even if internal monitoring is down.

## Quick Reference Card

Print and keep this handy:

```
╔═══════════════════════════════════════════════════════════╗
║         HAPPYCMDB MONITORING QUICK REFERENCE              ║
╠═══════════════════════════════════════════════════════════╣
║ GRAFANA:     http://localhost:3001                       ║
║ PROMETHEUS:  http://localhost:9090                       ║
║ API HEALTH:  http://localhost:3000/health                ║
║ ALERTS:      http://localhost:9090/alerts                ║
╠═══════════════════════════════════════════════════════════╣
║ KEY DASHBOARDS                                            ║
║ • Overview: /d/overview/happycmdb-overview             ║
║ • API Perf: /d/api-perf/api-performance                  ║
║ • Database: /d/db-perf/database-performance              ║
║ • Discovery:/d/discovery/discovery-engine                ║
╠═══════════════════════════════════════════════════════════╣
║ CRITICAL METRICS (HEALTHY VALUES)                        ║
║ • API p95: <500ms  • Error rate: <1%                     ║
║ • CPU: <70%        • Memory: <75%                        ║
║ • Discovery: >95%  • Uptime: 99.9%                       ║
╠═══════════════════════════════════════════════════════════╣
║ INCIDENT DASHBOARDS TO CHECK                             ║
║ 1. Overview (system status)                              ║
║ 2. Component-specific (failing service)                  ║
║ 3. Infrastructure (resource usage)                       ║
╚═══════════════════════════════════════════════════════════╝
```

---

**Pro Tip**: Create browser bookmark folder with all dashboard links for one-click access during incidents!
