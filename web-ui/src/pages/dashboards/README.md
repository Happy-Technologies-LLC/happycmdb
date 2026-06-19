# HappyCMDB v3.0 Multi-Stakeholder Dashboards

This directory contains 5 comprehensive dashboards tailored for different stakeholder personas.

## Dashboards

### 1. Executive Dashboard (`/dashboards/executive`)
**Target Audience**: CEO, CFO, Executive Leadership

**Features**:
- Total IT Spend by Business Capability (Treemap)
- Cost Trends (12-month view with budget variance)
- Service Health Scores (by tier)
- Risk Exposure Matrix
- Top 5 Cost Drivers
- Value Scorecard (ROI analysis)

**Key Metrics**:
- Total IT spend
- Overall health score
- High-risk services
- Average ROI

### 2. CIO Dashboard (`/dashboards/cio`)
**Target Audience**: CIO, IT Director, Head of IT

**Features**:
- Service Availability by Tier (with SLA compliance)
- Change Success Rates (pie chart)
- Incident Response Times (MTTR by priority)
- Configuration Accuracy
- Cost by Business Capability
- Capacity Planning (utilization trends + 3-month forecast)

**Key Metrics**:
- Average availability
- Change success rate
- Config accuracy
- Total IT budget

### 3. ITSM Dashboard (`/dashboards/itsm`)
**Target Audience**: IT Service Manager, Service Desk Manager

**Features**:
- Open Incidents Table (real-time, filterable)
- Changes in Progress (Kanban board)
- CI Status Overview (grid view)
- Top Failing CIs
- SLA Compliance (by priority)
- Baseline Compliance (drift detection)

**Key Metrics**:
- Open incidents
- In-progress incidents
- Active CIs
- Changes in progress

**Real-time Updates**: Auto-refreshes every 10 seconds for incidents/changes

### 4. FinOps Dashboard (`/dashboards/finops`)
**Target Audience**: FinOps Team, Finance, Cost Optimization

**Features**:
- Cloud Spend by Provider (AWS/Azure/GCP)
- On-Prem vs Cloud Comparison
- Cost Allocation by Tower (treemap)
- Budget Variance (waterfall chart)
- Unit Economics (cost per transaction, user, GB, API call)
- Cost Optimization Recommendations

**Key Metrics**:
- Total cloud spend
- Monthly average (with trend)
- Total IT cost
- Potential savings

### 5. Business Service Dashboard (`/dashboards/business-service`)
**Target Audience**: Business Service Owners, Product Managers

**Features**:
- Service Health Heat Map (by business unit)
- Revenue at Risk
- Customer Impact
- Compliance Status (PCI, HIPAA, SOX, GDPR)
- Value Stream Health (flow diagram)
- Dependency Map (interactive graph with Cytoscape)

**Key Metrics**:
- Revenue at risk
- Customers impacted
- Estimated user impact
- Compliance score

## Common Features

All dashboards support:
- ✅ Export to PDF
- ✅ Export to Excel
- ✅ Auto-refresh (30 seconds default, 10 seconds for ITSM)
- ✅ Time range selector
- ✅ Drill-down capability
- ✅ Responsive design (desktop/tablet/mobile)
- ✅ Dark mode support
- ✅ Loading states and error handling

## Technology Stack

- **React 18** with TypeScript
- **Apollo Client** for GraphQL
- **Recharts** for charts
- **React Query** for data fetching
- **Cytoscape** for network diagrams (Business Service Dashboard)
- **Tailwind CSS** for styling
- **Radix UI** for components

## Usage

```typescript
// Navigate to dashboards
import { useNavigate } from 'react-router-dom';

const navigate = useNavigate();
navigate('/dashboards/executive'); // Executive Dashboard
navigate('/dashboards/cio');       // CIO Dashboard
navigate('/dashboards/itsm');      // ITSM Dashboard
navigate('/dashboards/finops');    // FinOps Dashboard
navigate('/dashboards/business-service'); // Business Service Dashboard
```

## Data Sources

All dashboards use GraphQL queries defined in:
```
/home/user/happycmdb/web-ui/src/graphql/queries/dashboard.queries.ts
```

Custom hooks for data fetching:
```
/home/user/happycmdb/web-ui/src/hooks/useDashboardData.ts
```

## Shared Components

Reusable dashboard components in:
```
/home/user/happycmdb/web-ui/src/components/dashboard/
```

- `KPICard` - Key Performance Indicator card
- `CostTrendChart` - Line/area chart for cost trends
- `ServiceHealthChart` - Health score over time with incident markers
- `RiskMatrix` - 4x4 risk matrix (criticality × risk level)
- `IncidentTable` - Filterable incident table
- `CostBreakdownChart` - Treemap or pie chart for cost breakdown

## Performance

- Initial load: < 2 seconds
- Auto-refresh: Every 30 seconds (configurable per dashboard)
- Real-time subscriptions: ITSM dashboard for incidents/changes
- Optimized queries with pagination and filtering

## Accessibility

- WCAG 2.1 AA compliant
- Keyboard navigation
- Screen reader support
- High contrast mode support
- Focus indicators

## Testing

Unit tests:
```bash
npm test -- --grep="Dashboard"
```

Integration tests:
```bash
npm run test:integration
```
