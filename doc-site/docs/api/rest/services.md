# ITIL Service Management API Reference

This document describes the REST API endpoints for HappyCMDB v3.0's ITIL v4 Service Management features, including incident management, change control, and configuration baselines.

## Overview

The ITIL Service Management API provides endpoints for:

1. **Incident Management** - Track and resolve IT service disruptions
2. **Change Management** - Plan, approve, and implement configuration changes
3. **Configuration Baselines** - Capture and compare known-good CI configurations
4. **Configuration Item Audits** - Verify CI accuracy and compliance
5. **ITSM Metrics** - MTTR, MTBF, change success rates, and configuration accuracy

All ITIL endpoints require authentication and automatically create audit trail entries.

## Base URL

```
http://localhost:3000/api/v1/itil
```

::: warning ITIL Routes Status
As of v3.0, ITIL routes are commented out in `api-server/src/rest/server.ts:93`. To enable ITIL functionality, uncomment the line:
```typescript
this.app.use('/api/v1/itil', itilRoutes);
```
:::

## Authentication

All ITIL endpoints require JWT authentication with `itil:read` or `itil:write` permissions.

```http
POST /api/v1/itil/incidents
Authorization: Bearer <jwt_token>
```

See [Authentication Guide](/api/authentication) for details.

---

## Incident Management

### POST /incidents

Create a new incident for an affected Configuration Item.

**Request Body:**

```json
{
  "affectedCIId": "srv-web-prod-01",
  "description": "Database connection pool exhausted, web application returning 503 errors",
  "reportedBy": "john.doe@company.com",
  "symptoms": [
    "HTTP 503 Service Unavailable",
    "Database connection timeout after 30s",
    "Application logs show pool size exceeded"
  ],
  "detectedAt": "2025-11-17T08:15:00Z"
}
```

**Validation Rules:**

| Field | Required | Constraints |
|-------|----------|-------------|
| `affectedCIId` | Yes | Must be valid CI ID in CMDB |
| `description` | Yes | Minimum 10 characters |
| `reportedBy` | Yes | Email or username |
| `symptoms` | No | Array of strings |
| `detectedAt` | No | ISO 8601 timestamp (defaults to now) |

**Response:**

```json
{
  "success": true,
  "incident": {
    "id": "INC0012345",
    "affectedCIId": "srv-web-prod-01",
    "description": "Database connection pool exhausted...",
    "priority": 2,
    "status": "NEW",
    "reportedBy": "john.doe@company.com",
    "createdAt": "2025-11-17T08:15:00Z",
    "updatedAt": "2025-11-17T08:15:00Z"
  }
}
```

**Auto-Calculated Priority:**

Incident priority (1-5, where 1 = critical) is automatically calculated based on:
- Affected CI's business criticality (`bsm_attributes.business_criticality`)
- Customer-facing status (`bsm_attributes.customer_facing`)
- Number of dependent services

---

### GET /incidents

List all incidents with optional filtering.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | - | Filter by status (NEW, ASSIGNED, IN_PROGRESS, RESOLVED, CLOSED) |
| `priority` | number | - | Filter by priority (1-5) |
| `affectedCIId` | string | - | Filter by affected CI ID |
| `page` | number | 1 | Page number |
| `limit` | number | 50 | Results per page (max 1000) |

**Example Request:**

```bash
curl -X GET "http://localhost:3000/api/v1/itil/incidents?status=IN_PROGRESS&priority=1&page=1&limit=20" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**Response:**

```json
{
  "success": true,
  "incidents": [
    {
      "id": "INC0012345",
      "affectedCIId": "srv-web-prod-01",
      "description": "Database connection pool exhausted...",
      "priority": 1,
      "status": "IN_PROGRESS",
      "assignedTo": "sre-team@company.com",
      "reportedBy": "john.doe@company.com",
      "createdAt": "2025-11-17T08:15:00Z",
      "updatedAt": "2025-11-17T08:45:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 42,
    "totalPages": 3
  }
}
```

---

### GET /incidents/:id

Get a specific incident by ID.

**Response:**

```json
{
  "success": true,
  "incident": {
    "id": "INC0012345",
    "affectedCIId": "srv-web-prod-01",
    "affectedCIName": "Production Web Server 01",
    "affectedCIType": "virtual-machine",
    "description": "Database connection pool exhausted...",
    "priority": 1,
    "status": "IN_PROGRESS",
    "assignedTo": "sre-team@company.com",
    "reportedBy": "john.doe@company.com",
    "symptoms": ["HTTP 503", "Connection timeout"],
    "detectedAt": "2025-11-17T08:15:00Z",
    "createdAt": "2025-11-17T08:15:00Z",
    "updatedAt": "2025-11-17T08:45:00Z",
    "age": 120
  }
}
```

---

### PATCH /incidents/:id

Update an incident's status or assignment.

**Request Body:**

```json
{
  "status": "IN_PROGRESS",
  "assignedTo": "sre-team@company.com",
  "priority": 1
}
```

**Allowed Status Transitions:**

| From | To |
|------|-----|
| NEW | ASSIGNED, CLOSED |
| ASSIGNED | IN_PROGRESS, CLOSED |
| IN_PROGRESS | RESOLVED, CLOSED |
| RESOLVED | CLOSED, IN_PROGRESS (reopen) |

**Response:**

```json
{
  "success": true,
  "incident": {
    "id": "INC0012345",
    "status": "IN_PROGRESS",
    "assignedTo": "sre-team@company.com",
    "updatedAt": "2025-11-17T08:45:00Z"
  }
}
```

---

### POST /incidents/:id/resolve

Mark an incident as resolved with resolution notes.

**Request Body:**

```json
{
  "resolution": "Increased database connection pool size from 50 to 100. Restarted application servers. Monitoring shows stable connection pool usage at 60-70%.",
  "resolvedBy": "jane.smith@company.com"
}
```

**Validation:**

- `resolution`: Minimum 10 characters
- `resolvedBy`: Required (email or username)

**Response:**

```json
{
  "success": true,
  "incident": {
    "id": "INC0012345",
    "status": "RESOLVED",
    "resolution": "Increased database connection pool size...",
    "resolvedBy": "jane.smith@company.com",
    "resolvedAt": "2025-11-17T10:30:00Z",
    "mttr": 135
  }
}
```

**MTTR Calculation:**

Mean Time To Repair (in minutes) = `resolvedAt - detectedAt`

---

### GET /incidents/:id/priority

Get AI-calculated priority for an incident based on affected CI impact.

**Response:**

```json
{
  "success": true,
  "priority": {
    "calculatedPriority": 1,
    "reason": "Tier 0 business service",
    "factors": {
      "businessCriticality": "tier_0",
      "customerFacing": true,
      "dependentServices": 12,
      "revenueImpact": "high"
    }
  }
}
```

---

## Change Management

### POST /changes

Create a new change request.

**Request Body:**

```json
{
  "changeType": "NORMAL",
  "description": "Upgrade Kubernetes cluster from v1.27 to v1.28",
  "affectedCIIds": [
    "k8s-prod-master-01",
    "k8s-prod-master-02",
    "k8s-prod-master-03",
    "k8s-prod-worker-01",
    "k8s-prod-worker-02"
  ],
  "requestedBy": "platform-engineering@company.com",
  "plannedStart": "2025-11-20T02:00:00Z",
  "plannedDuration": 180,
  "implementationPlan": "1. Drain worker nodes\n2. Upgrade master nodes sequentially\n3. Upgrade worker nodes\n4. Validate cluster health\n5. Re-enable workloads",
  "backoutPlan": "Roll back to v1.27 using etcd snapshot backup",
  "testPlan": "Deploy canary application, verify pod scheduling, test networking"
}
```

**Change Types:**

| Type | Approval Required | Use Case |
|------|-------------------|----------|
| STANDARD | No | Pre-approved changes (e.g., daily backups) |
| NORMAL | Yes | Planned changes requiring CAB approval |
| EMERGENCY | Expedited | Critical fixes during outages |

**Validation Rules:**

| Field | Required | Constraints |
|-------|----------|-------------|
| `changeType` | Yes | STANDARD, NORMAL, EMERGENCY |
| `description` | Yes | Minimum 10 characters |
| `affectedCIIds` | Yes | Array of CI IDs (at least 1) |
| `plannedStart` | Yes | ISO 8601 timestamp (future date) |
| `plannedDuration` | Yes | Duration in minutes |
| `implementationPlan` | Yes | Minimum 50 characters |
| `backoutPlan` | No | Recommended for NORMAL and EMERGENCY |
| `testPlan` | No | Recommended for all changes |

**Response:**

```json
{
  "success": true,
  "change": {
    "id": "CHG0009876",
    "changeType": "NORMAL",
    "status": "REQUESTED",
    "riskScore": 7.5,
    "riskLevel": "MEDIUM",
    "description": "Upgrade Kubernetes cluster...",
    "affectedCIIds": ["k8s-prod-master-01", "..."],
    "plannedStart": "2025-11-20T02:00:00Z",
    "plannedDuration": 180,
    "requestedBy": "platform-engineering@company.com",
    "createdAt": "2025-11-17T10:00:00Z"
  }
}
```

**Auto-Calculated Risk Score:**

Risk score (0-10) is calculated based on:
- Number of affected CIs
- Business criticality of affected CIs
- Change type (EMERGENCY = higher risk)
- Time window (off-hours = lower risk)

---

### GET /changes

List all changes with optional filtering.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | - | REQUESTED, APPROVED, SCHEDULED, IN_PROGRESS, IMPLEMENTED, CLOSED, CANCELLED |
| `changeType` | string | - | STANDARD, NORMAL, EMERGENCY |
| `page` | number | 1 | Page number |
| `limit` | number | 50 | Results per page (max 1000) |

---

### GET /changes/:id

Get a specific change by ID.

**Response:**

```json
{
  "success": true,
  "change": {
    "id": "CHG0009876",
    "changeType": "NORMAL",
    "status": "APPROVED",
    "riskScore": 7.5,
    "riskLevel": "MEDIUM",
    "description": "Upgrade Kubernetes cluster...",
    "affectedCIIds": ["k8s-prod-master-01", "..."],
    "affectedCIs": [
      {
        "ci_id": "k8s-prod-master-01",
        "ci_name": "Kubernetes Master Node 01",
        "ci_type": "virtual-machine",
        "criticality": "tier_0"
      }
    ],
    "plannedStart": "2025-11-20T02:00:00Z",
    "plannedDuration": 180,
    "implementationPlan": "1. Drain worker nodes...",
    "backoutPlan": "Roll back to v1.27...",
    "testPlan": "Deploy canary application...",
    "requestedBy": "platform-engineering@company.com",
    "approvedBy": "change-advisory-board@company.com",
    "approvedAt": "2025-11-18T14:30:00Z",
    "createdAt": "2025-11-17T10:00:00Z"
  }
}
```

---

### GET /changes/:id/risk-assessment

Get detailed risk assessment for a change.

**Response:**

```json
{
  "success": true,
  "riskAssessment": {
    "overallRisk": 7.5,
    "riskLevel": "MEDIUM",
    "factors": {
      "affectedCICount": 5,
      "tier0CIs": 3,
      "tier1CIs": 2,
      "customerFacing": true,
      "changeWindow": "off_hours",
      "changeType": "NORMAL"
    },
    "recommendations": [
      "Consider splitting change into smaller increments",
      "Ensure backout plan is tested",
      "Schedule during maintenance window with customer notification"
    ]
  }
}
```

---

### POST /changes/:id/approve

Approve a change request (requires `itil:approve` permission).

**Response:**

```json
{
  "success": true,
  "change": {
    "id": "CHG0009876",
    "status": "APPROVED",
    "approvedBy": "cab@company.com",
    "approvedAt": "2025-11-18T14:30:00Z"
  }
}
```

---

### POST /changes/:id/implement

Mark a change as being implemented.

**Response:**

```json
{
  "success": true,
  "change": {
    "id": "CHG0009876",
    "status": "IN_PROGRESS",
    "actualStart": "2025-11-20T02:00:00Z"
  }
}
```

---

### POST /changes/:id/close

Close a change with success/failure result.

**Request Body:**

```json
{
  "result": "SUCCESS",
  "notes": "All 5 nodes upgraded successfully. Cluster health checks passed. Workloads running normally.",
  "closedBy": "platform-engineering@company.com"
}
```

**Result Values:**

| Result | Description |
|--------|-------------|
| SUCCESS | Change completed as planned |
| PARTIAL_SUCCESS | Change completed with minor issues |
| FAILED | Change failed, backout plan executed |
| ROLLED_BACK | Change rolled back due to issues |

**Response:**

```json
{
  "success": true,
  "change": {
    "id": "CHG0009876",
    "status": "CLOSED",
    "result": "SUCCESS",
    "actualDuration": 165,
    "closedBy": "platform-engineering@company.com",
    "closedAt": "2025-11-20T04:45:00Z"
  }
}
```

---

## Configuration Baselines

### POST /baselines

Create a configuration baseline for one or more CIs.

**Request Body:**

```json
{
  "name": "Production Web Tier - Pre-Upgrade",
  "ciIds": [
    "srv-web-prod-01",
    "srv-web-prod-02",
    "srv-web-prod-03"
  ],
  "description": "Baseline before upgrading from Ubuntu 20.04 to 22.04",
  "createdBy": "ops-team@company.com"
}
```

**Response:**

```json
{
  "success": true,
  "baseline": {
    "id": "BL-20251117-001",
    "name": "Production Web Tier - Pre-Upgrade",
    "ciCount": 3,
    "description": "Baseline before upgrading...",
    "createdBy": "ops-team@company.com",
    "createdAt": "2025-11-17T12:00:00Z"
  }
}
```

---

### GET /baselines

List all configuration baselines.

**Response:**

```json
{
  "success": true,
  "baselines": [
    {
      "id": "BL-20251117-001",
      "name": "Production Web Tier - Pre-Upgrade",
      "ciCount": 3,
      "createdBy": "ops-team@company.com",
      "createdAt": "2025-11-17T12:00:00Z"
    }
  ]
}
```

---

### GET /baselines/:id

Get a specific baseline with captured CI configurations.

**Response:**

```json
{
  "success": true,
  "baseline": {
    "id": "BL-20251117-001",
    "name": "Production Web Tier - Pre-Upgrade",
    "ciCount": 3,
    "configurations": [
      {
        "ci_id": "srv-web-prod-01",
        "ci_name": "Production Web Server 01",
        "snapshot": {
          "ci_type": "virtual-machine",
          "status": "active",
          "environment": "production",
          "hostname": "web-prod-01.company.com",
          "ip_address": "10.0.1.10",
          "os_name": "Ubuntu",
          "os_version": "20.04",
          "cpu_count": 4,
          "memory_gb": 16
        }
      }
    ],
    "createdBy": "ops-team@company.com",
    "createdAt": "2025-11-17T12:00:00Z"
  }
}
```

---

### DELETE /baselines/:id

Delete a baseline.

**Response:**

```json
{
  "success": true,
  "message": "Baseline BL-20251117-001 deleted"
}
```

---

### GET /baselines/:id/comparison

Compare current CI state with baseline.

**Response:**

```json
{
  "success": true,
  "comparison": {
    "baselineId": "BL-20251117-001",
    "comparisonDate": "2025-11-20T10:00:00Z",
    "driftDetected": true,
    "ciComparisons": [
      {
        "ci_id": "srv-web-prod-01",
        "drifted": true,
        "changes": [
          {
            "attribute": "os_version",
            "baseline": "20.04",
            "current": "22.04",
            "severity": "medium"
          },
          {
            "attribute": "kernel_version",
            "baseline": "5.4.0-42",
            "current": "5.15.0-56",
            "severity": "low"
          }
        ]
      }
    ]
  }
}
```

---

### POST /baselines/:id/restore

Restore a CI to a baseline configuration.

**Request Body:**

```json
{
  "ciId": "srv-web-prod-01",
  "restoreAttributes": ["ip_address", "hostname", "environment"],
  "performedBy": "ops-team@company.com"
}
```

::: danger Destructive Operation
Baseline restoration updates CI attributes in Neo4j. This does NOT modify the actual infrastructure - it only updates the CMDB representation. Use with caution.
:::

**Response:**

```json
{
  "success": true,
  "restored": {
    "ci_id": "srv-web-prod-01",
    "attributesRestored": 3,
    "changes": [
      {
        "attribute": "hostname",
        "old": "web-prod-01-new.company.com",
        "new": "web-prod-01.company.com"
      }
    ],
    "performedBy": "ops-team@company.com",
    "restoredAt": "2025-11-20T10:15:00Z"
  }
}
```

---

## ITSM Metrics

### GET /metrics/configuration-accuracy

Get CMDB configuration accuracy metrics.

**Response:**

```json
{
  "success": true,
  "metrics": {
    "totalCIs": 8542,
    "accurateCIs": 8120,
    "accuracyPercentage": 95.06,
    "driftDetected": 422,
    "staleCIs": 58,
    "lastAuditDate": "2025-11-15T10:30:00Z"
  }
}
```

---

### GET /metrics/incident-summary

Get incident volume and trends.

**Response:**

```json
{
  "success": true,
  "summary": {
    "total": 245,
    "byPriority": {
      "P1": 12,
      "P2": 45,
      "P3": 98,
      "P4": 65,
      "P5": 25
    },
    "byStatus": {
      "NEW": 15,
      "ASSIGNED": 28,
      "IN_PROGRESS": 42,
      "RESOLVED": 85,
      "CLOSED": 75
    },
    "slaBreaches": 8
  }
}
```

---

### GET /metrics/change-success-rate

Get change management success rate.

**Response:**

```json
{
  "success": true,
  "metrics": {
    "total": 150,
    "successful": 142,
    "failed": 8,
    "rollbacks": 3,
    "successRate": 94.67,
    "byType": {
      "STANDARD": {
        "total": 85,
        "successRate": 98.8
      },
      "NORMAL": {
        "total": 58,
        "successRate": 91.4
      },
      "EMERGENCY": {
        "total": 7,
        "successRate": 71.4
      }
    }
  }
}
```

---

### GET /metrics/mttr

Get Mean Time To Repair for incidents.

**Response:**

```json
{
  "success": true,
  "mttr": {
    "overall": 78.5,
    "byPriority": {
      "P1": 25.4,
      "P2": 48.2,
      "P3": 92.1,
      "P4": 145.6,
      "P5": 220.3
    },
    "unit": "minutes"
  }
}
```

---

### GET /metrics/mtbf

Get Mean Time Between Failures for CIs.

**Response:**

```json
{
  "success": true,
  "mtbf": {
    "overall": 720,
    "byTier": {
      "tier_0": 1440,
      "tier_1": 720,
      "tier_2": 480
    },
    "unit": "hours"
  }
}
```

---

## Error Responses

All endpoints return errors in this format:

```json
{
  "success": false,
  "error": "Validation failed",
  "message": "Description must be at least 10 characters"
}
```

**HTTP Status Codes:**

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad Request (validation error) |
| 401 | Unauthorized (missing/invalid JWT) |
| 403 | Forbidden (insufficient permissions) |
| 404 | Not Found (incident/change/baseline doesn't exist) |
| 500 | Internal Server Error |

## Related Resources

- [ITSM Operations Guide](/user-guides/itsm-operations)
- [ITSM Dashboard](/user-guides/itsm-dashboard)
- [Unified Framework API](/api/rest/unified)
- [Authentication API](/api/authentication)

---

**Last Updated**: 2025-11-17
**Maintainer**: HappyCMDB Team
