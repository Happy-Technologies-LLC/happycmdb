# CMDB API Documentation

## Overview

The CMDB (Configuration Management Database) API provides both REST and GraphQL interfaces for managing Configuration Items (CIs) and their relationships in an enterprise environment.

**Base URL (REST)**: `http://localhost:3000/api/v1`
**GraphQL Endpoint**: `http://localhost:3000/graphql`

---

## Table of Contents

1. [Authentication](#authentication)
2. [Rate Limiting](#rate-limiting)
3. [Error Codes](#error-codes)
4. [Pagination](#pagination)
5. [API Versioning](#api-versioning)
6. [REST API](#rest-api)
   - [CI Endpoints](#ci-endpoints)
   - [Relationship Endpoints](#relationship-endpoints)
   - [Discovery Endpoints](#discovery-endpoints)
   - [Search Endpoints](#search-endpoints)
   - [Analytics Endpoints](#analytics-endpoints)
7. [GraphQL API](#graphql-api)
   - [Queries](#queries)
   - [Mutations](#mutations)
   - [Types](#types)

---

## Authentication

The CMDB API supports two authentication methods:

### 1. API Key Authentication (Recommended for Service-to-Service)

Include an API key in the request header:

```bash
curl -X GET https://cmdb.example.com/api/v1/cis \
  -H "X-API-Key: your-api-key-here"
```

**Obtaining an API Key:**

```bash
# Generate new API key
curl -X POST https://cmdb.example.com/api/v1/auth/api-keys \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "integration-service",
    "scopes": ["read:cis", "write:cis"],
    "expiresIn": "90d"
  }'

# Response
{
  "success": true,
  "data": {
    "id": "key_abc123",
    "key": "cmdb_live_1234567890abcdef",
    "name": "integration-service",
    "scopes": ["read:cis", "write:cis"],
    "expiresAt": "2025-04-30T00:00:00Z"
  }
}
```

### 2. JWT Bearer Token Authentication (For User Sessions)

Obtain a JWT token by authenticating with username/password:

```bash
# Login to obtain JWT token
curl -X POST https://cmdb.example.com/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "secure-password"
  }'

# Response
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": 3600,
    "user": {
      "id": "user-123",
      "username": "admin",
      "roles": ["admin"]
    }
  }
}

# Use token in subsequent requests
curl -X GET https://cmdb.example.com/api/v1/cis \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

### Authentication Scopes

| Scope | Description |
|-------|-------------|
| `read:cis` | Read access to CIs |
| `write:cis` | Create and update CIs |
| `delete:cis` | Delete CIs |
| `read:relationships` | Read CI relationships |
| `write:relationships` | Create/update relationships |
| `read:discovery` | View discovery jobs |
| `write:discovery` | Schedule discovery jobs |
| `admin` | Full administrative access |

### Error Responses

**401 Unauthorized:**
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required. Please provide a valid API key or bearer token.",
    "details": {
      "requiredAuth": ["X-API-Key", "Authorization"]
    }
  }
}
```

**403 Forbidden:**
```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Insufficient permissions to access this resource.",
    "details": {
      "requiredScope": "write:cis",
      "userScopes": ["read:cis"]
    }
  }
}
```

---

## Rate Limiting

The API implements rate limiting to ensure fair usage and system stability.

### Rate Limit Rules

| Authentication | Rate Limit | Window |
|----------------|------------|--------|
| API Key | 1000 requests | 1 minute |
| JWT Token | 500 requests | 1 minute |
| Unauthenticated | 100 requests | 1 minute |

### Rate Limit Headers

Every API response includes rate limit information:

```http
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1640995200
```

### Rate Limit Exceeded Response

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded. Please retry after 60 seconds.",
    "details": {
      "limit": 1000,
      "remaining": 0,
      "resetAt": "2025-01-15T10:35:00Z",
      "retryAfter": 60
    }
  }
}
```

**HTTP Status Code:** `429 Too Many Requests`

### Best Practices

1. **Implement exponential backoff** when receiving 429 responses
2. **Cache responses** to reduce API calls
3. **Use webhooks** instead of polling for real-time updates
4. **Request a higher rate limit** for production integrations (contact support)

**Example with retry logic:**

```javascript
async function apiCallWithRetry(url, options, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url, options);

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('X-RateLimit-Reset'));
      await sleep((retryAfter || 60) * 1000);
      continue;
    }

    return response;
  }
  throw new Error('Max retries exceeded');
}
```

---

## Error Codes

The API uses standard HTTP status codes and returns detailed error information.

### HTTP Status Codes

| Code | Status | Description |
|------|--------|-------------|
| 200 | OK | Request successful |
| 201 | Created | Resource created successfully |
| 204 | No Content | Resource deleted successfully |
| 400 | Bad Request | Invalid request parameters |
| 401 | Unauthorized | Authentication required |
| 403 | Forbidden | Insufficient permissions |
| 404 | Not Found | Resource not found |
| 409 | Conflict | Resource already exists |
| 422 | Unprocessable Entity | Validation failed |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Server error |
| 503 | Service Unavailable | Service temporarily unavailable |

### Error Response Format

All error responses follow this structure:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {
      "field": "Additional context"
    },
    "requestId": "req_abc123xyz",
    "timestamp": "2025-01-15T10:30:00Z"
  }
}
```

### Common Error Codes

| Error Code | HTTP Status | Description |
|-----------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid authentication |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `VALIDATION_ERROR` | 422 | Request validation failed |
| `DUPLICATE_RESOURCE` | 409 | Resource already exists |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests |
| `DATABASE_ERROR` | 500 | Database operation failed |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
| `SERVICE_UNAVAILABLE` | 503 | Service temporarily down |

### Validation Error Example

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": {
      "errors": [
        {
          "field": "name",
          "message": "Name is required",
          "value": null
        },
        {
          "field": "type",
          "message": "Invalid CI type. Must be one of: server, virtual-machine, container",
          "value": "invalid-type"
        }
      ]
    },
    "requestId": "req_abc123xyz",
    "timestamp": "2025-01-15T10:30:00Z"
  }
}
```

---

## Pagination

All list endpoints support pagination to efficiently handle large datasets.

### Pagination Parameters

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `limit` | integer | 100 | 1000 | Number of results per page |
| `offset` | integer | 0 | - | Number of results to skip |
| `page` | integer | 1 | - | Page number (alternative to offset) |

### Pagination Methods

**Method 1: Offset-based (Default)**

```bash
# First page (results 0-99)
GET /api/v1/cis?limit=100&offset=0

# Second page (results 100-199)
GET /api/v1/cis?limit=100&offset=100

# Third page (results 200-299)
GET /api/v1/cis?limit=100&offset=200
```

**Method 2: Page-based**

```bash
# First page
GET /api/v1/cis?limit=100&page=1

# Second page
GET /api/v1/cis?limit=100&page=2
```

### Pagination Response

```json
{
  "success": true,
  "data": [ /* array of results */ ],
  "pagination": {
    "total": 500,
    "count": 100,
    "offset": 0,
    "limit": 100,
    "page": 1,
    "pageSize": 100,
    "totalPages": 5,
    "hasNext": true,
    "hasPrevious": false,
    "links": {
      "first": "/api/v1/cis?limit=100&offset=0",
      "last": "/api/v1/cis?limit=100&offset=400",
      "next": "/api/v1/cis?limit=100&offset=100",
      "previous": null
    }
  }
}
```

### Best Practices

1. **Use appropriate page sizes**: Smaller pages (50-100) for interactive use, larger (500-1000) for bulk operations
2. **Follow pagination links**: Use `links.next` instead of calculating offsets
3. **Cache results**: Implement client-side caching to reduce API calls
4. **Consider cursor-based pagination** for real-time data (coming soon)

---

## API Versioning

The API uses URL-based versioning to ensure backward compatibility.

### Current Version

**v1** (Current): `https://cmdb.example.com/api/v1`

### Version in URL

All REST API endpoints include the version in the URL path:

```bash
# Version 1 (current)
GET https://cmdb.example.com/api/v1/cis

# Future versions
GET https://cmdb.example.com/api/v2/cis
```

### GraphQL Versioning

GraphQL does not use URL versioning. Instead, fields are deprecated and new fields are added:

```graphql
type CI {
  id: ID!
  name: String!
  status: String! @deprecated(reason: "Use ciStatus instead")
  ciStatus: CIStatus!  # New field
}
```

### Version Header

Optionally specify API version via header:

```bash
curl -X GET https://cmdb.example.com/api/cis \
  -H "X-API-Version: v1"
```

### Breaking Changes Policy

- **Major versions** (v1 → v2): May introduce breaking changes
- **Minor updates**: Backward compatible enhancements
- **Deprecation period**: Minimum 6 months notice before removal
- **Version support**: Last 2 major versions supported

### Checking API Version

```bash
# Get current API version
GET /api/version

# Response
{
  "success": true,
  "data": {
    "version": "v1",
    "buildNumber": "1.0.0",
    "buildDate": "2025-01-15T00:00:00Z",
    "deprecatedVersions": [],
    "supportedVersions": ["v1"]
  }
}
```

---

## REST API

### CI Endpoints

#### Get All CIs

Get a paginated list of configuration items with optional filtering.

**Endpoint**: `GET /cis`

**Query Parameters**:
- `type` (optional): CI type filter (server, virtual-machine, container, etc.)
- `status` (optional): CI status filter (active, inactive, maintenance, decommissioned)
- `environment` (optional): Environment filter (production, staging, development, test)
- `limit` (optional): Maximum number of results (default: 100, max: 1000)
- `offset` (optional): Number of results to skip (default: 0)

**Example Request**:
```bash
GET /cis?type=server&status=active&limit=50&offset=0
```

**Example Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "ci-123e4567-e89b-12d3-a456-426614174000",
      "external_id": "i-0123456789abcdef0",
      "name": "web-server-01",
      "type": "server",
      "status": "active",
      "environment": "production",
      "created_at": "2025-01-15T10:30:00Z",
      "updated_at": "2025-01-15T10:30:00Z",
      "discovered_at": "2025-01-15T10:30:00Z",
      "metadata": {
        "ip_address": "10.0.1.100",
        "hostname": "web01.example.com",
        "os": "Ubuntu 22.04"
      }
    }
  ],
  "pagination": {
    "total": 150,
    "count": 50,
    "offset": 0,
    "limit": 50,
    "page": 1,
    "pageSize": 50,
    "totalPages": 3
  }
}
```

---

#### Get CI by ID

Retrieve a specific configuration item by its unique identifier.

**Endpoint**: `GET /cis/:id`

**Path Parameters**:
- `id` (required): CI unique identifier

**Example Request**:
```bash
GET /cis/ci-123e4567-e89b-12d3-a456-426614174000
```

**Example Response**:
```json
{
  "success": true,
  "data": {
    "id": "ci-123e4567-e89b-12d3-a456-426614174000",
    "external_id": "i-0123456789abcdef0",
    "name": "web-server-01",
    "type": "server",
    "status": "active",
    "environment": "production",
    "created_at": "2025-01-15T10:30:00Z",
    "updated_at": "2025-01-15T10:30:00Z",
    "discovered_at": "2025-01-15T10:30:00Z",
    "metadata": {
      "ip_address": "10.0.1.100",
      "hostname": "web01.example.com",
      "os": "Ubuntu 22.04",
      "cpu_cores": 4,
      "memory_gb": 16
    }
  }
}
```

**Error Response (404)**:
```json
{
  "success": false,
  "error": "Not Found",
  "message": "CI with ID 'ci-123' not found"
}
```

---

#### Create CI

Create a new configuration item.

**Endpoint**: `POST /cis`

**Request Body**:
```json
{
  "id": "ci-123e4567-e89b-12d3-a456-426614174000",
  "external_id": "i-0123456789abcdef0",
  "name": "web-server-01",
  "type": "server",
  "status": "active",
  "environment": "production",
  "metadata": {
    "ip_address": "10.0.1.100",
    "hostname": "web01.example.com",
    "os": "Ubuntu 22.04"
  }
}
```

**Example Response (201)**:
```json
{
  "success": true,
  "data": {
    "id": "ci-123e4567-e89b-12d3-a456-426614174000",
    "external_id": "i-0123456789abcdef0",
    "name": "web-server-01",
    "type": "server",
    "status": "active",
    "environment": "production",
    "created_at": "2025-01-15T10:30:00Z",
    "updated_at": "2025-01-15T10:30:00Z",
    "discovered_at": "2025-01-15T10:30:00Z",
    "metadata": {
      "ip_address": "10.0.1.100",
      "hostname": "web01.example.com",
      "os": "Ubuntu 22.04"
    }
  },
  "message": "CI created successfully"
}
```

**Validation Errors (400)**:
```json
{
  "success": false,
  "error": "Bad Request",
  "message": "Missing required fields: id, name, type"
}
```

**Conflict Error (409)**:
```json
{
  "success": false,
  "error": "Conflict",
  "message": "CI with this ID already exists"
}
```

---

#### Update CI

Update an existing configuration item.

**Endpoint**: `PUT /cis/:id`

**Path Parameters**:
- `id` (required): CI unique identifier

**Request Body** (all fields optional):
```json
{
  "name": "web-server-01-updated",
  "status": "maintenance",
  "environment": "production",
  "metadata": {
    "ip_address": "10.0.1.100",
    "updated": true
  }
}
```

**Example Response (200)**:
```json
{
  "success": true,
  "data": {
    "id": "ci-123e4567-e89b-12d3-a456-426614174000",
    "name": "web-server-01-updated",
    "type": "server",
    "status": "maintenance",
    "environment": "production",
    "created_at": "2025-01-15T10:30:00Z",
    "updated_at": "2025-01-15T14:45:00Z",
    "discovered_at": "2025-01-15T10:30:00Z",
    "metadata": {
      "ip_address": "10.0.1.100",
      "updated": true
    }
  },
  "message": "CI updated successfully"
}
```

---

#### Delete CI

Delete a configuration item and all its relationships.

**Endpoint**: `DELETE /cis/:id`

**Path Parameters**:
- `id` (required): CI unique identifier

**Example Request**:
```bash
DELETE /cis/ci-123e4567-e89b-12d3-a456-426614174000
```

**Example Response (204)**:
```
No content
```

**Error Response (404)**:
```json
{
  "success": false,
  "error": "Not Found",
  "message": "CI with ID 'ci-123' not found"
}
```

---

#### Get CI Relationships

Get all relationships for a specific CI.

**Endpoint**: `GET /cis/:id/relationships`

**Path Parameters**:
- `id` (required): CI unique identifier

**Query Parameters**:
- `direction` (optional): Relationship direction (in, out, both) - default: both

**Example Request**:
```bash
GET /cis/ci-123e4567-e89b-12d3-a456-426614174000/relationships?direction=out
```

**Example Response**:
```json
{
  "success": true,
  "data": [
    {
      "type": "HOSTS",
      "ci": {
        "id": "ci-app-001",
        "name": "web-application",
        "type": "application",
        "status": "active",
        "environment": "production"
      },
      "properties": {
        "port": 8080,
        "protocol": "HTTP"
      }
    },
    {
      "type": "DEPENDS_ON",
      "ci": {
        "id": "ci-db-001",
        "name": "postgres-database",
        "type": "database",
        "status": "active"
      },
      "properties": {}
    }
  ],
  "count": 2
}
```

---

#### Get CI Dependencies

Get all dependencies for a CI (recursive query).

**Endpoint**: `GET /cis/:id/dependencies`

**Path Parameters**:
- `id` (required): CI unique identifier

**Query Parameters**:
- `depth` (optional): Maximum dependency depth (1-10, default: 5)

**Example Request**:
```bash
GET /cis/ci-app-001/dependencies?depth=3
```

**Example Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "ci-db-001",
      "name": "postgres-database",
      "type": "database",
      "status": "active"
    },
    {
      "id": "ci-cache-001",
      "name": "redis-cache",
      "type": "service",
      "status": "active"
    }
  ],
  "count": 2,
  "depth": 3
}
```

---

#### Get Impact Analysis

Analyze the impact of changes to a CI (shows all CIs that depend on it).

**Endpoint**: `GET /cis/:id/impact`

**Path Parameters**:
- `id` (required): CI unique identifier

**Query Parameters**:
- `depth` (optional): Maximum impact depth (1-10, default: 5)

**Example Request**:
```bash
GET /cis/ci-db-001/impact?depth=5
```

**Example Response**:
```json
{
  "success": true,
  "data": [
    {
      "ci": {
        "id": "ci-app-001",
        "name": "web-application",
        "type": "application",
        "status": "active"
      },
      "distance": 1
    },
    {
      "ci": {
        "id": "ci-server-001",
        "name": "web-server-01",
        "type": "server",
        "status": "active"
      },
      "distance": 2
    }
  ],
  "totalImpacted": 2,
  "depth": 5
}
```

---

#### Search CIs

Full-text search across CI names and external IDs.

**Endpoint**: `POST /cis/search`

**Request Body**:
```json
{
  "query": "web-server",
  "limit": 50
}
```

**Example Response**:
```json
{
  "success": true,
  "data": [
    {
      "ci": {
        "id": "ci-server-001",
        "name": "web-server-01",
        "type": "server",
        "status": "active"
      },
      "score": 0.95
    },
    {
      "ci": {
        "id": "ci-server-002",
        "name": "web-server-02",
        "type": "server",
        "status": "active"
      },
      "score": 0.85
    }
  ],
  "count": 2,
  "query": "web-server"
}
```

---

### Relationship Endpoints

#### List Relationships

List all relationships with filtering.

**Endpoint**: `GET /relationships`

**Query Parameters**:
- `type` (optional): Relationship type filter
- `from_id` (optional): Source CI filter
- `to_id` (optional): Target CI filter
- `ci_id` (optional): Filter where CI is source OR target
- `limit` (optional): Max results (default: 100, max: 1000)
- `offset` (optional): Results to skip (default: 0)

**Example Request**:
```bash
GET /relationships?type=DEPENDS_ON&limit=50
```

**Example Response**:
```json
{
  "success": true,
  "data": [
    {
      "from_id": "ci-app-001",
      "from_name": "web-application",
      "from_type": "application",
      "to_id": "ci-db-001",
      "to_name": "postgres-database",
      "to_type": "database",
      "type": "DEPENDS_ON",
      "properties": {
        "connection_string": "encrypted"
      },
      "created_at": "2025-01-15T10:30:00Z"
    }
  ],
  "pagination": {
    "total": 250,
    "count": 50,
    "offset": 0,
    "limit": 50
  }
}
```

---

#### Create Relationship

Create a new relationship between two CIs.

**Endpoint**: `POST /relationships`

**Request Body**:
```json
{
  "from_id": "ci-server-001",
  "to_id": "ci-app-001",
  "type": "HOSTS",
  "properties": {
    "port": 8080,
    "protocol": "HTTP"
  }
}
```

**Example Response (201)**:
```json
{
  "success": true,
  "data": {
    "from_id": "ci-server-001",
    "from_name": "web-server-01",
    "from_type": "server",
    "to_id": "ci-app-001",
    "to_name": "web-application",
    "to_type": "application",
    "type": "HOSTS",
    "properties": {
      "port": 8080,
      "protocol": "HTTP"
    }
  },
  "message": "Relationship created successfully"
}
```

**Validation Errors**:
- **400**: Missing required fields
- **404**: Source or target CI not found
- **400**: Cannot create self-relationship
- **409**: Relationship already exists

---

#### Delete Relationship

Delete a relationship between two CIs.

**Endpoint**: `DELETE /relationships`

**Query Parameters**:
- `from_id` (required): Source CI ID
- `to_id` (required): Target CI ID
- `type` (required): Relationship type

**Example Request**:
```bash
DELETE /relationships?from_id=ci-server-001&to_id=ci-app-001&type=HOSTS
```

**Example Response (200)**:
```json
{
  "success": true,
  "message": "Relationship deleted successfully",
  "data": {
    "from_id": "ci-server-001",
    "to_id": "ci-app-001",
    "type": "HOSTS"
  }
}
```

---

#### Get Relationships by Type

Get all relationships of a specific type.

**Endpoint**: `GET /relationships/type/:type`

**Path Parameters**:
- `type` (required): Relationship type (DEPENDS_ON, HOSTS, CONNECTS_TO, etc.)

**Query Parameters**:
- `limit` (optional): Max results (default: 100, max: 1000)
- `offset` (optional): Results to skip (default: 0)

**Example Request**:
```bash
GET /relationships/type/DEPENDS_ON?limit=50
```

---

### Discovery Endpoints

#### Schedule Discovery Job

Schedule a new discovery job for a cloud provider or infrastructure.

**Endpoint**: `POST /discovery/schedule`

**Request Body**:
```json
{
  "provider": "aws",
  "config": {
    "regions": ["us-east-1", "us-west-2"],
    "resource_types": ["ec2", "rds", "s3"],
    "credentials": {
      "access_key_id": "AKIAIOSFODNN7EXAMPLE",
      "secret_access_key": "encrypted"
    }
  }
}
```

**Example Response (201)**:
```json
{
  "success": true,
  "data": {
    "id": "job-123e4567-e89b-12d3-a456-426614174000",
    "provider": "aws",
    "status": "pending",
    "created_at": "2025-01-15T10:30:00Z"
  },
  "message": "Discovery job scheduled successfully"
}
```

---

#### Get Job Status

Get the status of a discovery job.

**Endpoint**: `GET /discovery/jobs/:id`

**Path Parameters**:
- `id` (required): Job ID

**Example Response**:
```json
{
  "success": true,
  "data": {
    "id": "job-123e4567-e89b-12d3-a456-426614174000",
    "provider": "aws",
    "status": "completed",
    "progress": 100,
    "result": {
      "discovered_cis": 150,
      "new_cis": 10,
      "updated_cis": 140
    },
    "queue": "discovery:aws",
    "attemptsMade": 1,
    "processedOn": 1705315800000,
    "finishedOn": 1705316100000
  }
}
```

**Job Status Values**:
- `pending`: Job is queued
- `running`: Job is executing
- `completed`: Job finished successfully
- `failed`: Job encountered an error

---

#### List Discovery Jobs

List all discovery jobs with filtering.

**Endpoint**: `GET /discovery/jobs`

**Query Parameters**:
- `status` (optional): Filter by status
- `provider` (optional): Filter by provider
- `limit` (optional): Max results (default: 100, max: 1000)
- `offset` (optional): Results to skip (default: 0)

**Example Request**:
```bash
GET /discovery/jobs?status=running&provider=aws&limit=20
```

**Example Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "job-001",
      "provider": "aws",
      "status": "running",
      "created_at": "2025-01-15T10:30:00Z",
      "queue": "discovery:aws"
    }
  ],
  "pagination": {
    "total": 45,
    "count": 20,
    "offset": 0,
    "limit": 20
  }
}
```

---

#### Cancel Discovery Job

Cancel a pending or running discovery job.

**Endpoint**: `DELETE /discovery/jobs/:id`

**Path Parameters**:
- `id` (required): Job ID

**Example Response**:
```json
{
  "success": true,
  "message": "Discovery job cancelled successfully",
  "data": {
    "id": "job-123",
    "previousState": "running"
  }
}
```

---

### Search Endpoints

#### Advanced Search

Perform advanced search with multiple filters.

**Endpoint**: `POST /search/advanced`

**Request Body**:
```json
{
  "query": "web",
  "type": "server",
  "status": "active",
  "environment": "production",
  "metadata_filters": {
    "region": "us-east-1"
  },
  "limit": 50,
  "offset": 0
}
```

**Example Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "ci-server-001",
      "name": "web-server-01",
      "type": "server",
      "status": "active",
      "environment": "production",
      "metadata": {
        "region": "us-east-1"
      }
    }
  ],
  "pagination": {
    "total": 15,
    "count": 15,
    "offset": 0,
    "limit": 50
  },
  "query": "web",
  "filters": {
    "type": "server",
    "status": "active",
    "environment": "production",
    "metadata_filters": {
      "region": "us-east-1"
    }
  }
}
```

---

#### Full-Text Search

Full-text search using Neo4j full-text index.

**Endpoint**: `POST /search/fulltext`

**Request Body**:
```json
{
  "query": "production database",
  "limit": 50
}
```

**Example Response**:
```json
{
  "success": true,
  "data": [
    {
      "ci": {
        "id": "ci-db-001",
        "name": "production-database-01",
        "type": "database",
        "status": "active"
      },
      "score": 0.95
    }
  ],
  "count": 1,
  "query": "production database"
}
```

---

#### Search by Relationship Pattern

Find CIs matching a specific relationship pattern.

**Endpoint**: `POST /search/relationships`

**Request Body**:
```json
{
  "ci_type": "server",
  "relationship_type": "HOSTS",
  "related_ci_type": "application",
  "limit": 50
}
```

**Example Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "ci-server-001",
      "name": "web-server-01",
      "type": "server",
      "status": "active"
    }
  ],
  "count": 1,
  "pattern": {
    "ci_type": "server",
    "relationship_type": "HOSTS",
    "related_ci_type": "application"
  }
}
```

---

#### Get Orphaned CIs

Get CIs with no relationships.

**Endpoint**: `GET /search/orphaned`

**Query Parameters**:
- `limit` (optional): Max results (default: 100, max: 1000)
- `offset` (optional): Results to skip (default: 0)

**Example Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "ci-orphan-001",
      "name": "isolated-server",
      "type": "server",
      "status": "inactive"
    }
  ],
  "pagination": {
    "total": 5,
    "count": 5,
    "offset": 0,
    "limit": 100
  }
}
```

---

### Analytics Endpoints

#### Dashboard Statistics

Get comprehensive dashboard statistics.

**Endpoint**: `GET /analytics/dashboard`

**Example Response**:
```json
{
  "success": true,
  "data": {
    "summary": {
      "total_cis": 1500,
      "unique_types": 8,
      "unique_environments": 4,
      "total_relationships": 3200,
      "recent_discoveries_24h": 45
    },
    "breakdown": {
      "by_type": [
        {"ci_type": "server", "count": 450},
        {"ci_type": "application", "count": 380},
        {"ci_type": "database", "count": 200}
      ],
      "by_status": [
        {"status": "active", "count": 1200},
        {"status": "inactive", "count": 150},
        {"status": "maintenance", "count": 100}
      ],
      "by_environment": [
        {"environment": "production", "count": 800},
        {"environment": "staging", "count": 400}
      ]
    }
  }
}
```

---

#### CI Counts by Type

**Endpoint**: `GET /analytics/ci-counts`

**Example Response**:
```json
{
  "success": true,
  "data": [
    {"ci_type": "server", "count": 450},
    {"ci_type": "application", "count": 380},
    {"ci_type": "database", "count": 200},
    {"ci_type": "container", "count": 150}
  ]
}
```

---

#### Discovery Statistics

**Endpoint**: `GET /analytics/discovery-stats`

**Query Parameters**:
- `start_date` (optional): Start date filter (ISO 8601)
- `end_date` (optional): End date filter (ISO 8601)

**Example Response**:
```json
{
  "success": true,
  "data": {
    "summary": {
      "total_cis": 1500,
      "unique_types": 8,
      "first_discovery": "2024-01-01T00:00:00Z",
      "last_discovery": "2025-01-15T14:30:00Z"
    },
    "by_provider": [
      {"discovery_provider": "aws", "count": 800},
      {"discovery_provider": "azure", "count": 500}
    ]
  }
}
```

---

#### Top Connected CIs

**Endpoint**: `GET /analytics/top-connected`

**Query Parameters**:
- `limit` (optional): Max results (default: 10, max: 100)
- `direction` (optional): Relationship direction (in, out, both) - default: both

**Example Response**:
```json
{
  "success": true,
  "data": [
    {
      "ci_id": "ci-db-001",
      "ci_name": "main-database",
      "ci_type": "database",
      "relationship_count": 45
    },
    {
      "ci_id": "ci-server-001",
      "ci_name": "app-server-01",
      "ci_type": "server",
      "relationship_count": 32
    }
  ],
  "direction": "both"
}
```

---

## GraphQL API

### Queries

#### getCIs

Get all CIs with optional filtering and pagination.

**Query**:
```graphql
query GetCIs(
  $filter: SearchCIFilter
  $limit: Int
  $offset: Int
) {
  getCIs(filter: $filter, limit: $limit, offset: $offset) {
    id
    externalId
    name
    type
    status
    environment
    createdAt
    updatedAt
    discoveredAt
    metadata
  }
}
```

**Variables**:
```json
{
  "filter": {
    "type": "SERVER",
    "status": "ACTIVE",
    "environment": "PRODUCTION"
  },
  "limit": 50,
  "offset": 0
}
```

---

#### getCI

Get a single CI by ID.

**Query**:
```graphql
query GetCI($id: ID!) {
  getCI(id: $id) {
    id
    name
    type
    status
    environment
    relationships {
      type
      ci {
        id
        name
        type
      }
    }
    dependents {
      type
      ci {
        id
        name
      }
    }
  }
}
```

**Variables**:
```json
{
  "id": "ci-123e4567-e89b-12d3-a456-426614174000"
}
```

---

#### searchCIs

Full-text search for CIs.

**Query**:
```graphql
query SearchCIs($query: String!, $filter: SearchCIFilter, $limit: Int) {
  searchCIs(query: $query, filter: $filter, limit: $limit) {
    id
    name
    type
    status
    environment
  }
}
```

**Variables**:
```json
{
  "query": "web-server",
  "filter": {
    "type": "SERVER",
    "environment": "PRODUCTION"
  },
  "limit": 50
}
```

---

#### getCIRelationships

Get relationships for a specific CI.

**Query**:
```graphql
query GetCIRelationships($id: ID!, $direction: String) {
  getCIRelationships(id: $id, direction: $direction) {
    type
    ci {
      id
      name
      type
      status
    }
    properties
  }
}
```

**Variables**:
```json
{
  "id": "ci-server-001",
  "direction": "out"
}
```

---

#### getCIDependencies

Get all dependencies for a CI (recursive).

**Query**:
```graphql
query GetCIDependencies($id: ID!, $depth: Int) {
  getCIDependencies(id: $id, depth: $depth) {
    id
    name
    type
    status
  }
}
```

---

#### getImpactAnalysis

Perform impact analysis for a CI.

**Query**:
```graphql
query GetImpactAnalysis($id: ID!, $depth: Int) {
  getImpactAnalysis(id: $id, depth: $depth) {
    ci {
      id
      name
      type
      status
    }
    distance
  }
}
```

---

### Mutations

#### createCI

Create a new CI.

**Mutation**:
```graphql
mutation CreateCI($input: CreateCIInput!) {
  createCI(input: $input) {
    id
    name
    type
    status
    environment
    createdAt
    updatedAt
  }
}
```

**Variables**:
```json
{
  "input": {
    "id": "ci-new-001",
    "name": "web-server-03",
    "type": "SERVER",
    "status": "ACTIVE",
    "environment": "PRODUCTION",
    "metadata": {
      "ip_address": "10.0.1.103",
      "region": "us-east-1"
    }
  }
}
```

---

#### updateCI

Update an existing CI.

**Mutation**:
```graphql
mutation UpdateCI($id: ID!, $input: UpdateCIInput!) {
  updateCI(id: $id, input: $input) {
    id
    name
    status
    environment
    updatedAt
  }
}
```

**Variables**:
```json
{
  "id": "ci-server-001",
  "input": {
    "name": "web-server-01-updated",
    "status": "MAINTENANCE"
  }
}
```

---

#### deleteCI

Delete a CI.

**Mutation**:
```graphql
mutation DeleteCI($id: ID!) {
  deleteCI(id: $id)
}
```

---

#### createRelationship

Create a relationship between two CIs.

**Mutation**:
```graphql
mutation CreateRelationship($input: CreateRelationshipInput!) {
  createRelationship(input: $input)
}
```

**Variables**:
```json
{
  "input": {
    "fromId": "ci-server-001",
    "toId": "ci-app-001",
    "type": "HOSTS",
    "properties": {
      "port": 8080
    }
  }
}
```

---

#### deleteRelationship

Delete a relationship.

**Mutation**:
```graphql
mutation DeleteRelationship($fromId: ID!, $toId: ID!, $type: RelationshipType!) {
  deleteRelationship(fromId: $fromId, toId: $toId, type: $type)
}
```

---

### Types

#### CI Type
- `SERVER`
- `VIRTUAL_MACHINE`
- `CONTAINER`
- `APPLICATION`
- `SERVICE`
- `DATABASE`
- `NETWORK_DEVICE`
- `STORAGE`
- `LOAD_BALANCER`
- `CLOUD_RESOURCE`

#### CI Status
- `ACTIVE`
- `INACTIVE`
- `MAINTENANCE`
- `DECOMMISSIONED`

#### Environment
- `PRODUCTION`
- `STAGING`
- `DEVELOPMENT`
- `TEST`

#### Relationship Type
- `DEPENDS_ON`
- `HOSTS`
- `CONNECTS_TO`
- `USES`
- `OWNED_BY`
- `PART_OF`
- `DEPLOYED_ON`
- `BACKED_UP_BY`

---

## Error Handling

All API endpoints return consistent error responses:

**Error Response Format**:
```json
{
  "success": false,
  "error": "Error Type",
  "message": "Detailed error message"
}
```

**Common HTTP Status Codes**:
- `200 OK`: Successful GET/PUT/DELETE
- `201 Created`: Successful POST
- `204 No Content`: Successful DELETE with no response body
- `400 Bad Request`: Invalid input or validation error
- `404 Not Found`: Resource not found
- `409 Conflict`: Resource already exists
- `500 Internal Server Error`: Server error

---

## Rate Limiting

API requests are rate-limited to prevent abuse:

- **REST API**: 1000 requests per minute per IP
- **GraphQL API**: 100 queries per minute per IP
- **Heavy queries** (impact analysis, dependencies): 10 per minute

Rate limit headers:
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1705316400
```

---

## Authentication

**Note**: Authentication is not implemented in Phase 2. Future implementation will use API keys.

Expected header format:
```
Authorization: Bearer YOUR_API_KEY
```

---

## Pagination

All list endpoints support pagination:

**Query Parameters**:
- `limit`: Maximum number of results (default varies by endpoint)
- `offset`: Number of results to skip

**Response Format**:
```json
{
  "data": [...],
  "pagination": {
    "total": 1500,
    "count": 50,
    "offset": 0,
    "limit": 50,
    "page": 1,
    "pageSize": 50,
    "totalPages": 30
  }
}
```

---

## Best Practices

1. **Use appropriate endpoints**: Use GraphQL for complex queries with nested data, REST for simple CRUD operations
2. **Filter early**: Apply filters to reduce data transfer
3. **Use pagination**: Always paginate large result sets
4. **Batch operations**: Use GraphQL for fetching related data to avoid N+1 queries
5. **Cache responses**: CI data changes infrequently - cache where appropriate
6. **Handle errors gracefully**: Always check `success` field in responses

---

## Support

For issues or questions:
- GitHub Issues: https://github.com/your-org/happycmdb/issues
- Documentation: https://docs.happycmdb.io
- Email: support@happycmdb.io
