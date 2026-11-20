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
- **Check order on `/incidents`, `/changes` and `/baselines`**: two checks run before the `write` check, so a caller without `write` does not always see the `403`. First, `503 {"success": false, "error": "ITIL records unavailable"}` when the ITIL record tables are missing from the database. Second, for any route with an `:id`, `404 {"success": false, "error": "Not Found", "message": "Incident not found"}` (`Change not found` or `Baseline not found` on the other two families) when the id is not a UUID. The caller is still refused and nothing is written; only the status differs. A malformed id or a missing record table on a caller that holds `write` gets the same `404` or `503`. The `/configuration-items` routes have no such pre-check: they answer `403` first.
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
| `affectedCIId` | Yes | Id of an existing CI in the caller's organization (404 otherwise) |
| `description` | Yes | Minimum 10 characters. Stored in full as `description`; `title` is the same text cut to 500 characters (the last 3 replaced by `...` when longer) |
| `reportedBy` | Yes | Email or username, stored as `reported_by` |
| `symptoms` | No | Array of strings. Accepted and ignored: it is not stored and not returned |
| `detectedAt` | No | ISO 8601 timestamp, stored as `reported_at` (defaults to now) |

**Response (201):**

```json
{
  "success": true,
  "data": {
    "id": "5f0c2a9e-7d3b-4c1e-9a52-3b8e6f1d4a70",
    "incident_number": "INC-5f0c2a9e-7d3b-4c1e-9a52-3b8e6f1d4a70",
    "title": "Database connection pool exhausted, web application returning 503 errors",
    "description": "Database connection pool exhausted, web application returning 503 errors",
    "category": null,
    "subcategory": null,
    "impact": "high",
    "urgency": "medium",
    "priority": 2,
    "affected_ci_id": "srv-web-prod-01",
    "affected_business_service_id": null,
    "affected_application_service_id": null,
    "business_impact": {
      "estimated_user_impact": 2500,
      "estimated_revenue_impact": null,
      "revenue_per_hour": 114.15,
      "estimated_cost_of_downtime": null,
      "affected_services": [
        { "service_id": "svc-checkout", "name": "Checkout" }
      ]
    },
    "assigned_to": null,
    "assigned_group": null,
    "status": "new",
    "resolution": null,
    "resolution_code": null,
    "reported_at": "2025-11-17T08:15:00.000Z",
    "acknowledged_at": null,
    "resolved_at": null,
    "closed_at": null,
    "time_to_acknowledge_minutes": null,
    "time_to_resolve_minutes": null,
    "reported_by": "john.doe@company.com",
    "created_at": "2025-11-17T08:16:02.311Z",
    "updated_at": "2025-11-17T08:16:02.311Z",
    "organization_id": "11111111-1111-4111-8111-111111111111"
  },
  "priorityCalculation": {
    "priority": 2,
    "impact": "high",
    "urgency": "medium",
    "reasoning": "Basic calculation based on CI type and environment",
    "estimatedUserImpact": 100,
    "estimatedRevenueImpact": 1000
  },
  "message": "Incident created with priority P2"
}
```

`data` is the raw `itil_incidents` row, snake_case, with lower-case `status`. `id` is a UUID, and `incident_number` is `INC-` followed by that UUID. The timestamps are ISO 8601 strings. `category`, `subcategory`, `assigned_to` and the other columns this endpoint does not set stay `null`. Every other incident endpoint returns this same row shape.

**Auto-Calculated Priority:**

`priority`, `impact` and `urgency` (and `priorityCalculation`) come from a basic rule on the affected CI, not from business criticality:

| Affected CI | `priority` | `impact` | `urgency` |
|-------------|-----------|----------|-----------|
| Type `database`, `load-balancer` or `service` | 1 | `critical` | `high` |
| Any other type, `environment` is `production` | 2 | `high` | `medium` |
| Anything else | 3 | `medium` | `medium` |

`priorityCalculation.estimatedUserImpact` and `estimatedRevenueImpact` are fixed values per priority (1000 and 10000 for P1, 100 and 1000 for P2, 10 and 100 for P3).

`data.business_impact` is separate: it is derived from the business services the CI is mapped to. `estimated_user_impact` and `revenue_per_hour` come from the primary (most critical) mapped service and are `null` when no service or no figure backs them. `estimated_revenue_impact` and `estimated_cost_of_downtime` are always `null`. If the mapping cannot be read the incident is still created with `null` figures.

| Status | Meaning |
|--------|---------|
| 201 | Incident created |
| 400 | Request body failed validation |
| 404 | `Not Found`, `CI with ID '<id>' not found` |
| 409 | `Conflict`, `CI is temporarily unavailable`: a write to the affected CI is pending reconciliation; nothing is stored |
| 503 | `Service Unavailable`, `CI write temporarily unavailable`: the write could not be admitted in time; nothing is stored |
| 500 | `Failed to create incident` |

---

### GET /incidents

List all incidents with optional filtering.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | - | One of `NEW`, `ASSIGNED`, `IN_PROGRESS`, `RESOLVED`, `CLOSED` (upper case; the API compares it to the lower-case stored status) |
| `priority` | integer | - | Filter by priority (1-5) |
| `affectedCIId` | string | - | Filter by affected CI ID |
| `page` | integer | 1 | Page number (minimum 1) |
| `limit` | integer | 50 | Results per page (1-1000; a larger value is a 400, not clamped) |

Results are newest first by `reported_at`. A value outside these lists answers 400.

**Example Request:**

```bash
curl -X GET "http://localhost:3000/api/v1/itil/incidents?status=IN_PROGRESS&priority=1&page=1&limit=20" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "5f0c2a9e-7d3b-4c1e-9a52-3b8e6f1d4a70",
      "incident_number": "INC-5f0c2a9e-7d3b-4c1e-9a52-3b8e6f1d4a70",
      "title": "Database connection pool exhausted, web application returning 503 errors",
      "priority": 1,
      "impact": "critical",
      "urgency": "high",
      "affected_ci_id": "srv-web-prod-01",
      "status": "in_progress",
      "assigned_to": "sre-team@company.com",
      "reported_by": "john.doe@company.com",
      "reported_at": "2025-11-17T08:15:00.000Z",
      "updated_at": "2025-11-17T08:45:00.000Z"
    }
  ],
  "pagination": {
    "total": 42,
    "page": 1,
    "limit": 20,
    "pages": 3
  }
}
```

Each element of `data` is the full incident row (see [POST /incidents](#post-incidents)); the example lists the fields that matter here. `pagination.pages` is `ceil(total / limit)`.

Errors: `500` with `error: "Failed to retrieve incidents"`.

---

### GET /incidents/:id

Get a specific incident by ID. The id must be the incident's UUID (`data.id`), not the `incident_number`.

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "5f0c2a9e-7d3b-4c1e-9a52-3b8e6f1d4a70",
    "incident_number": "INC-5f0c2a9e-7d3b-4c1e-9a52-3b8e6f1d4a70",
    "title": "Database connection pool exhausted, web application returning 503 errors",
    "description": "Database connection pool exhausted, web application returning 503 errors",
    "category": null,
    "subcategory": null,
    "impact": "critical",
    "urgency": "high",
    "priority": 1,
    "affected_ci_id": "srv-web-prod-01",
    "affected_business_service_id": null,
    "affected_application_service_id": null,
    "business_impact": {
      "estimated_user_impact": 2500,
      "estimated_revenue_impact": null,
      "revenue_per_hour": 114.15,
      "estimated_cost_of_downtime": null,
      "affected_services": [
        { "service_id": "svc-checkout", "name": "Checkout" }
      ]
    },
    "assigned_to": "sre-team@company.com",
    "assigned_group": null,
    "status": "in_progress",
    "resolution": null,
    "resolution_code": null,
    "reported_at": "2025-11-17T08:15:00.000Z",
    "acknowledged_at": null,
    "resolved_at": null,
    "closed_at": null,
    "time_to_acknowledge_minutes": null,
    "time_to_resolve_minutes": null,
    "reported_by": "john.doe@company.com",
    "created_at": "2025-11-17T08:16:02.311Z",
    "updated_at": "2025-11-17T08:45:00.000Z",
    "organization_id": "11111111-1111-4111-8111-111111111111"
  }
}
```

`data` is the stored row as is. The handler adds nothing to it: there is no CI name, CI type, symptoms or age field.

| Status | Meaning |
|--------|---------|
| 200 | Incident found |
| 404 | `{"success": false, "error": "Not Found", "message": "Incident not found"}`: unknown id, an id in another organization, or an id that is not a UUID |
| 500 | `Failed to retrieve incident` |

---

### PATCH /incidents/:id

Update an incident's status, assignment or priority.

**Request Body:**

```json
{
  "status": "IN_PROGRESS",
  "assignedTo": "sre-team@company.com",
  "priority": 1
}
```

| Field | Constraints |
|-------|-------------|
| `status` | `NEW`, `ASSIGNED`, `IN_PROGRESS`, `RESOLVED` or `CLOSED`; stored lower-case |
| `assignedTo` | String, stored as `assigned_to` |
| `priority` | Integer 1-5 |

All fields are optional but at least one must be sent: an empty body answers `400 {"success": false, "error": "Bad Request", "message": "No fields to update"}`.

**Status transitions:** none are enforced. Any of the five values can be set from any current status.

**Timestamps set by a status change:** `RESOLVED` stamps `resolved_at` and `CLOSED` stamps `closed_at`, both only when still empty, so a repeat or later `PATCH` keeps the first value. Moving to `NEW`, `ASSIGNED` or `IN_PROGRESS` (reopen) clears both `resolved_at` and `closed_at`.

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "5f0c2a9e-7d3b-4c1e-9a52-3b8e6f1d4a70",
    "incident_number": "INC-5f0c2a9e-7d3b-4c1e-9a52-3b8e6f1d4a70",
    "priority": 1,
    "status": "in_progress",
    "assigned_to": "sre-team@company.com",
    "resolved_at": null,
    "closed_at": null,
    "updated_at": "2025-11-17T08:45:00.000Z"
  },
  "message": "Incident updated successfully"
}
```

`data` is the full updated incident row; the example lists the fields that matter here.

| Status | Meaning |
|--------|---------|
| 200 | Incident updated |
| 400 | Body failed validation, or `No fields to update` |
| 404 | `Incident not found` (unknown id, other organization, or id not a UUID) |
| 500 | `Failed to update incident` |

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

- `resolution`: required, minimum 10 characters, stored as `resolution`
- `resolvedBy`: required string, but accepted and ignored: it is not stored and not returned

The endpoint sets `status` to `resolved`, stores `resolution`, and stamps `resolved_at` only when it is still empty: a repeat call keeps the first resolution time. A reopen through [PATCH /incidents/:id](#patch-incidents-id) clears `resolved_at`, so a later resolve stamps a fresh value. It does not check the current status.

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "5f0c2a9e-7d3b-4c1e-9a52-3b8e6f1d4a70",
    "incident_number": "INC-5f0c2a9e-7d3b-4c1e-9a52-3b8e6f1d4a70",
    "status": "resolved",
    "resolution": "Increased database connection pool size from 50 to 100. Restarted application servers. Monitoring shows stable connection pool usage at 60-70%.",
    "resolved_at": "2025-11-17T10:30:00.000Z",
    "time_to_resolve_minutes": null,
    "updated_at": "2025-11-17T10:30:00.000Z"
  },
  "message": "Incident resolved successfully"
}
```

`data` is the full updated incident row; the example lists the fields that matter here. There is no `mttr` or `resolvedBy` field, and `time_to_resolve_minutes` is not set by this endpoint. For the MTTR figure see [GET /metrics/mttr](#get-metrics-mttr).

| Status | Meaning |
|--------|---------|
| 200 | Incident resolved |
| 400 | Body failed validation |
| 404 | `Incident not found` (unknown id, other organization, or id not a UUID) |
| 500 | `Failed to resolve incident` |

---

### GET /incidents/:id/priority

Get the stored priority, impact and urgency of an incident. They are read from the incident row; nothing is recalculated.

**Response:**

```json
{
  "success": true,
  "data": {
    "priority": 1,
    "impact": "critical",
    "urgency": "high"
  }
}
```

| Status | Meaning |
|--------|---------|
| 200 | Incident found |
| 404 | `Incident not found` (unknown id, other organization, or id not a UUID) |
| 500 | `Failed to retrieve incident priority` |

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

| Type | Description |
|------|-------------|
| STANDARD | Pre-approved changes (e.g., daily backups) |
| NORMAL | Planned changes requiring CAB approval |
| EMERGENCY | Critical fixes during outages |
| MAJOR | Large-scope changes |

The type is stored lower-case (`standard`, `normal`, `emergency`, `major`). This endpoint applies no type-specific rule: every new change starts as `draft` with `approval_status` `pending`, whatever its type.

**Validation Rules:**

| Field | Required | Constraints |
|-------|----------|-------------|
| `changeType` | Yes | STANDARD, NORMAL, EMERGENCY, MAJOR |
| `description` | Yes | Minimum 10 characters. Stored in full as `description`; `title` is the same text cut to 500 characters (the last 3 replaced by `...` when longer) |
| `affectedCIIds` | Yes | Array of 1 to 100 CI ids, each 1-255 characters; every id must be an existing CI in the caller's organization |
| `requestedBy` | Yes | Email or username, stored as `requested_by` |
| `plannedStart` | Yes | ISO 8601 timestamp, stored as `scheduled_start`. Not required to be in the future |
| `plannedDuration` | Yes | Integer, minutes, at least 1. `scheduled_end` is `plannedStart` plus this duration; the duration itself is not stored |
| `implementationPlan` | Yes | Minimum 50 characters |
| `backoutPlan` | No | Stored as `backout_plan`; an empty string when omitted |
| `testPlan` | No | Stored as `test_plan`; an empty string when omitted |

**Response (201):**

```json
{
  "success": true,
  "data": {
    "id": "8d1b7e42-0c5a-4f36-b1d9-2a6e94c07f13",
    "change_number": "CHG-8d1b7e42-0c5a-4f36-b1d9-2a6e94c07f13",
    "title": "Upgrade Kubernetes cluster from v1.27 to v1.28",
    "description": "Upgrade Kubernetes cluster from v1.27 to v1.28",
    "change_type": "normal",
    "category": null,
    "risk_assessment": {
      "overall_risk_score": 0,
      "risk_level": "medium",
      "requires_cab_approval": false
    },
    "business_impact": {
      "critical_services_affected": [],
      "estimated_downtime_minutes": 0,
      "customer_impact": false,
      "revenue_at_risk": 0
    },
    "financial_impact": {
      "implementation_cost": 0,
      "downtime_cost": 0,
      "total_cost": 0
    },
    "affected_ci_ids": ["k8s-prod-master-01", "k8s-prod-master-02", "k8s-prod-master-03", "k8s-prod-worker-01", "k8s-prod-worker-02"],
    "affected_business_service_ids": [],
    "affected_application_service_ids": [],
    "implementation_plan": "1. Drain worker nodes\n2. Upgrade master nodes sequentially\n3. Upgrade worker nodes\n4. Validate cluster health\n5. Re-enable workloads",
    "backout_plan": "Roll back to v1.27 using etcd snapshot backup",
    "test_plan": "Deploy canary application, verify pod scheduling, test networking",
    "approval_status": "pending",
    "approved_by": null,
    "approved_at": null,
    "assigned_to": null,
    "assigned_group": null,
    "status": "draft",
    "scheduled_start": "2025-11-20T02:00:00.000Z",
    "scheduled_end": "2025-11-20T05:00:00.000Z",
    "actual_start": null,
    "actual_end": null,
    "outcome": null,
    "closure_notes": null,
    "requested_by": "platform-engineering@company.com",
    "created_at": "2025-11-17T10:00:00.412Z",
    "updated_at": "2025-11-17T10:00:00.412Z",
    "closed_at": null,
    "organization_id": "11111111-1111-4111-8111-111111111111",
    "implemented_by": null,
    "actual_duration": null
  },
  "message": "Change request created successfully"
}
```

`data` is the raw `itil_changes` row: snake_case, lower-case `status`, `change_type`, `approval_status` and `outcome`. `id` is a UUID and `change_number` is `CHG-` followed by that UUID. Every other change endpoint returns this same row shape.

**No risk score at creation:** nothing is calculated when the change is created. `risk_assessment`, `business_impact` and `financial_impact` keep the column defaults shown above and no REST endpoint writes them. The live estimate is [GET /changes/:id/risk-assessment](#get-changes-id-risk-assessment).

| Status | Meaning |
|--------|---------|
| 201 | Change created |
| 400 | Body failed validation, or a CI id is empty, longer than 255 characters or not storable (`{"success": false, "error": "Bad Request", "message": "Invalid request"}`) |
| 404 | `Not Found`, `CI with ID '<id>' not found` |
| 409 | `Conflict`, `CI is temporarily unavailable`: a write to an affected CI is pending reconciliation; nothing is stored |
| 503 | `Service Unavailable`, `CI write temporarily unavailable`: the write could not be admitted in time; nothing is stored |
| 500 | `Failed to create change request` |

---

### GET /changes

List all changes with optional filtering.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | - | One of `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `SCHEDULED`, `IN_PROGRESS`, `IMPLEMENTED`, `CLOSED`, `CANCELLED` (upper case; compared to the lower-case stored status) |
| `changeType` | string | - | `STANDARD`, `NORMAL`, `EMERGENCY` or `MAJOR` |
| `requestedBy` | string | - | Exact match on `requested_by` |
| `page` | integer | 1 | Page number (minimum 1) |
| `limit` | integer | 50 | Results per page (1-1000; a larger value is a 400, not clamped) |

Results are newest first by `created_at`. A value outside these lists answers 400. `REQUESTED` is not accepted over REST (the REST schema rejects it with 400), even though the controller itself maps it to `draft` plus `pending_approval` for the GraphQL entry point.

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "8d1b7e42-0c5a-4f36-b1d9-2a6e94c07f13",
      "change_number": "CHG-8d1b7e42-0c5a-4f36-b1d9-2a6e94c07f13",
      "title": "Upgrade Kubernetes cluster from v1.27 to v1.28",
      "change_type": "normal",
      "status": "draft",
      "approval_status": "pending",
      "requested_by": "platform-engineering@company.com",
      "scheduled_start": "2025-11-20T02:00:00.000Z",
      "scheduled_end": "2025-11-20T05:00:00.000Z",
      "created_at": "2025-11-17T10:00:00.412Z"
    }
  ],
  "pagination": {
    "total": 17,
    "page": 1,
    "limit": 50,
    "pages": 1
  }
}
```

Each element of `data` is the full change row (see [POST /changes](#post-changes)); the example lists the fields that matter here. `pagination.pages` is `ceil(total / limit)`.

Errors: `500` with `error: "Failed to retrieve changes"`.

---

### GET /changes/:id

Get a specific change by ID. The id must be the change's UUID (`data.id`), not the `change_number`.

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "8d1b7e42-0c5a-4f36-b1d9-2a6e94c07f13",
    "change_number": "CHG-8d1b7e42-0c5a-4f36-b1d9-2a6e94c07f13",
    "title": "Upgrade Kubernetes cluster from v1.27 to v1.28",
    "description": "Upgrade Kubernetes cluster from v1.27 to v1.28",
    "change_type": "normal",
    "category": null,
    "risk_assessment": {
      "overall_risk_score": 0,
      "risk_level": "medium",
      "requires_cab_approval": false
    },
    "business_impact": {
      "critical_services_affected": [],
      "estimated_downtime_minutes": 0,
      "customer_impact": false,
      "revenue_at_risk": 0
    },
    "financial_impact": {
      "implementation_cost": 0,
      "downtime_cost": 0,
      "total_cost": 0
    },
    "affected_ci_ids": ["k8s-prod-master-01", "k8s-prod-master-02", "k8s-prod-master-03", "k8s-prod-worker-01", "k8s-prod-worker-02"],
    "affected_business_service_ids": [],
    "affected_application_service_ids": [],
    "implementation_plan": "1. Drain worker nodes\n2. Upgrade master nodes sequentially\n3. Upgrade worker nodes\n4. Validate cluster health\n5. Re-enable workloads",
    "backout_plan": "Roll back to v1.27 using etcd snapshot backup",
    "test_plan": "Deploy canary application, verify pod scheduling, test networking",
    "approval_status": "approved",
    "approved_by": "u-1042",
    "approved_at": "2025-11-18T14:30:00.000Z",
    "assigned_to": null,
    "assigned_group": null,
    "status": "approved",
    "scheduled_start": "2025-11-20T02:00:00.000Z",
    "scheduled_end": "2025-11-20T05:00:00.000Z",
    "actual_start": null,
    "actual_end": null,
    "outcome": null,
    "closure_notes": null,
    "requested_by": "platform-engineering@company.com",
    "created_at": "2025-11-17T10:00:00.412Z",
    "updated_at": "2025-11-18T14:30:00.000Z",
    "closed_at": null,
    "organization_id": "11111111-1111-4111-8111-111111111111",
    "implemented_by": null,
    "actual_duration": null
  }
}
```

`data` is the stored row as is. The handler adds nothing to it: there is no risk score or level, no `affectedCIs` detail objects, and no planned-duration field (use `scheduled_start` and `scheduled_end`). `affected_ci_ids` is an array of CI id strings.

| Status | Meaning |
|--------|---------|
| 200 | Change found |
| 404 | `{"success": false, "error": "Not Found", "message": "Change not found"}`: unknown id, an id in another organization, or an id that is not a UUID |
| 500 | `Failed to retrieve change` |

---

### PATCH /changes/:id

Update a change's status or implementation details.

**Request Body:**

```json
{
  "status": "IN_PROGRESS",
  "implementedBy": "platform-engineering@company.com",
  "actualDuration": 165
}
```

| Field | Constraints |
|-------|-------------|
| `status` | `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `SCHEDULED`, `IN_PROGRESS`, `IMPLEMENTED`, `CLOSED` or `CANCELLED`; stored lower-case |
| `implementedBy` | String, 1-255 characters, stored as `implemented_by` |
| `actualDuration` | Integer minutes, 1 to 2147483647, stored as `actual_duration` |

All fields are optional but at least one must be sent: an empty body answers `400 {"success": false, "error": "Bad Request", "message": "No fields to update"}`. A value outside the limits answers `400 {"success": false, "error": "Bad Request", "message": "Invalid request"}`.

Only the named columns are written. No status transition is enforced, and a status change sets no other column: `approved` does not record an approver (use [POST /changes/:id/approve](#post-changes-id-approve)) and `closed` does not stamp `closed_at` (use [POST /changes/:id/close](#post-changes-id-close)).

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "8d1b7e42-0c5a-4f36-b1d9-2a6e94c07f13",
    "change_number": "CHG-8d1b7e42-0c5a-4f36-b1d9-2a6e94c07f13",
    "status": "in_progress",
    "implemented_by": "platform-engineering@company.com",
    "actual_duration": 165,
    "updated_at": "2025-11-20T04:45:00.000Z"
  },
  "message": "Change updated successfully"
}
```

`data` is the full updated change row; the example lists the fields that matter here.

| Status | Meaning |
|--------|---------|
| 200 | Change updated |
| 400 | Body failed validation, `Invalid request`, or `No fields to update` |
| 404 | `Change not found` (unknown id, other organization, or id not a UUID) |
| 500 | `Failed to update change` |

---

### GET /changes/:id/risk-assessment

Get a risk estimate for a change, computed on each call from the change's `affected_ci_ids`. It is not stored on the change.

**Response:**

```json
{
  "success": true,
  "data": {
    "riskScore": 0.6,
    "riskLevel": "MEDIUM",
    "requiresCABApproval": false,
    "affectedCICount": 7,
    "estimatedDowntime": 0,
    "estimatedUserImpact": 70,
    "estimatedRevenueAtRisk": 7000,
    "recommendations": [
      "Review implementation plan thoroughly",
      "Ensure backout plan is tested",
      "Schedule during maintenance window"
    ],
    "mitigationStrategies": [
      "Perform change in stages",
      "Have rollback procedures ready",
      "Monitor closely during implementation"
    ]
  }
}
```

This is a basic estimate based only on the number of affected CIs; it does not read CI criticality, the change window or the change type:

| Affected CIs | `riskScore` | `riskLevel` | `requiresCABApproval` (`riskScore` above 0.6) |
|--------------|------------|-------------|------------------------------------------------|
| 5 or fewer | 0.5 | `MEDIUM` | `false` |
| 6 to 10 | 0.6 | `MEDIUM` | `false` |
| 11 or more | 0.8 | `HIGH` | `true` |

`riskScore` is between 0 and 1. `estimatedUserImpact` is 10 per CI and `estimatedRevenueAtRisk` is 1000 per CI. `estimatedDowntime` is always `0`: the handler reads a `planned_duration` field that the stored change row does not have. The `recommendations` and `mitigationStrategies` lists are fixed text.

| Status | Meaning |
|--------|---------|
| 200 | Estimate computed |
| 404 | `Change not found` (unknown id, other organization, or id not a UUID) |
| 500 | `Failed to assess change risk` |

---

### POST /changes/:id/approve

Approve a change request. Requires the `write` permission; there is no separate approve permission. The request takes no body: the approver is the authenticated caller (`_userId`, or the username when the token has no user id), never a request field.

The first approval wins. The change gets `status` and `approval_status` set to `approved`, and `approved_by` and `approved_at` record the approver and the time. A repeat call answers 200 with the same row and keeps the original approver and time.

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "9bceed1e-3505-45a9-b4b6-fcdacebd1750",
    "change_number": "CHG-AP-1",
    "title": "Patch the checkout pool",
    "change_type": "normal",
    "approval_status": "approved",
    "approved_by": "u-1",
    "approved_at": "2026-11-20T19:06:18.392Z",
    "status": "approved",
    "requested_by": "alice",
    "created_at": "2026-11-20T19:06:18.384Z",
    "updated_at": "2026-11-20T19:06:18.392Z",
    "organization_id": "11111111-1111-4111-8111-111111111111"
  },
  "message": "Change approved successfully"
}
```

`data` is the full change row; the example lists the fields that matter here.

| Status | Meaning |
|--------|---------|
| 200 | Change approved (or already approved; the original approver and time are kept) |
| 401 | `Unauthorized`: the request carries no user identity; nothing is written |
| 404 | `Not Found`: no change with this id in the caller's organization |

---

### POST /changes/:id/implement

Mark a change as implemented. The request takes no body.

The endpoint sets `status` to `implemented`, stamps `actual_start` when it is still empty, and sets `actual_end` to now. It does not check the current status, and it does not require the change to be approved.

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "8d1b7e42-0c5a-4f36-b1d9-2a6e94c07f13",
    "change_number": "CHG-8d1b7e42-0c5a-4f36-b1d9-2a6e94c07f13",
    "status": "implemented",
    "actual_start": "2025-11-20T02:00:11.204Z",
    "actual_end": "2025-11-20T04:45:09.870Z",
    "updated_at": "2025-11-20T04:45:09.870Z"
  },
  "message": "Change implemented successfully"
}
```

`data` is the full updated change row; the example lists the fields that matter here.

| Status | Meaning |
|--------|---------|
| 200 | Change updated |
| 404 | `Change not found` (unknown id, other organization, or id not a UUID) |
| 500 | `Failed to implement change` |

---

### POST /changes/:id/close

Close a change with a result.

**Request Body:**

```json
{
  "result": "SUCCESS",
  "notes": "All 5 nodes upgraded successfully. Cluster health checks passed. Workloads running normally.",
  "closedBy": "platform-engineering@company.com"
}
```

| Field | Required | Constraints |
|-------|----------|-------------|
| `result` | Yes | `SUCCESS`, `PARTIAL_SUCCESS`, `FAILED` or `ROLLED_BACK` |
| `notes` | No | String, stored as `closure_notes` (`null` when omitted) |
| `closedBy` | Yes | String, but accepted and not stored: it is only written to the server log (the change row has no `closed_by` column) |

**Result Values:**

`result` is stored in `outcome`, lower-case:

| Result | `outcome` | Description |
|--------|-----------|-------------|
| SUCCESS | `successful` | Change completed as planned |
| PARTIAL_SUCCESS | `successful_with_issues` | Change completed with minor issues |
| FAILED | `failed` | Change failed, backout plan executed |
| ROLLED_BACK | `backed_out` | Change rolled back due to issues |

The endpoint also sets `status` to `closed` and stamps `closed_at` with the current time. It does not check the current status.

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "8d1b7e42-0c5a-4f36-b1d9-2a6e94c07f13",
    "change_number": "CHG-8d1b7e42-0c5a-4f36-b1d9-2a6e94c07f13",
    "status": "closed",
    "outcome": "successful",
    "closure_notes": "All 5 nodes upgraded successfully. Cluster health checks passed. Workloads running normally.",
    "closed_at": "2025-11-20T04:45:00.000Z",
    "updated_at": "2025-11-20T04:45:00.000Z"
  },
  "message": "Change closed successfully"
}
```

`data` is the full updated change row; the example lists the fields that matter here. There is no `result`, `actualDuration` or `closedBy` field, and `actual_duration` is not computed (set it with [PATCH /changes/:id](#patch-changes-id)).

| Status | Meaning |
|--------|---------|
| 200 | Change closed |
| 400 | Body failed validation |
| 404 | `Change not found` (unknown id, other organization, or id not a UUID) |
| 500 | `Failed to close change` |

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
