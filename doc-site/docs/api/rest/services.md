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

## Authentication

Every `/api/v1/itil` request needs an authenticated caller: a JWT bearer token or an API key. Without one the API answers `401`.

```http
POST /api/v1/itil/incidents
Authorization: Bearer <jwt_token>
```

- **Read routes** (every `GET`) need no permission beyond authentication.
- **Mutating routes** (every `POST`, `PATCH` and `DELETE`) require the `write` permission. Without it the API answers `403`.
- **Organization scope**: all records belong to the caller's organization, taken from the credential, never from the request. A caller whose credential carries no organization claim is refused with `403` (`code: ORGANIZATION_REQUIRED`, `message: "Organization claim required"`) before any route runs.

The permissions are `read`, `write`, `discover` and `admin`; there are no `itil:read` or `itil:write` permissions.

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

List configuration baselines for the caller's organization (newest first, at most 100). Rows carry summary columns only; `baseline_data` and `scope` are omitted from the list. Fetch `GET /baselines/:id` for the full row.

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "0b6f6c3e-5a0e-4a53-9a43-3f4a0f3c7a11",
      "name": "Production Web Tier - Pre-Upgrade",
      "description": "Baseline before upgrading...",
      "baseline_type": "configuration",
      "status": "draft",
      "created_by": "ops-team@company.com",
      "approved_by": null,
      "approved_at": null,
      "created_at": "2025-11-17T12:00:00Z",
      "updated_at": "2025-11-17T12:00:00Z",
      "organization_id": "11111111-1111-4111-8111-111111111111"
    }
  ],
  "count": 1
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

::: warning Not implemented
Baseline comparison is not implemented. The endpoint never evaluates drift and never returns a comparison payload.
:::

**Responses:**

| Status | Meaning |
| ------ | ------- |
| `404` | The baseline does not exist or belongs to another organization (checked first; the two cases are indistinguishable) |
| `501` | The baseline exists in the caller's organization; comparison is not implemented, so no drift was evaluated |

```json
{
  "success": false,
  "error": "Not Implemented",
  "message": "Baseline comparison is not implemented; no drift was evaluated for this baseline"
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

All metrics are read-only `GET` routes, scoped to the caller's organization. Numeric results are returned as strings with two decimals. The incident and change metrics answer `503 {"success": false, "error": "ITIL records unavailable"}` when the ITIL record tables are missing from the database.

### GET /metrics/configuration-accuracy

Get the share of audited CIs that are compliant. Only CIs with an ITIL audit status count; a CI never audited is ignored. A CI is compliant when its audit status is `COMPLIANT`.

**Response:**

```json
{
  "success": true,
  "data": {
    "accuracy": "95.06",
    "compliantCount": 8120,
    "totalAudited": 8542
  }
}
```

`accuracy` is a percentage, `"0.00"` when no CI has been audited.

**Errors:** `503 {"success": false, "error": "Service Unavailable", "message": "CI list temporarily unavailable"}` while CI writes are pending reconciliation; `500` on any other failure.

---

### GET /metrics/incident-summary

Get incident counts grouped by status and priority.

**Response:**

```json
{
  "success": true,
  "data": [
    { "status": "in_progress", "priority": 1, "count": "3" },
    { "status": "new", "priority": 1, "count": "1" },
    { "status": "resolved", "priority": 2, "count": "12" }
  ]
}
```

`data` is an array with one row per status and priority that has incidents, ordered by priority and then status. `status` is lower case. `count` is a numeric string, not a number. The array is empty when the organization has no incidents.

---

### GET /metrics/open-incidents

Get the open incidents for the estate overview ribbon. An incident is open unless its status is `resolved`, `closed` or `cancelled`. Incidents are ordered by priority (P1 first), then newest `reported_at`.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 5 | Incidents to return, 1 to 50 |

An invalid `limit` is refused with `400 {"success": false, "error": "Bad Request", "message": "limit must be an integer from 1 to 50"}`; it is never clamped.

**Response:**

```json
{
  "success": true,
  "data": {
    "incidents": [
      {
        "id": "5b0c9d2e-3f4a-4c1b-8e7d-0a1b2c3d4e5f",
        "incident_number": "INC0001234",
        "title": "Checkout API returning 500",
        "priority": 1,
        "status": "in_progress",
        "affected_ci_id": "srv-web-prod-01",
        "affected_service": { "service_id": "svc-checkout", "name": "Checkout" },
        "opened_at": "2025-11-20T09:30:00.000Z",
        "users_affected": 1200,
        "revenue_per_hour": null,
        "unavailable": ["revenue_per_hour"]
      }
    ],
    "open_count": 7
  }
}
```

- `open_count` counts every open incident of the organization, not only the ones returned.
- `affected_service` is `null` when no service is derived for the incident.
- `users_affected` and `revenue_per_hour` are `null` when no data backs them, and each such field name is listed in `unavailable`.

**Errors:** `503 {"success": false, "error": "Analytics resource limit exceeded"}` when the read exceeds its statement timeout.

---

### GET /metrics/change-success-rate

Get the success rate of closed changes. Only changes with status `closed` count, and a change is successful when its outcome is `successful`.

**Response:**

```json
{
  "success": true,
  "data": {
    "successRate": "94.67",
    "successfulChanges": 142,
    "totalClosedChanges": 150
  }
}
```

`successRate` is a percentage, `"0.00"` when no change is closed.

---

### GET /metrics/mttr

Get Mean Time To Resolve, the average of `resolved_at - reported_at` over the organization's resolved incidents.

**Response:**

```json
{
  "success": true,
  "data": {
    "mttr": "0.25",
    "unit": "hours"
  }
}
```

`mttr` is in hours, `"0.00"` when there is no data. There is no per-priority breakdown.

---

### GET /metrics/mtbf

Get Mean Time Between Failures: the mean gap between consecutive incidents reported against the same CI, over incidents of every status.

**Response:**

```json
{
  "success": true,
  "data": {
    "mtbf": "720.00",
    "unit": "hours"
  }
}
```

`mtbf` is in hours, `"0.00"` when no CI has two incidents. There is no per-tier breakdown.

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
