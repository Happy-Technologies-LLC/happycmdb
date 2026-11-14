# Unified Credentials REST API

Complete REST API reference for v3.0 unified credentials system with intelligent affinity matching.

## Overview

The Unified Credentials API provides a protocol-based authentication system that automatically matches credentials to resources using affinity rules. This replaces the legacy provider-specific credential system with a flexible, extensible approach.

## Authentication

All API endpoints require authentication using a JWT bearer token:

```bash
Authorization: Bearer YOUR_JWT_TOKEN
```

## Base URL

```
http://localhost:3000/api/v1
```

---

## Credentials API

### Create Credential

Create a new credential with affinity matching rules.

**Endpoint**: `POST /api/v1/credentials`

**Request Body**:
```json
{
  "name": "AWS Production SSH Key",
  "description": "SSH key for production EC2 instances",
  "protocol": "ssh_key",
  "scope": "cloud_provider",
  "credentials": {
    "username": "ec2-user",
    "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n...",
    "passphrase": "optional-passphrase"
  },
  "affinity": {
    "networks": ["10.0.0.0/8"],
    "hostname_patterns": ["*-prod-*", "*.example.com"],
    "os_types": ["linux"],
    "cloud_providers": ["aws"],
    "environments": ["production"],
    "priority": 8
  },
  "tags": ["production", "aws", "ec2"]
}
```

**Supported Protocols**:
- `oauth2` - OAuth 2.0
- `api_key` - API key/token
- `basic` - HTTP Basic authentication
- `bearer` - Bearer token
- `aws_iam` - AWS IAM credentials
- `azure_sp` - Azure Service Principal
- `gcp_sa` - GCP Service Account
- `ssh_key` - SSH private key
- `ssh_password` - SSH username/password
- `certificate` - X.509 certificate
- `kerberos` - Kerberos ticket
- `snmp_v2c` - SNMP v2c community string
- `snmp_v3` - SNMP v3 credentials
- `winrm` - Windows Remote Management

**Supported Scopes**:
- `cloud_provider` - Cloud platforms (AWS, Azure, GCP)
- `ssh` - SSH access
- `api` - REST/GraphQL APIs
- `network` - Network devices
- `database` - Database systems
- `container` - Container platforms
- `universal` - Any resource type

**Response** (201 Created): the stored credential with its secret redacted; `credentials` is always `***REDACTED***`.
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "AWS Production SSH Key",
    "description": "SSH key for production EC2 instances",
    "protocol": "ssh_key",
    "scope": "cloud_provider",
    "credentials": "***REDACTED***",
    "affinity": {
      "networks": ["10.0.0.0/8"],
      "hostname_patterns": ["*-prod-*", "*.example.com"],
      "os_types": ["linux"],
      "cloud_providers": ["aws"],
      "environments": ["production"],
      "priority": 8
    },
    "tags": ["production", "aws", "ec2"],
    "created_by": "user-id",
    "created_at": "2025-11-15T10:00:00.000Z",
    "updated_at": "2025-11-15T10:00:00.000Z",
    "last_validated_at": null,
    "validation_status": null
  },
  "message": "Credential created successfully"
}
```

**Error Responses**:
- `400 Bad Request` - Invalid credential data
- `409 Conflict` - Credential name already exists
- `401 Unauthorized` - Missing or invalid JWT token
- `403 Forbidden` (`code: c4_principal_admin_required`) - Non-admin sent the `happylab-c4` tag (see [The `happylab-c4` tag](#the-happylab-c4-tag))

---

### List Credentials

Retrieve the caller's credentials in their organization (summaries only, no secret material).

**Endpoint**: `GET /api/v1/credentials`

**Query Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `protocol` | string | No | Filter by protocol (ssh_key, aws_iam, etc.) |
| `scope` | string | No | Filter by scope (cloud_provider, ssh, etc.) |
| `tags` | string | No | Comma-separated tags; a credential matches if it has any of them |
| `created_by` | string | No | Only your own credentials are listed; any other value returns an empty list |
| `limit` | number | No | Results per page (default: 100, max: 1000) |
| `offset` | number | No | Pagination offset (default: 0) |

**Example Request**:
```bash
curl "http://localhost:3000/api/v1/credentials?protocol=ssh_key&limit=20" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK): newest first; `count` is the number of rows in this page.
```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "AWS Production SSH Key",
      "description": "SSH key for production EC2 instances",
      "protocol": "ssh_key",
      "scope": "cloud_provider",
      "affinity": { "networks": ["10.0.0.0/8"], "priority": 8 },
      "tags": ["production", "aws", "ec2"],
      "created_at": "2025-11-15T10:00:00.000Z",
      "updated_at": "2025-11-15T10:00:00.000Z",
      "last_validated_at": null,
      "validation_status": null,
      "usage_count": 2,
      "connector_usage_count": 0
    }
  ],
  "count": 1
}
```

---

### Get Credential by ID

Retrieve a specific credential (includes full affinity rules but NOT sensitive credentials).

**Endpoint**: `GET /api/v1/credentials/:id`

**Example Request**:
```bash
curl "http://localhost:3000/api/v1/credentials/550e8400-e29b-41d4-a716-446655440000" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK): `credentials` is always `***REDACTED***`.
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "AWS Production SSH Key",
    "description": "SSH key for production EC2 instances",
    "protocol": "ssh_key",
    "scope": "cloud_provider",
    "credentials": "***REDACTED***",
    "affinity": {
      "networks": ["10.0.0.0/8"],
      "hostname_patterns": ["*-prod-*", "*.example.com"],
      "os_types": ["linux"],
      "cloud_providers": ["aws"],
      "environments": ["production"],
      "priority": 8
    },
    "tags": ["production", "aws", "ec2"],
    "created_by": "user-id",
    "created_at": "2025-11-15T10:00:00.000Z",
    "updated_at": "2025-11-15T10:00:00.000Z",
    "last_validated_at": "2025-11-15T16:00:00.000Z",
    "validation_status": "valid"
  }
}
```

**Error Responses**:
- `404 Not Found` - Credential does not exist
- `401 Unauthorized` - Missing or invalid JWT token
- `500 Internal Server Error` - The stored credential cannot be decrypted or decoded: `{"success": false, "error": "Failed to get credential", "message": "Internal error"}`. The server log names the error class only, never its message.

---

### Update Credential

Update credential properties (name, affinity, tags, or credentials).

**Endpoint**: `PUT /api/v1/credentials/:id`

**Request Body**:
```json
{
  "name": "AWS Production SSH Key (Updated)",
  "affinity": {
    "networks": ["10.0.0.0/8", "172.16.0.0/12"],
    "priority": 9
  },
  "tags": ["production", "aws", "ec2", "high-priority"]
}
```

**Response** (200 OK): the updated credential, same shape as [Get Credential by ID](#get-credential-by-id); `credentials` is always `***REDACTED***`.
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "AWS Production SSH Key (Updated)",
    "credentials": "***REDACTED***",
    "affinity": {
      "networks": ["10.0.0.0/8", "172.16.0.0/12"],
      "priority": 9
    },
    "tags": ["production", "aws", "ec2", "high-priority"],
    "updated_at": "2025-11-15T15:00:00.000Z"
  },
  "message": "Credential updated successfully"
}
```

**Error Responses**:
- `404 Not Found` - Credential does not exist
- `400 Bad Request` - Invalid update data
  - A `credentials` value that is not an object, holds `***REDACTED***` anywhere, has an all-digit key (`0`, `1`, ...) or holds a string made only of `*` is refused with the fixed message `Invalid credentials update` before anything is written (HAP-1227, HAP-1279). These are the shapes the old edit dialog produced from the read placeholder.
- `409 Conflict` - Another of your credentials already has the new name
- `401 Unauthorized` - Missing or invalid JWT token
- `403 Forbidden` (`code: c4_principal_admin_required`) - Non-admin added the `happylab-c4` tag or edited a credential that carries it
- `500 Internal Server Error` - The updated credential cannot be decrypted or decoded (a stored value that is not valid JSON, or a damaged envelope): `{"success": false, "error": "Failed to update credential", "message": "Internal error"}`. The update is rolled back, so nothing is changed (HAP-1814). Sending a new `credentials` object replaces the stored value and avoids this.

---

### Delete Credential

Delete a credential permanently.

**Endpoint**: `DELETE /api/v1/credentials/:id`

**Example Request**:
```bash
curl -X DELETE "http://localhost:3000/api/v1/credentials/550e8400-e29b-41d4-a716-446655440000" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (204 No Content): empty body.

**Error Responses**:
- `404 Not Found` - Credential does not exist
- `409 Conflict` - Credential is in use by discovery definitions, connector configurations or credential sets. The message carries counts of same-organization references only; a reference from another organization (or with no organization) is not counted but still refuses the delete, with a count-free message (`Cannot delete credential: it is currently in use`)
- `401 Unauthorized` - Missing or invalid JWT token
- `403 Forbidden` (`code: c4_principal_admin_required`) - Non-admin deleting a credential tagged `happylab-c4`

### The `happylab-c4` tag

The organization's `bearer` credential tagged `happylab-c4` is its HappyLab C4 sync principal. Only org admins (role `admin`) may create a credential with this tag, add it on update, edit or rotate a credential that carries it, remove it or delete that credential. Other roles get `403` with `{"success": false, "error": "Forbidden", "code": "c4_principal_admin_required"}`; a missing or foreign credential is still `404`. Other tags (including case variants) are unaffected.

---

### Match Credential

Find the best matching credential for a given context using affinity scoring.

**Endpoint**: `POST /api/v1/credentials/match`

**Permission**: `write`. It decrypts the caller's credentials server-side to score them; a `viewer` gets `403` before any lookup.

**Request Body** (field names per the route's `credentialMatchContextSchema`; all optional):
```json
{
  "ip": "10.0.1.50",
  "hostname": "web-prod-01.example.com",
  "os_type": "linux",
  "environment": "production",
  "cloud_provider": "aws",
  "required_protocol": "ssh_key",
  "required_scope": "cloud_provider"
}
```

**Response** (200 OK): the highest-scoring credential (see [Match Score Calculation](#match-score-calculation)). Secrets are never returned; `credential.credentials` is always `***REDACTED***`. Against the request above, this credential scores 30 (network) + 25 (hostname) + 20 (OS) + 10 (environment) + 10 (priority 5 × 2) = 95.
```json
{
  "success": true,
  "data": {
    "credential": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "AWS Production SSH Key",
      "description": null,
      "protocol": "ssh_key",
      "scope": "cloud_provider",
      "credentials": "***REDACTED***",
      "affinity": {
        "networks": ["10.0.0.0/16"],
        "hostname_patterns": ["*-prod-*"],
        "os_types": ["linux"],
        "environments": ["production"],
        "priority": 5
      },
      "tags": ["production"],
      "created_by": "user-id",
      "created_at": "2025-11-15T14:30:00.000Z",
      "updated_at": "2025-11-15T14:30:00.000Z",
      "last_validated_at": null,
      "validation_status": null
    },
    "score": 95,
    "reasons": [
      "Network match: 10.0.0.0/16",
      "Hostname match: *-prod-*",
      "OS type match: linux",
      "Environment match: production",
      "Priority boost: +10 (priority 5)"
    ]
  }
}
```

**Error Responses**:
- `404 Not Found` - No credential of the caller passes the protocol/scope filters, or every one that does fails to decrypt or decode (each such candidate is skipped; the server log names its error class only)
- `400 Bad Request` - Invalid context data
- `401 Unauthorized` - Missing or invalid JWT token
- `403 Forbidden` - Caller lacks the `write` permission: `{"_error": "Forbidden", "_message": "Permission 'write' required"}`

---

### Rank Credentials

Rank all credentials by match score for a given context.

**Endpoint**: `POST /api/v1/credentials/rank`

**Permission**: `write`. It decrypts the caller's credentials server-side to score them; a `viewer` gets `403` before any lookup.

**Request Body**: same fields as Match.
```json
{
  "ip": "10.0.1.50",
  "hostname": "web-prod-01.example.com",
  "os_type": "linux",
  "environment": "production",
  "required_protocol": "ssh_key"
}
```

**Response** (200 OK): every credential of the caller that has the required protocol/scope, sorted by `score` descending; none is excluded for a low score. A credential that fails to decrypt or decode is left out (the server log names its error class only), so the list can be empty. Secrets are never returned; `credential.credentials` is always `***REDACTED***`. Against the request above: the first scores 30 + 25 + 20 + 10 + 10 (priority 5 × 2) = 95, the second 20 (OS only), the third has no affinity rules and gets the base score 1.
```json
{
  "success": true,
  "data": [
    {
      "credential": {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "name": "AWS Production SSH Key",
        "description": null,
        "protocol": "ssh_key",
        "scope": "cloud_provider",
        "credentials": "***REDACTED***",
        "affinity": {
          "networks": ["10.0.0.0/16"],
          "hostname_patterns": ["*-prod-*"],
          "os_types": ["linux"],
          "environments": ["production"],
          "priority": 5
        },
        "tags": ["production"],
        "created_by": "user-id",
        "created_at": "2025-11-15T14:30:00.000Z",
        "updated_at": "2025-11-15T14:30:00.000Z",
        "last_validated_at": null,
        "validation_status": null
      },
      "score": 95,
      "reasons": [
        "Network match: 10.0.0.0/16",
        "Hostname match: *-prod-*",
        "OS type match: linux",
        "Environment match: production",
        "Priority boost: +10 (priority 5)"
      ]
    },
    {
      "credential": {
        "id": "660f9511-f3ac-52e5-b827-557766551111",
        "name": "Generic Linux SSH Key",
        "description": null,
        "protocol": "ssh_key",
        "scope": "ssh",
        "credentials": "***REDACTED***",
        "affinity": {
          "os_types": ["linux"]
        },
        "tags": [],
        "created_by": "user-id",
        "created_at": "2025-11-15T14:30:00.000Z",
        "updated_at": "2025-11-15T14:30:00.000Z",
        "last_validated_at": null,
        "validation_status": null
      },
      "score": 20,
      "reasons": ["OS type match: linux"]
    },
    {
      "credential": {
        "id": "880a1733-a5ce-44a7-8049-779988773333",
        "name": "Fallback SSH Key",
        "description": null,
        "protocol": "ssh_key",
        "scope": "ssh",
        "credentials": "***REDACTED***",
        "affinity": {},
        "tags": [],
        "created_by": "user-id",
        "created_at": "2025-11-15T14:30:00.000Z",
        "updated_at": "2025-11-15T14:30:00.000Z",
        "last_validated_at": null,
        "validation_status": null
      },
      "score": 1,
      "reasons": ["Default match (no affinity specified)"]
    }
  ],
  "count": 3
}
```

**Error Responses**:
- `400 Bad Request` - Invalid context data
- `401 Unauthorized` - Missing or invalid JWT token
- `403 Forbidden` - Caller lacks the `write` permission: `{"_error": "Forbidden", "_message": "Permission 'write' required"}`

---

### Validate Credential

Test if a credential is valid by attempting to use it.

**Endpoint**: `POST /api/v1/credentials/:id/validate`

**Permission**: `write`. It records `validation_status` and `last_validated_at`; a `viewer` gets `403` before any lookup.

**Example Request**:
```bash
curl -X POST "http://localhost:3000/api/v1/credentials/550e8400-e29b-41d4-a716-446655440000/validate" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK): `validate` checks the stored credential's structure for its protocol (it does not contact the target); `details` echoes the credential's protocol and scope.
```json
{
  "success": true,
  "data": {
    "valid": true,
    "message": "Credential structure is valid",
    "validated_at": "2025-11-15T16:00:00.000Z",
    "details": {
      "protocol": "ssh_key",
      "scope": "cloud_provider"
    }
  }
}
```

**Failure Response** (200 OK): a credential that fails validation is still a `200` with `valid: false`. A structural failure names the missing piece (for example `Missing certificate or private key`). If validation itself errors (for example the stored credential cannot be read), the message is the fixed text `Credential validation failed` (HAP-1800), shown below.
```json
{
  "success": true,
  "data": {
    "valid": false,
    "message": "Credential validation failed",
    "validated_at": "2025-11-15T16:00:00.000Z"
  }
}
```

---

## Credential Sets API

Credential sets allow trying multiple credentials in sequence with configurable strategies.

### Create Credential Set

**Endpoint**: `POST /api/v1/credential-sets`

**Request Body**:
```json
{
  "name": "Production Linux Servers",
  "description": "Fallback credentials for production Linux servers",
  "credential_ids": [
    "550e8400-e29b-41d4-a716-446655440000",
    "660f9511-f3ac-52e5-b827-557766551111"
  ],
  "strategy": "sequential",
  "stop_on_success": true,
  "tags": ["production", "linux"]
}
```

`name` and `credential_ids` (at least one; each must be one of your credentials in this organization) are required; `strategy` defaults to `sequential` and `stop_on_success` to `true`. The server stores `stop_on_success` for the caller; select does not act on it.

**Strategies** (applied by [Select Credentials from Set](#select-credentials-from-set)):
- `sequential` - Return the credentials in `credential_ids` order
- `parallel` - Same order as `sequential`, as a hint for a caller that tries them concurrently
- `adaptive` - Rank the credentials by affinity score against the select `context` (highest first); ties keep `credential_ids` order

**Response** (201 Created):
```json
{
  "success": true,
  "data": {
    "id": "770e0622-e4bd-43f6-a938-668877662222",
    "name": "Production Linux Servers",
    "description": "Fallback credentials for production Linux servers",
    "credential_ids": [
      "550e8400-e29b-41d4-a716-446655440000",
      "660f9511-f3ac-52e5-b827-557766551111"
    ],
    "strategy": "sequential",
    "stop_on_success": true,
    "tags": ["production", "linux"],
    "created_by": "user-id",
    "created_at": "2025-11-15T10:00:00.000Z",
    "updated_at": "2025-11-15T10:00:00.000Z"
  },
  "message": "Credential set created successfully"
}
```

**Error Responses**:
- `400 Bad Request` - Invalid body, or one or more `credential_ids` are not your credentials
- `409 Conflict` - You already have a credential set with this name

---

### List Credential Sets

**Endpoint**: `GET /api/v1/credential-sets`

**Response** (200 OK): each set with its member credentials as summaries (no secrets), newest first.
```json
{
  "success": true,
  "data": [
    {
      "id": "770e0622-e4bd-43f6-a938-668877662222",
      "name": "Production Linux Servers",
      "description": "Fallback credentials for production Linux servers",
      "credentials": [
        { "id": "550e8400-e29b-41d4-a716-446655440000", "name": "AWS Production SSH Key", "protocol": "ssh_key", "scope": "cloud_provider", "affinity": { "priority": 8 }, "priority": 8 },
        { "id": "660f9511-f3ac-52e5-b827-557766551111", "name": "Generic Linux SSH Key", "protocol": "ssh_key", "scope": "ssh", "affinity": {}, "priority": 5 }
      ],
      "strategy": "sequential",
      "stop_on_success": true,
      "tags": ["production", "linux"],
      "created_at": "2025-11-15T10:00:00.000Z",
      "updated_at": "2025-11-15T10:00:00.000Z",
      "usage_count": 0
    }
  ],
  "count": 1
}
```

---

### Get Credential Set

**Endpoint**: `GET /api/v1/credential-sets/:id`

**Response** (200 OK): one set in the [List Credential Sets](#list-credential-sets) item shape; `credentials` lists the members in `credential_ids` order and `priority` is the member's `affinity.priority` (5 when unset).
```json
{
  "success": true,
  "data": {
    "id": "770e0622-e4bd-43f6-a938-668877662222",
    "name": "Production Linux Servers",
    "description": "Fallback credentials for production Linux servers",
    "credentials": [
      { "id": "550e8400-e29b-41d4-a716-446655440000", "name": "AWS Production SSH Key", "protocol": "ssh_key", "scope": "cloud_provider", "affinity": { "priority": 8 }, "priority": 8 },
      { "id": "660f9511-f3ac-52e5-b827-557766551111", "name": "Generic Linux SSH Key", "protocol": "ssh_key", "scope": "ssh", "affinity": {}, "priority": 5 }
    ],
    "strategy": "sequential",
    "stop_on_success": true,
    "tags": ["production", "linux"],
    "created_at": "2025-11-15T10:00:00.000Z",
    "updated_at": "2025-11-15T10:00:00.000Z",
    "usage_count": 0
  }
}
```

**Error Responses**:
- `404 Not Found` - The set does not exist

---

### Update Credential Set

**Endpoint**: `PUT /api/v1/credential-sets/:id`

**Request Body** (every field optional; same fields as create):
```json
{
  "strategy": "adaptive",
  "credential_ids": [
    "550e8400-e29b-41d4-a716-446655440000",
    "660f9511-f3ac-52e5-b827-557766551111",
    "880a1733-a5ce-44a7-8049-779988773333"
  ]
}
```

**Response** (200 OK): the updated set, same shape as the create response.
```json
{
  "success": true,
  "data": {
    "id": "770e0622-e4bd-43f6-a938-668877662222",
    "name": "Production Linux Servers",
    "description": "Fallback credentials for production Linux servers",
    "credential_ids": [
      "550e8400-e29b-41d4-a716-446655440000",
      "660f9511-f3ac-52e5-b827-557766551111",
      "880a1733-a5ce-44a7-8049-779988773333"
    ],
    "strategy": "adaptive",
    "stop_on_success": true,
    "tags": ["production", "linux"],
    "created_by": "user-id",
    "created_at": "2025-11-15T10:00:00.000Z",
    "updated_at": "2025-11-15T15:00:00.000Z"
  },
  "message": "Credential set updated successfully"
}
```

**Error Responses**:
- `400 Bad Request` - Invalid body, or one or more `credential_ids` are not your credentials
- `404 Not Found` - The set does not exist
- `409 Conflict` - You already have a credential set with the new name

---

### Delete Credential Set

**Endpoint**: `DELETE /api/v1/credential-sets/:id`

**Response** (204 No Content): empty body.

**Error Responses**:
- `404 Not Found` - The set does not exist
- `409 Conflict` - The set is used by a discovery definition

---

### Select Credentials from Set

Select credentials from a set using the configured strategy and context.

**Endpoint**: `POST /api/v1/credential-sets/:id/select`

**Permission**: `write`. It reads the set's member secrets server-side; a `viewer` gets `403` before any lookup.

**Request Body** (field names per the route's `selectCredentialsSchema`: `context` and `strategy`, both optional; the legacy underscore-prefixed `_context` / `_strategy` are not accepted and are stripped, so a body that uses them selects with an empty context and the set's own strategy):
```json
{
  "context": {
    "hostname": "web-prod-01.example.com",
    "ip": "10.0.1.50",
    "os_type": "linux"
  },
  "strategy": "adaptive"
}
```

**Response** (200 OK): the set's member credentials ordered by `strategy` (default: the set's stored strategy; see [Strategies](#create-credential-set)); `context` is used only by `adaptive`. Secrets are never returned; `credentials` is always `***REDACTED***`.
```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "AWS Production SSH Key",
      "description": "SSH key for production EC2 instances",
      "protocol": "ssh_key",
      "scope": "cloud_provider",
      "credentials": "***REDACTED***",
      "affinity": {},
      "tags": ["production"],
      "created_by": "user-id",
      "created_at": "2025-11-15T14:30:00.000Z",
      "updated_at": "2025-11-15T14:30:00.000Z",
      "last_validated_at": null,
      "validation_status": null
    }
  ],
  "count": 1
}
```

**Error Responses**:
- `400 Bad Request` - Invalid `context` or `strategy`
- `401 Unauthorized` - Missing or invalid JWT token
- `403 Forbidden` - Caller lacks the `write` permission: `{"_error": "Forbidden", "_message": "Permission 'write' required"}`
- `404 Not Found` - The set does not exist
- `500 Internal Server Error` - A member credential cannot be decrypted or decoded: `{"success": false, "error": "Failed to select credentials", "message": "Internal error"}`. The whole select fails (no partial list); the server log names the error class only, never its message (HAP-1814).

---

## Affinity Matching

The unified credentials system uses intelligent affinity matching to automatically select the best credential for a given resource.

### Matching Rules

`required_protocol` and `required_scope` are filters, not scoring rules: only the caller's credentials whose `protocol` / `scope` equal them are considered at all. Each remaining credential is scored against its `affinity`:

| Rule | Matches when | Points |
|------|--------------|--------|
| Network | `ip` falls within one of `networks` (CIDR) | +30 |
| Hostname pattern | `hostname` matches one of `hostname_patterns` (wildcard) | +25 |
| OS type | `os_type` is in `os_types` | +20 |
| Device type | `device_type` is in `device_types` | +15 |
| Environment | `environment` is in `environments` | +10 |
| Cloud provider | `cloud_provider` is in `cloud_providers` | +20 |
| Priority | `priority` (1-10) is set; applies regardless of the context | + `priority` × 2 |

### Match Score Calculation

- The score is the sum of the points above; each rule counts at most once.
- A credential with no matching rule and no `priority` gets the base score 1 (reason `Default match (no affinity specified)`).
- There is no 0-100 scale: the maximum is 30 + 25 + 20 + 15 + 10 + 20 + 20 = 140.
- No credential is excluded for a low score. Rank returns every considered credential sorted by score (highest first); Match returns the first of that list.
- A considered credential that fails to decrypt or decode is skipped, not scored; the server log records its id and error class only. Match returns `404` when no credential passes the protocol/scope filters or when every one that does is skipped this way.

### Example Affinity Configuration

```json
{
  "affinity": {
    "networks": ["10.0.0.0/8", "172.16.0.0/12"],
    "hostname_patterns": ["*-prod-*", "*.example.com", "prod-*"],
    "os_types": ["linux", "ubuntu", "centos"],
    "device_types": ["server", "virtual-machine"],
    "environments": ["production"],
    "cloud_providers": ["aws"],
    "priority": 9
  }
}
```

This configuration scores points for:
- Any IP in 10.0.0.0/8 or 172.16.0.0/12
- Hostnames containing "-prod-" or ending with ".example.com" or starting with "prod-"
- Linux-based operating systems
- Server or VM device types
- Production environment
- AWS cloud provider
- Priority 9 (+18 whenever the credential is scored)

---

## Migration from v2.0

### Breaking Changes

1. **Credential Storage**: Credentials moved from environment variables to PostgreSQL database
2. **API Endpoints**: New `/api/v1/credentials` endpoints replace provider-specific endpoints
3. **Credential Format**: Protocol-based structure replaces provider-based structure

### Migration Steps

1. **Export existing credentials** from environment variables
2. **Create new credentials** using the unified API with appropriate protocols:
   - AWS credentials → `aws_iam` protocol
   - Azure credentials → `azure_sp` protocol
   - GCP credentials → `gcp_sa` protocol
   - SSH credentials → `ssh_key` or `ssh_password` protocol
3. **Configure affinity rules** for intelligent matching
4. **Update discovery definitions** to use new credential IDs
5. **Remove deprecated environment variables**

### Example Migration

**Before (v2.0 environment variables)**:
```bash
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
AWS_REGION=us-east-1
```

**After (v3.0 unified credential)**:
```json
{
  "name": "AWS Production Account",
  "protocol": "aws_iam",
  "scope": "cloud_provider",
  "credentials": {
    "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
    "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "region": "us-east-1"
  },
  "affinity": {
    "cloud_providers": ["aws"],
    "environments": ["production"]
  }
}
```

---

## Security Considerations

1. **Encryption at Rest**: All credentials are encrypted using AES-256-GCM before storage
2. **Encryption Key**: Set `ENCRYPTION_KEY` environment variable (minimum 32 characters)
3. **Access Control**: Credentials are only accessible to authenticated users
4. **Audit Logging**: All credential operations are logged for security audits
5. **Sensitive Data**: Credential secrets are NEVER returned in list operations
6. **HTTPS Required**: Always use HTTPS in production to protect credentials in transit

---

## Best Practices

1. **Use Affinity Matching**: Configure affinity rules to automatically select correct credentials
2. **Tag Credentials**: Use tags for organization and filtering
3. **Credential Sets**: Group related credentials for fallback strategies
4. **Regular Validation**: Periodically validate credentials using the `/validate` endpoint
5. **Least Privilege**: Create credentials with minimum required permissions
6. **Rotation**: Regularly rotate credentials and update via the API
7. **Monitoring**: Track `usage_count`, `connector_usage_count` and `last_validated_at` ([List Credentials](#list-credentials)) to identify unused or stale credentials. The two usage counts include references from the credential's own organization only

---

## See Also

- [Discovery API](/api/rest/discovery.md) - Discovery definitions using credentials
- [Authentication API](/api/authentication.md) - User authentication and API keys
- [Components: Credentials](/components/credentials.md) - Unified credential system overview
