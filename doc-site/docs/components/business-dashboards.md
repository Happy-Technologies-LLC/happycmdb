# Business Insights Dashboards

HappyCMDB v3.0 provides five specialized dashboards designed for different stakeholder personas. All dashboards use REST API endpoints for data retrieval, ensuring simplicity, performance, and maintainability.

## Architecture

### REST-First Design

The Business Insights dashboards use a **REST-based architecture** for the following reasons:

1. **Simplicity** - Single API pattern, consistent with all other UI pages
2. **Performance** - Optimized endpoints with database-level aggregations
3. **Caching** - Leverages HTTP caching and React Query's built-in cache management
4. **Debugging** - Standard HTTP tools (curl, Postman, browser DevTools)
5. **Consistency** - Same patterns as the main Dashboard, CI List, and other working pages

### Data Flow

```
┌─────────────────┐
│  Dashboard Page │
│  (React)        │
└────────┬────────┘
         │
         │ useQuery (React Query)
         ↓
┌────────────────────────┐
│ Dashboard Service      │
│ (dashboard.service.ts) │
└───────────┬────────────┘
            │
            │ HTTP GET
            ↓
┌────────────────────────────────┐
│ REST API                       │
│ GET /api/v1/dashboards/*       │
└───────────┬────────────────────┘
            │
            ↓
┌────────────────────────────┐
│ Dashboard Controller       │
│ (dashboard.controller.ts)  │
└───────────┬────────────────┘
            │
            ↓
┌────────────────────────────┐
│ Dashboard Service          │
│ (dashboard.service.ts)     │
│ - Aggregates from Neo4j    │
│ - Enriches with TBM/BSM    │
│ - Formats for frontend     │
└────────────────────────────┘
```

## Dashboard Endpoints

### Executive Dashboard
**Endpoint:** `GET /api/v1/dashboards/executive?days=30`

**Purpose:** Strategic overview of IT investment and business value

**Key Metrics:**
- Total IT spend by capability tower
- Cost trends over time (compute, storage, network, etc.)
- Service health by business criticality tier
- Risk matrix showing high-risk services
- Top cost drivers
- Value scorecard (ROI, revenue, customers)

**Data Sources:**
- TBM attributes (`monthly_cost`, `capability_tower`)
- BSM attributes (`business_criticality`, `customer_facing`)
- CI metadata and discovery provider

### CIO Dashboard
**Endpoint:** `GET /api/v1/dashboards/cio?days=30`

**Purpose:** Operational metrics for IT leadership

**Key Metrics:**
- Service availability by tier with SLA compliance
- Change success rates (successful, failed, rollbacks)
- Incident response times by priority (MTTR vs target)
- Configuration accuracy (CI drift detection)
- Cost by capability vs budget
- Capacity planning (compute, storage, network utilization)

**Data Sources:**
- ITIL attributes (`change_risk`, `sla_target`)
- BSM attributes (`business_criticality`)
- TBM attributes (`monthly_cost`)
- Configuration drift detection

### ITSM Dashboard
**Endpoint:** `GET /api/v1/dashboards/itsm`

**Purpose:** Day-to-day IT service management operations

**Key Metrics:**
- Open incidents by priority and status
- Changes in progress
- CI status breakdown (active, inactive, maintenance, decommissioned)
- Top failing CIs (by incident count and MTTR)
- SLA compliance by priority
- Configuration baseline compliance

**Data Sources:**
- ITIL incident and change records
- CI status from Neo4j
- Configuration baselines
- SLA targets

**Real-time Updates:** WebSocket integration for incident and change notifications (optional)

### FinOps Dashboard
**Endpoint:** `GET /api/v1/dashboards/finops?days=30`

**Purpose:** Financial operations and cost optimization

**Key Metrics:**
- Cloud costs by provider (AWS, Azure, GCP) with forecast
- On-premises vs cloud cost comparison
- Cost breakdown by TBM tower
- Budget variance by capability
- Unit economics (cost per user, cost per transaction)
- Cost optimization recommendations (rightsizing, etc.)

**Data Sources:**
- TBM attributes (`monthly_cost`, `capability_tower`, `sub_tower`)
- Discovery provider (aws, azure, gcp for cloud costs)
- Budget allocations

### Business Service Dashboard
**Endpoint:** `GET /api/v1/dashboards/business-service/:serviceId?`

**Purpose:** Business service health and impact analysis

**Key Metrics:**
- Service health by business unit
- Revenue at risk from incidents
- Customer impact estimation
- Compliance status (PCI, HIPAA, SOX, GDPR)
- Value stream health (bottleneck detection)
- Service dependency visualization

**Data Sources:**
- BSM attributes (`supports_business_services`, `customer_facing`, `compliance_scope`)
- Service relationship graph from Neo4j
- ITIL incident impact data

## Frontend Implementation

### React Query Hooks

All dashboards use custom hooks from `useDashboardData.ts`:

```typescript
// Executive Dashboard
const { data, loading, error, refetch } = useExecutiveDashboard(timeRange);

// CIO Dashboard
const { data, loading, error, refetch } = useCIODashboard(timeRange);

// ITSM Dashboard
const { incidents, changes, ciStatus, topFailing, slaCompliance, baselineCompliance } =
  useITSMDashboard();

// FinOps Dashboard
const { cloudCosts, onPremVsCloud, costByTower, budgetVariance, unitEconomics, costOptimization } =
  useFinOpsDashboard(timeRange);

// Business Service Dashboard
const { serviceHealth, revenueAtRisk, customerImpact, complianceStatus, valueStreamHealth, serviceDependencies } =
  useBusinessServiceDashboard(serviceId);
```

### Auto-Refresh

Dashboards automatically refresh at different intervals based on data criticality:

- **ITSM Dashboard:** 10 seconds (incidents and changes are time-sensitive)
- **Executive/CIO/Business Service:** 30 seconds (strategic metrics)
- **FinOps Dashboard:** 60 seconds (cost data changes less frequently)

### Time Range Selector

Most dashboards support time range selection:

```typescript
const { timeRange, updateTimeRange } = useTimeRange('30d');

// Available ranges: '7d', '30d', '90d', '1y'
```

## Backend Implementation

### Dashboard Service

Located at `packages/api-server/src/services/dashboard.service.ts`

**Responsibilities:**
1. Query Neo4j for CIs with TBM, ITIL, and BSM attributes
2. Aggregate data by capability tower, tier, provider, etc.
3. Calculate derived metrics (health scores, ROI, compliance percentages)
4. Format data for frontend consumption

**Key Methods:**
- `getExecutiveSummary(timeRange)` - Executive metrics
- `getCIOMetrics(timeRange)` - CIO operational metrics
- `getITSMDashboard()` - ITSM incident/change data
- `getFinOpsDashboard(timeRange)` - FinOps cost analysis
- `getBusinessServiceDashboard(serviceId?)` - Business service health

### Dashboard Controller

Located at `packages/api-server/src/rest/controllers/dashboard.controller.ts`

**Responsibilities:**
1. Parse query parameters (time range, service ID, filters)
2. Call dashboard service methods
3. Format HTTP responses with success/error handling
4. Log requests for monitoring

### Dashboard Routes

Located at `packages/api-server/src/rest/routes/dashboard.routes.ts`

All routes are prefixed with `/api/v1/dashboards`:

- `GET /executive?days=30`
- `GET /cio?days=30`
- `GET /itsm`
- `GET /finops?days=30`
- `GET /business-service/:serviceId?`

## Data Enrichment

Dashboards rely on enriched CI data from the discovery pipeline:

```
Discovery → ITIL Enricher → TBM Enricher → BSM Enricher → Neo4j
```

Each enricher adds framework-specific attributes:

**ITIL Attributes:**
- `change_risk`, `sla_target`, `maintenance_window`
- Incident and change relationship tracking

**TBM Attributes:**
- `monthly_cost`, `annual_cost`
- `capability_tower`, `sub_tower`
- Cost allocation pools

**BSM Attributes:**
- `business_criticality` (tier_1 through tier_4)
- `customer_facing` (boolean)
- `compliance_scope` (array of frameworks)
- `data_classification`
- `supports_business_services` (relationships)

## Performance Considerations

### Database Optimization

1. **Neo4j Indexes:**
   - Index on `CI.status` for active CI queries
   - Index on `CI.type` for filtering by CI type
   - Index on `CI.discovery_provider` for cloud cost aggregation

2. **Query Patterns:**
   - Single Cypher query fetches all CIs with attributes
   - In-memory aggregation for dashboard metrics
   - Relationship traversal for service dependencies

3. **Caching:**
   - React Query cache: 30-60 seconds stale time
   - HTTP caching headers (future enhancement)
   - PostgreSQL data mart for historical trends

### Scalability

Current implementation supports:
- **10,000+ CIs** - In-memory aggregation is performant
- **Real-time refresh** - 30-second intervals with React Query
- **Multiple concurrent users** - Stateless REST endpoints

For larger deployments (100,000+ CIs):
- Consider PostgreSQL data mart pre-aggregations
- Implement materialized views for complex metrics
- Add Redis caching layer

## Troubleshooting

### Dashboard Not Loading

**Symptom:** Dashboard shows loading spinner indefinitely

**Causes:**
1. API server not running
2. Network error (check browser DevTools Console)
3. Backend error (check API server logs)

**Solution:**
```bash
# Check API server health
curl http://localhost:3000/api/v1/cmdb-health

# Check dashboard endpoint
curl http://localhost:3000/api/v1/dashboards/executive?days=30

# Check API server logs
docker logs cmdb-api-server
```

### Empty Dashboard Data

**Symptom:** Dashboard loads but shows "No data available"

**Causes:**
1. No CIs discovered yet
2. Discovery hasn't enriched CIs with TBM/BSM/ITIL attributes
3. All CIs have `status: 'inactive'`

**Solution:**
```bash
# Check CI count in Neo4j
docker exec cmdb-neo4j cypher-shell -u neo4j -p your-neo4j-password \
  "MATCH (ci:CI) WHERE ci.status = 'active' RETURN count(ci)"

# Trigger discovery job
curl -X POST http://localhost:3000/api/v1/discovery/jobs \
  -H "Content-Type: application/json" \
  -d '{"connector_id": "aws", "enabled": true}'

# Verify enrichment
curl http://localhost:3000/api/v1/cis?limit=1 | jq '.data[0].tbm_attributes'
```

### Incorrect Cost Data

**Symptom:** Cost metrics show \$0 or unexpected values

**Causes:**
1. TBM enricher not running
2. CI metadata missing cost information
3. Currency conversion issue

**Solution:**
- Verify TBM attributes exist on CIs
- Check discovery connector provides cost metadata
- Review TBM enricher logs

## Future Enhancements

### Planned Features

1. **PDF/Excel Export** - Generate downloadable reports
2. **Dashboard Customization** - User-configurable widgets
3. **Alerts and Thresholds** - Email/Slack notifications
4. **Historical Trending** - Time-series visualization
5. **Drill-down Navigation** - Click metrics to view details
6. **Role-based Views** - Custom dashboards per user role

### Integration Opportunities

1. **ITSM Platform Integration** - Sync with ServiceNow, Jira
2. **FinOps Tools** - CloudHealth, Apptio integration
3. **Monitoring Systems** - Datadog, New Relic metrics
4. **Business Intelligence** - Metabase, Tableau connectors

## Related Documentation

- [TBM Cost Engine](/components/tbm-cost-engine)
- [BSM Impact Analysis](/components/bsm-impact-analysis)
- [ITIL Service Manager](/components/itil-service-manager)
- [Discovery Engine](/components/discovery-engine)
- [REST API Reference](/api/rest)
