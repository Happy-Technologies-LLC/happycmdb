# Connector Data Classification

This document classifies HappyCMDB connectors by the **type of data** they provide, enabling proper routing, processing, and storage of discovered information.

## Data Type Categories

### 1. Infrastructure Data (`infrastructure`)

**Purpose**: Discover and sync Configuration Items (CIs) - the physical and virtual resources that make up your IT infrastructure.

**Target Storage**: Neo4j graph database (primary), PostgreSQL data mart (analytics)

**Common Resources**:
- Virtual machines, servers, containers
- Databases, storage volumes
- Network devices, load balancers
- Applications, services
- Cloud resources (EC2, Azure VMs, GCP Compute)

**Connectors** (26 total):
- **Cloud**: `aws`, `azure`, `gcp`, `oracle-cloud`, `alibaba-cloud`
- **Virtualization**: `vmware-vsphere`, `nutanix`, `hyper-v`, `proxmox`
- **Container**: `kubernetes`, `docker`, `openshift`, `rancher`, `nomad`
- **Network**: `cisco`, `juniper`, `palo-alto`, `infoblox`, `f5-bigip`
- **Storage**: `netapp`, `dell-emc`, `pure-storage`
- **Endpoint**: `jamf`, `intune`, `tanium`, `lansweeper`, `crowdstrike`

**Example Resource Definition**:
```json
{
  "id": "ec2-instance",
  "name": "EC2 Instance",
  "type": "virtual-machine",
  "data_type": "infrastructure",
  "description": "AWS EC2 virtual machine instances",
  "field_mappings": {
    "name": "Tags.Name",
    "external_id": "InstanceId",
    "status": "State.Name",
    "ip_address": "PrivateIpAddress"
  }
}
```

---

### 2. Financial Data (`financial`)

**Purpose**: Collect cost, billing, and license information for Technology Business Management (TBM) and FinOps.

**Target Storage**: PostgreSQL data mart (`tbm_cost_pools`, `fact_cost`, `dim_licenses`)

**Common Resources**:
- Cloud provider billing (AWS Cost & Usage Report, Azure Cost Management, GCP Billing Export)
- License inventory and costs
- Allocated budgets and forecasts
- Unit economics (cost per transaction, per user, per GB)

**Connectors** (8 total):
- **Cloud Billing**: `aws-cost-explorer`, `azure-cost-management`, `gcp-billing`
- **License Management**: `flexera`, `snow-software`, `servicenow-sam`
- **Procurement**: `coupa`, `ariba`

**Example Resource Definition**:
```json
{
  "id": "aws-cost-usage",
  "name": "AWS Cost & Usage",
  "type": "cost-record",
  "data_type": "financial",
  "description": "Hourly/daily cost and usage data from AWS Cost Explorer",
  "field_mappings": {
    "line_item_resource_id": "ResourceId",
    "line_item_usage_amount": "UsageAmount",
    "line_item_unblended_cost": "UnblendedCost",
    "line_item_usage_type": "UsageType",
    "product_service_code": "ServiceCode",
    "bill_billing_period_start": "BillingPeriodStart"
  },
  "target_table": "tbm_cost_pools"
}
```

---

### 3. ITIL Data (`itil`)

**Purpose**: Sync IT Service Management (ITSM) data - incidents, changes, problems, service requests - to enable service health tracking and SLA monitoring.

**Target Storage**: PostgreSQL data mart (`fact_incidents`, `fact_changes`, `fact_problems`, `fact_service_requests`)

**Common Resources**:
- Incidents (P1-P5 priority tickets)
- Change requests (planned modifications)
- Problems (root cause investigations)
- Service requests (standard requests)
- SLA tracking (response time, resolution time)

**Connectors** (5 total):
- **ITSM Platforms**: `servicenow-itsm`, `jira-service-management`, `bmc-remedy`
- **Ticketing**: `freshservice`, `zendesk`

**Example Resource Definition**:
```json
{
  "id": "incidents",
  "name": "Incidents",
  "type": "incident",
  "data_type": "itil",
  "description": "Active and historical incidents from ServiceNow",
  "field_mappings": {
    "number": "number",
    "short_description": "short_description",
    "priority": "priority",
    "state": "state",
    "assigned_to": "assigned_to.display_value",
    "affected_ci": "cmdb_ci.display_value",
    "opened_at": "opened_at",
    "resolved_at": "resolved_at",
    "close_code": "close_code"
  },
  "target_table": "fact_incidents"
}
```

---

### 4. Performance Data (`performance`)

**Purpose**: Collect metrics, logs, and performance data for capacity planning, anomaly detection, and SLO tracking.

**Target Storage**: Time-series database (InfluxDB, Prometheus) or PostgreSQL with TimescaleDB

**Common Resources**:
- Infrastructure metrics (CPU, memory, disk, network)
- Application performance (response time, error rate, throughput)
- Synthetic monitoring (uptime, availability)
- Log aggregation (errors, warnings, events)

**Connectors** (6 total):
- **APM**: `datadog`, `dynatrace`, `new-relic`, `app-dynamics`
- **Monitoring**: `prometheus`, `grafana-cloud`

**Example Resource Definition**:
```json
{
  "id": "host-metrics",
  "name": "Host Metrics",
  "type": "metric-series",
  "data_type": "performance",
  "description": "CPU, memory, disk, network metrics from Datadog",
  "field_mappings": {
    "host_name": "host",
    "metric_name": "metric",
    "timestamp": "timestamp",
    "value": "value",
    "tags": "tags"
  },
  "aggregation": "5m"
}
```

---

### 5. Security Data (`security`)

**Purpose**: Collect security posture, vulnerabilities, compliance findings, and access control information.

**Target Storage**: PostgreSQL data mart (`fact_vulnerabilities`, `fact_compliance`, `dim_access_policies`)

**Common Resources**:
- Vulnerability scans (CVEs, severity, remediation)
- Compliance findings (CIS benchmarks, NIST, SOC2)
- Access policies (IAM roles, permissions)
- Security events (alerts, detections, incidents)

**Connectors** (7 total):
- **Vulnerability Management**: `qualys`, `tenable`, `rapid7`
- **Cloud Security**: `prisma-cloud`, `wiz`, `lacework`
- **Compliance**: `vanta`

**Example Resource Definition**:
```json
{
  "id": "vulnerabilities",
  "name": "Vulnerabilities",
  "type": "vulnerability",
  "data_type": "security",
  "description": "Active vulnerabilities from Prisma Cloud",
  "field_mappings": {
    "cve_id": "cveId",
    "severity": "severity",
    "cvss_score": "cvssScore",
    "affected_resource_id": "resourceId",
    "affected_resource_type": "resourceType",
    "discovered_at": "discoveredAt",
    "status": "status"
  },
  "target_table": "fact_vulnerabilities"
}
```

---

### 6. Business Service Data (`business_service`)

**Purpose**: Define and manage business services - the logical groupings of CIs that deliver business value.

**Target Storage**: Neo4j (relationships: CIs → Services), PostgreSQL data mart (`dim_business_services`)

**Common Resources**:
- Business service definitions (name, owner, criticality)
- Service dependencies (service A depends on service B)
- Service mappings (which CIs support which services)
- Service catalogs

**Connectors** (3 total):
- **Service Catalogs**: `servicenow-service-catalog`, `bmc-atrium`
- **BSM Tools**: `bmc-true-sight`

**Example Resource Definition**:
```json
{
  "id": "business-services",
  "name": "Business Services",
  "type": "business-service",
  "data_type": "business_service",
  "description": "Business service definitions from ServiceNow",
  "field_mappings": {
    "name": "name",
    "description": "description",
    "service_owner": "owned_by.display_value",
    "business_criticality": "business_criticality",
    "revenue_impact": "u_revenue_impact",
    "service_tier": "u_service_tier"
  }
}
```

---

## Connector Category Mapping

Each connector has a `connector_category` field that maps to primary data type:

| Connector Category | Primary Data Type | Examples |
|-------------------|------------------|----------|
| `cloud` | `infrastructure` | AWS, Azure, GCP, Oracle Cloud |
| `virtualization` | `infrastructure` | VMware, Nutanix, Hyper-V |
| `container` | `infrastructure` | Kubernetes, Docker, OpenShift |
| `network` | `infrastructure` | Cisco, Juniper, Palo Alto |
| `endpoint` | `infrastructure` | Jamf, Intune, Tanium |
| `itsm` | `infrastructure` + `itil` | ServiceNow, Jira, BMC Remedy |
| `apm` | `performance` | Datadog, Dynatrace, New Relic |
| `security` | `security` | Prisma Cloud, Wiz, Qualys |
| `financial` | `financial` | AWS Cost Explorer, Flexera |

**Note**: Some connectors support **multiple data types**. For example:
- **ServiceNow**: Infrastructure (CMDB), ITIL (incidents/changes), Business Services, Financial (SAM)
- **AWS**: Infrastructure (EC2, RDS, S3), Financial (Cost Explorer, Cost & Usage Reports)

---

## Multi-Type Connector Example

### ServiceNow (Infrastructure + ITIL + Financial)

```json
{
  "id": "servicenow",
  "connector_category": "itsm",
  "data_types": ["infrastructure", "itil", "business_service", "financial"],
  "resources": [
    {
      "id": "cmdb-servers",
      "data_type": "infrastructure",
      "target_storage": "neo4j"
    },
    {
      "id": "incidents",
      "data_type": "itil",
      "target_storage": "postgresql:fact_incidents"
    },
    {
      "id": "business-services",
      "data_type": "business_service",
      "target_storage": "neo4j+postgresql"
    },
    {
      "id": "software-licenses",
      "data_type": "financial",
      "target_storage": "postgresql:dim_licenses"
    }
  ]
}
```

---

## Data Flow by Type

### Infrastructure Data Flow
```
Connector → Discovery Engine → Neo4j (CIs + Relationships)
                             → ETL Processor → PostgreSQL (dim_ci)
```

### Financial Data Flow
```
Connector → Discovery Engine → PostgreSQL (tbm_cost_pools, fact_cost)
                             → Kafka (cost-events topic)
                             → Cost Allocation Engine
```

### ITIL Data Flow
```
Connector → Discovery Engine → PostgreSQL (fact_incidents, fact_changes)
                             → Kafka (itil-events topic)
                             → SLA Tracker
```

### Performance Data Flow
```
Connector → Discovery Engine → InfluxDB/TimescaleDB (metrics)
                             → Kafka (metric-events topic)
                             → Anomaly Detection Engine
```

### Security Data Flow
```
Connector → Discovery Engine → PostgreSQL (fact_vulnerabilities)
                             → Kafka (security-events topic)
                             → Compliance Dashboard
```

---

## Connector Implementation Checklist

When creating a new connector, specify its data types:

1. **Add `data_types` array** to `connector.json`:
   ```json
   {
     "id": "my-connector",
     "data_types": ["infrastructure", "financial"]
   }
   ```

2. **Mark each resource with `data_type`**:
   ```json
   {
     "resources": [
       {"id": "vms", "data_type": "infrastructure"},
       {"id": "costs", "data_type": "financial"}
     ]
   }
   ```

3. **Specify target storage**:
   ```json
   {
     "id": "costs",
     "data_type": "financial",
     "target_storage": "postgresql:tbm_cost_pools"
   }
   ```

4. **Implement type-specific processing**:
   - Infrastructure → Graph database persistence
   - Financial → Cost pool allocation
   - ITIL → SLA calculation
   - Performance → Time-series aggregation
   - Security → Compliance scoring

---

## Benefits of Data Classification

1. **Routing**: Automatically route data to correct storage backend
2. **Processing**: Apply type-specific transformations (cost allocation, SLA tracking)
3. **Querying**: Optimize queries based on data type (graph traversal vs. time-series)
4. **Dashboards**: Auto-generate dashboards based on available data types
5. **Alerting**: Configure alerts appropriate to data type (cost anomalies, SLA breaches)

---

## See Also

- `/packages/connectors/README.md` - Connector development guide
- `/doc-site/docs/architecture/connector-framework.md` - Connector architecture
- `/doc-site/docs/components/connector-registry.md` - Managing connectors

---

**Version**: 3.0
**Last Updated**: November 2025
**Audience**: Connector Developers, Platform Engineers
