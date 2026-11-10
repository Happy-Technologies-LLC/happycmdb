# Discovery REST API

Complete REST API reference for discovery credentials, definitions, and jobs.

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

Manage discovery credentials for authentication with infrastructure providers.

### Create Credential

Create a new encrypted credential for discovery operations.

**Endpoint**: `POST /api/v1/credentials`

**Request Body**:
```json
{
  "name": "AWS Production Account",
  "description": "Main AWS production account credentials",
  "type": "aws",
  "credentials": {
    "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
    "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "region": "us-east-1"
  }
}
```

**Response** (201 Created):
```json
{
  "success": true,
  "data": {
    "id": "cred-123-abc",
    "name": "AWS Production Account",
    "description": "Main AWS production account credentials",
    "type": "aws",
    "createdBy": "admin@example.com",
    "createdAt": "2025-10-05T10:00:00Z",
    "updatedAt": "2025-10-05T10:00:00Z"
  }
}
```

**Error Responses**:
- `400 Bad Request` - Invalid credential data
- `409 Conflict` - Credential name already exists
- `401 Unauthorized` - Missing or invalid JWT token

---

### List Credentials

Retrieve all credentials with optional filtering.

**Endpoint**: `GET /api/v1/credentials`

**Query Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | No | Filter by credential type (aws, azure, gcp, ssh, api_key, snmp) |
| `limit` | number | No | Results per page (default: 50, max: 100) |
| `offset` | number | No | Pagination offset (default: 0) |

**Example Request**:
```bash
curl "http://localhost:3000/api/v1/credentials?type=aws&limit=20" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "credentials": [
      {
        "id": "cred-123-abc",
        "name": "AWS Production Account",
        "type": "aws",
        "createdBy": "admin@example.com",
        "createdAt": "2025-10-05T10:00:00Z",
        "lastUsedAt": "2025-10-05T14:30:00Z",
        "usageCount": 42
      },
      {
        "id": "cred-456-def",
        "name": "AWS Development Account",
        "type": "aws",
        "createdBy": "admin@example.com",
        "createdAt": "2025-10-04T09:00:00Z",
        "lastUsedAt": "2025-10-05T12:00:00Z",
        "usageCount": 15
      }
    ],
    "total": 2,
    "limit": 20,
    "offset": 0
  }
}
```

---

### Get Credential

Retrieve a specific credential by ID.

**Endpoint**: `GET /api/v1/credentials/:id`

**Example Request**:
```bash
curl http://localhost:3000/api/v1/credentials/cred-123-abc \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "cred-123-abc",
    "name": "AWS Production Account",
    "description": "Main AWS production account credentials",
    "type": "aws",
    "createdBy": "admin@example.com",
    "createdAt": "2025-10-05T10:00:00Z",
    "updatedAt": "2025-10-05T10:00:00Z",
    "lastUsedAt": "2025-10-05T14:30:00Z",
    "usageCount": 42
  }
}
```

**Error Responses**:
- `404 Not Found` - Credential not found
- `401 Unauthorized` - Missing or invalid JWT token

::: tip Credential Security
The API never returns actual credential values. Only metadata is returned for security.
:::

---

### Update Credential

Update credential metadata or credential values.

**Endpoint**: `PUT /api/v1/credentials/:id`

**Request Body**:
```json
{
  "name": "Updated AWS Account Name",
  "description": "Updated description",
  "credentials": {
    "accessKeyId": "NEW_ACCESS_KEY",
    "secretAccessKey": "NEW_SECRET_KEY",
    "region": "us-west-2"
  }
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "cred-123-abc",
    "name": "Updated AWS Account Name",
    "description": "Updated description",
    "type": "aws",
    "updatedAt": "2025-10-05T15:00:00Z"
  }
}
```

**Error Responses**:
- `400 Bad Request` - Invalid update data
- `404 Not Found` - Credential not found
- `409 Conflict` - New name already exists

---

### Delete Credential

Delete a credential. Fails if credential is referenced by any discovery definitions.

**Endpoint**: `DELETE /api/v1/credentials/:id`

**Example Request**:
```bash
curl -X DELETE http://localhost:3000/api/v1/credentials/cred-123-abc \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "deleted": true,
    "id": "cred-123-abc"
  }
}
```

**Error Responses**:
- `404 Not Found` - Credential not found
- `409 Conflict` - Credential in use by discovery definitions

---

### Test Credential

Test if credential successfully authenticates with the provider.

**Endpoint**: `POST /api/v1/credentials/:id/test`

**Example Request**:
```bash
curl -X POST http://localhost:3000/api/v1/credentials/cred-123-abc/test \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "valid": true,
    "message": "Successfully authenticated with AWS",
    "testedAt": "2025-10-05T15:30:00Z",
    "details": {
      "accountId": "123456789012",
      "region": "us-east-1"
    }
  }
}
```

**Failed Authentication**:
```json
{
  "success": false,
  "data": {
    "valid": false,
    "message": "Authentication failed: Invalid access key",
    "testedAt": "2025-10-05T15:30:00Z"
  }
}
```

---

## Discovery Definitions API

Manage reusable discovery configurations with scheduling.

### Create Definition

Create a new discovery definition.

**Endpoint**: `POST /api/v1/discovery/definitions`

**Request Body**:
```json
{
  "name": "AWS EC2 Production Scan",
  "description": "Hourly discovery of production EC2 instances",
  "provider": "aws",
  "credentialId": "cred-123-abc",
  "config": {
    "regions": ["us-east-1", "us-west-2", "eu-west-1"],
    "resourceTypes": ["ec2", "rds", "s3"],
    "tags": {
      "Environment": "production"
    }
  },
  "schedule": {
    "enabled": true,
    "cronPattern": "0 * * * *"
  },
  "enabled": true
}
```

**Response** (201 Created):
```json
{
  "success": true,
  "data": {
    "id": "def-456-xyz",
    "name": "AWS EC2 Production Scan",
    "description": "Hourly discovery of production EC2 instances",
    "provider": "aws",
    "credentialId": "cred-123-abc",
    "config": {
      "regions": ["us-east-1", "us-west-2", "eu-west-1"],
      "resourceTypes": ["ec2", "rds", "s3"],
      "tags": {
        "Environment": "production"
      }
    },
    "scheduleEnabled": true,
    "scheduleCronPattern": "0 * * * *",
    "enabled": true,
    "createdBy": "admin@example.com",
    "createdAt": "2025-10-05T10:00:00Z",
    "nextRunAt": "2025-10-05T11:00:00Z"
  }
}
```

**Error Responses**:
- `400 Bad Request` - Invalid configuration
- `404 Not Found` - Credential not found
- `409 Conflict` - Definition name already exists

---

### List Definitions

Retrieve all discovery definitions with optional filtering.

**Endpoint**: `GET /api/v1/discovery/definitions`

**Query Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `provider` | string | No | Filter by provider (aws, azure, gcp, ssh, nmap) |
| `enabled` | boolean | No | Filter by enabled status |
| `scheduleEnabled` | boolean | No | Filter by schedule status |
| `limit` | number | No | Results per page (default: 50) |
| `offset` | number | No | Pagination offset (default: 0) |

**Example Request**:
```bash
curl "http://localhost:3000/api/v1/discovery/definitions?provider=aws&enabled=true" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "definitions": [
      {
        "id": "def-456-xyz",
        "name": "AWS EC2 Production Scan",
        "provider": "aws",
        "enabled": true,
        "scheduleEnabled": true,
        "scheduleCronPattern": "0 * * * *",
        "lastRunAt": "2025-10-05T10:00:00Z",
        "nextRunAt": "2025-10-05T11:00:00Z",
        "createdAt": "2025-10-05T09:00:00Z"
      }
    ],
    "total": 1,
    "limit": 50,
    "offset": 0
  }
}
```

---

### Get Definition

Retrieve a specific discovery definition by ID.

**Endpoint**: `GET /api/v1/discovery/definitions/:id`

**Example Request**:
```bash
curl http://localhost:3000/api/v1/discovery/definitions/def-456-xyz \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "def-456-xyz",
    "name": "AWS EC2 Production Scan",
    "description": "Hourly discovery of production EC2 instances",
    "provider": "aws",
    "credentialId": "cred-123-abc",
    "config": {
      "regions": ["us-east-1", "us-west-2"],
      "resourceTypes": ["ec2", "rds"]
    },
    "scheduleEnabled": true,
    "scheduleCronPattern": "0 * * * *",
    "enabled": true,
    "createdBy": "admin@example.com",
    "createdAt": "2025-10-05T09:00:00Z",
    "updatedAt": "2025-10-05T09:00:00Z",
    "lastRunAt": "2025-10-05T10:00:00Z",
    "nextRunAt": "2025-10-05T11:00:00Z",
    "stats": {
      "totalRuns": 42,
      "successfulRuns": 40,
      "failedRuns": 2,
      "averageDuration": 45000,
      "lastSuccess": "2025-10-05T10:00:00Z",
      "lastFailure": "2025-10-04T14:00:00Z"
    }
  }
}
```

---

### Update Definition

Update a discovery definition.

**Endpoint**: `PUT /api/v1/discovery/definitions/:id`

**Request Body**:
```json
{
  "name": "Updated Definition Name",
  "description": "Updated description",
  "config": {
    "regions": ["us-east-1", "us-west-2", "eu-central-1"]
  },
  "schedule": {
    "cronPattern": "0 */2 * * *"
  }
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "def-456-xyz",
    "name": "Updated Definition Name",
    "description": "Updated description",
    "updatedAt": "2025-10-05T11:00:00Z",
    "nextRunAt": "2025-10-05T12:00:00Z"
  }
}
```

---

### Delete Definition

Delete a discovery definition. Job history is preserved.

**Endpoint**: `DELETE /api/v1/discovery/definitions/:id`

**Example Request**:
```bash
curl -X DELETE http://localhost:3000/api/v1/discovery/definitions/def-456-xyz \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "deleted": true,
    "id": "def-456-xyz"
  }
}
```

---

### Run Definition

Trigger a discovery definition to run immediately.

**Endpoint**: `POST /api/v1/discovery/definitions/:id/run`

**Example Request**:
```bash
curl -X POST http://localhost:3000/api/v1/discovery/definitions/def-456-xyz/run \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (202 Accepted):
```json
{
  "success": true,
  "data": {
    "jobId": "job-789-abc",
    "definitionId": "def-456-xyz",
    "status": "queued",
    "queueName": "discovery:aws",
    "queuedAt": "2025-10-05T11:30:00Z"
  }
}
```

---

### Enable Schedule

Enable automated scheduling for a discovery definition.

**Endpoint**: `POST /api/v1/discovery/definitions/:id/schedule/enable`

**Example Request**:
```bash
curl -X POST http://localhost:3000/api/v1/discovery/definitions/def-456-xyz/schedule/enable \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "def-456-xyz",
    "scheduleEnabled": true,
    "scheduleCronPattern": "0 * * * *",
    "nextRunAt": "2025-10-05T12:00:00Z"
  }
}
```

---

### Disable Schedule

Disable automated scheduling for a discovery definition.

**Endpoint**: `POST /api/v1/discovery/definitions/:id/schedule/disable`

**Example Request**:
```bash
curl -X POST http://localhost:3000/api/v1/discovery/definitions/def-456-xyz/schedule/disable \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "def-456-xyz",
    "scheduleEnabled": false,
    "nextRunAt": null
  }
}
```

---

### Get Definition Jobs

Retrieve all jobs for a specific discovery definition.

**Endpoint**: `GET /api/v1/discovery/definitions/:id/jobs`

**Query Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | No | Filter by job status (queued, active, completed, failed) |
| `limit` | number | No | Results per page (default: 50) |
| `offset` | number | No | Pagination offset (default: 0) |

**Example Request**:
```bash
curl "http://localhost:3000/api/v1/discovery/definitions/def-456-xyz/jobs?status=completed&limit=10" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "jobs": [
      {
        "id": "job-789-abc",
        "definitionId": "def-456-xyz",
        "status": "completed",
        "progress": 100,
        "startedAt": "2025-10-05T10:00:00Z",
        "completedAt": "2025-10-05T10:02:30Z",
        "duration": 150000,
        "result": {
          "discovered": 42,
          "created": 5,
          "updated": 37,
          "errors": 0
        }
      }
    ],
    "total": 42,
    "limit": 10,
    "offset": 0
  }
}
```

---

## Discovery Jobs API

### Get Job Status

Retrieve the status and details of a specific discovery job.

**Endpoint**: `GET /api/v1/discovery/jobs/:id`

**Example Request**:
```bash
curl http://localhost:3000/api/v1/discovery/jobs/job-789-abc \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "job-789-abc",
    "definitionId": "def-456-xyz",
    "provider": "aws",
    "status": "active",
    "progress": 65,
    "queueName": "discovery:aws",
    "queuedAt": "2025-10-05T10:00:00Z",
    "startedAt": "2025-10-05T10:00:05Z",
    "stats": {
      "discovered": 27,
      "created": 3,
      "updated": 24,
      "errors": 0
    }
  }
}
```

**Job Statuses**:
- `queued` - Job waiting to be processed
- `active` - Job currently running
- `completed` - Job finished successfully
- `failed` - Job failed with errors

---

### List Jobs

List all discovery jobs with optional filtering.

**Endpoint**: `GET /api/v1/discovery/jobs`

**Query Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `definitionId` | string | No | Filter by definition ID |
| `provider` | string | No | Filter by provider |
| `status` | string | No | Filter by status |
| `limit` | number | No | Results per page (default: 50) |
| `offset` | number | No | Pagination offset (default: 0) |

**Example Request**:
```bash
curl "http://localhost:3000/api/v1/discovery/jobs?provider=aws&status=completed" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "jobs": [
      {
        "id": "job-789-abc",
        "definitionId": "def-456-xyz",
        "provider": "aws",
        "status": "completed",
        "startedAt": "2025-10-05T10:00:00Z",
        "completedAt": "2025-10-05T10:02:30Z",
        "duration": 150000
      }
    ],
    "total": 125,
    "limit": 50,
    "offset": 0
  }
}
```

---

### Create Ad-Hoc Job

Create a one-time discovery job without using a definition.

**Endpoint**: `POST /api/v1/discovery/jobs`

**Request Body**:
```json
{
  "provider": "aws",
  "config": {
    "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
    "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "region": "us-east-1",
    "resourceTypes": ["ec2"]
  }
}
```

**Response** (202 Accepted):
```json
{
  "success": true,
  "data": {
    "jobId": "job-999-xyz",
    "status": "queued",
    "queueName": "discovery:aws",
    "queuedAt": "2025-10-05T11:45:00Z"
  }
}
```

::: warning Ad-Hoc Jobs
Ad-hoc jobs are not recommended for production use. They lack audit trails, reusability, and scheduling capabilities.
:::

---

## Error Responses

### Standard Error Format

All error responses follow this format:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {
      "field": "fieldName",
      "value": "invalidValue"
    }
  },
  "meta": {
    "timestamp": "2025-10-05T12:00:00Z",
    "requestId": "req-abc-123"
  }
}
```

### Common Error Codes

| Code | Status | Description |
|------|--------|-------------|
| `VALIDATION_ERROR` | 400 | Invalid request data |
| `UNAUTHORIZED` | 401 | Missing or invalid JWT token |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `CONFLICT` | 409 | Resource already exists or constraint violation |
| `INTERNAL_ERROR` | 500 | Server error |

---

## Rate Limiting

API endpoints are rate limited to prevent abuse:

- **Anonymous**: 100 requests per hour
- **Authenticated**: 1000 requests per hour
- **Admin**: 10000 requests per hour

Rate limit headers are included in all responses:

```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 995
X-RateLimit-Reset: 1633444800000
```

`X-RateLimit-Reset` is the reset time in Unix epoch milliseconds, not seconds.

---

## See Also

- [Discovery Guide](/getting-started/discovery-guide)
- [Credential Management](/components/credentials)
- [Discovery Definitions](/components/discovery-definitions)
- [GraphQL API](/api/graphql)
- [Authentication](/api/authentication)
