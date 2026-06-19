# HappyCMDB OpenAPI Documentation

This directory contains the comprehensive OpenAPI 3.0 specification for the HappyCMDB REST API.

## Overview

- **OpenAPI Version**: 3.0.0
- **API Version**: 2.0.0
- **Total Endpoints**: 100+
- **Specification File**: `openapi.yaml`

## Quick Start

### Access Swagger UI

When the API server is running:

```
http://localhost:3000/api-docs
```

This provides an interactive UI to explore and test all API endpoints.

### Download OpenAPI Specification

**JSON Format**:
```
http://localhost:3000/api-docs/openapi.json
```

**YAML Format**:
```
http://localhost:3000/api-docs/openapi.yaml
```

## API Endpoints Overview

### Authentication (`/api/v1/auth`)
- `POST /auth/login` - User login with JWT
- `POST /auth/api-keys` - Create API key
- `GET /auth/api-keys` - List API keys
- `DELETE /auth/api-keys/{keyId}` - Revoke API key

### Configuration Items (`/api/v1/cis`)
- `GET /cis` - List all CIs with filtering
- `POST /cis` - Create new CI
- `GET /cis/{id}` - Get CI by ID
- `PUT /cis/{id}` - Update CI
- `DELETE /cis/{id}` - Delete CI
- `POST /cis/search` - Search CIs
- `GET /cis/{id}/relationships` - Get CI relationships
- `GET /cis/{id}/dependencies` - Get dependency tree
- `GET /cis/{id}/impact` - Impact analysis
- `GET /cis/{id}/audit` - Audit history

### Relationships (`/api/v1/relationships`)
- `GET /relationships` - List relationships
- `POST /relationships` - Create relationship
- `DELETE /relationships/{id}` - Delete relationship
- `GET /relationships/type/{type}` - Get by type

### Search (`/api/v1/search`)
- `POST /search/advanced` - Advanced search with filters
- `POST /search/fulltext` - Full-text search
- `POST /search/relationships` - Search by relationship pattern
- `GET /search/orphaned` - Get orphaned CIs

### Credentials (`/api/v1/credentials`)
- `GET /credentials` - List credentials
- `POST /credentials` - Create credential
- `GET /credentials/{id}` - Get credential
- `PUT /credentials/{id}` - Update credential
- `DELETE /credentials/{id}` - Delete credential
- `POST /credentials/match` - Match best credential
- `POST /credentials/rank` - Rank credentials
- `POST /credentials/{id}/validate` - Validate credential

### Credential Sets (`/api/v1/credential-sets`)
- `GET /credential-sets` - List sets
- `POST /credential-sets` - Create set
- `GET /credential-sets/{id}` - Get set
- `PUT /credential-sets/{id}` - Update set
- `DELETE /credential-sets/{id}` - Delete set
- `POST /credential-sets/{id}/select` - Select credentials

### Discovery Definitions (`/api/v1/discovery/definitions`)
- `GET /discovery/definitions` - List definitions
- `POST /discovery/definitions` - Create definition
- `GET /discovery/definitions/{id}` - Get definition
- `PUT /discovery/definitions/{id}` - Update definition
- `DELETE /discovery/definitions/{id}` - Delete definition
- `POST /discovery/definitions/{id}/run` - Run discovery
- `POST /discovery/definitions/{id}/schedule/enable` - Enable schedule
- `POST /discovery/definitions/{id}/schedule/disable` - Disable schedule

### Discovery Agents (`/api/v1/agents`)
- `GET /agents` - List agents
- `POST /agents/register` - Register agent
- `POST /agents/heartbeat` - Update heartbeat
- `POST /agents/find-best` - Find best agent
- `GET /agents/{agentId}` - Get agent
- `DELETE /agents/{agentId}` - Delete agent

### Connectors (`/api/v1/connectors`)
- `GET /connectors/registry` - Browse registry
- `GET /connectors/registry/{type}` - Get connector details
- `GET /connectors/installed` - List installed
- `GET /connectors/installed/{type}` - Get installed details
- `POST /connectors/install` - Install connector
- `PUT /connectors/{type}/update` - Update connector
- `DELETE /connectors/{type}` - Uninstall connector
- `POST /connectors/{type}/verify` - Verify installation
- `GET /connectors/outdated` - Check for updates
- `POST /connectors/cache/refresh` - Refresh cache

### Reconciliation (`/api/v1/reconciliation`)
- `POST /reconciliation/match` - Find matching CIs
- `POST /reconciliation/merge` - Merge CI
- `GET /reconciliation/conflicts` - List conflicts
- `POST /reconciliation/conflicts/{id}/resolve` - Resolve conflict
- `GET /reconciliation/rules` - List rules
- `POST /reconciliation/rules` - Create rule
- `GET /reconciliation/lineage/{ci_id}` - Get CI lineage

### Analytics (`/api/v1/analytics`)
- `GET /analytics/dashboard` - Dashboard statistics
- `GET /analytics/ci-counts` - CI counts by type
- `GET /analytics/discovery-stats` - Discovery statistics

### Anomalies (`/api/v1/anomalies`)
- `GET /anomalies/recent` - Recent anomalies
- `GET /anomalies/ci/{ciId}` - Anomalies for CI
- `GET /anomalies/stats` - Statistics
- `PATCH /anomalies/{id}/status` - Update status
- `POST /anomalies/detect` - Run detection

### Jobs (`/api/v1/jobs`)
- `GET /jobs/stats` - Job statistics
- `GET /jobs/discovery` - List discovery jobs
- `POST /jobs/discovery/{provider}` - Trigger discovery
- `GET /jobs/{queueName}/{jobId}` - Get job status
- `DELETE /jobs/{queueName}/{jobId}` - Cancel job
- `POST /jobs/{queueName}/{jobId}/retry` - Retry job

### Health (`/api/v1/cmdb-health`)
- `GET /cmdb-health` - System health check

## Authentication

All API endpoints (except `/auth/login` and `/cmdb-health`) require authentication.

### JWT Token Authentication

1. Login to get token:
```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"password123"}'
```

2. Use token in requests:
```bash
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:3000/api/v1/cis
```

### API Key Authentication

1. Create API key:
```bash
curl -X POST http://localhost:3000/api/v1/auth/api-keys \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Production Automation"}'
```

2. Use API key in requests:
```bash
curl -H "X-API-Key: YOUR_API_KEY" \
  http://localhost:3000/api/v1/cis
```

## Rate Limiting

- **Standard**: 1000 requests/hour
- **Burst**: 100 requests/minute

Rate limit headers in responses:
- `X-RateLimit-Limit`: Maximum requests
- `X-RateLimit-Remaining`: Remaining requests
- `X-RateLimit-Reset`: Reset timestamp

## Common Response Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 201 | Created |
| 204 | No Content (successful deletion) |
| 400 | Bad Request (validation error) |
| 401 | Unauthorized (authentication required) |
| 403 | Forbidden (insufficient permissions) |
| 404 | Not Found |
| 409 | Conflict (duplicate resource) |
| 429 | Too Many Requests (rate limit) |
| 500 | Internal Server Error |
| 503 | Service Unavailable |

## Reusable Schemas

The OpenAPI spec defines comprehensive schemas for:

### Core Types
- `CI` - Configuration Item
- `CIType` - CI type enumeration (24 types)
- `CIStatus` - CI status (active, inactive, maintenance, decommissioned)
- `Environment` - Deployment environment
- `Relationship` - CI relationship
- `RelationshipType` - Relationship types (18 types)

### Credentials
- `Credential` - Unified credential
- `CredentialSummary` - Credential list item
- `AuthProtocol` - Authentication protocols (14 protocols)
- `CredentialScope` - Credential scopes
- `CredentialAffinity` - Affinity matching rules
- `CredentialSet` - Credential set with fallback

### Discovery
- `DiscoveryDefinition` - Discovery configuration
- `DiscoveryProvider` - Provider types (14 providers)
- `DiscoveryMethod` - connector vs agent
- `DiscoveryAgent` - Agent registration

### Connectors
- `ConnectorRegistryEntry` - Registry metadata
- `InstalledConnector` - Local installation

### Reconciliation
- `MatchRequest` - CI matching request
- `MergeRequest` - CI merge request
- `ReconciliationConflict` - Conflict details
- `ReconciliationRule` - Reconciliation rules

### Analytics & Monitoring
- `Anomaly` - Anomaly detection result
- `Job` - Background job status
- `AuditEntry` - Audit trail entry

## Code Generation

### Generate TypeScript Client

```bash
npm install -g @openapitools/openapi-generator-cli

openapi-generator-cli generate \
  -i http://localhost:3000/api-docs/openapi.json \
  -g typescript-axios \
  -o ./generated-client
```

### Generate Python Client

```bash
openapi-generator-cli generate \
  -i http://localhost:3000/api-docs/openapi.json \
  -g python \
  -o ./generated-client-python
```

### Generate Java Client

```bash
openapi-generator-cli generate \
  -i http://localhost:3000/api-docs/openapi.json \
  -g java \
  -o ./generated-client-java
```

## Testing with Swagger UI

1. Open Swagger UI: `http://localhost:3000/api-docs`
2. Click "Authorize" button
3. Enter JWT token or API key
4. Explore endpoints and execute test requests

## Best Practices

### Pagination
Most list endpoints support pagination:
```
GET /api/v1/cis?_limit=100&_offset=0
```

### Filtering
Use query parameters for filtering:
```
GET /api/v1/cis?_type=server&_status=active&_environment=production
```

### Metadata Filtering
Search CIs by metadata fields:
```json
POST /api/v1/search/advanced
{
  "_query": "web",
  "_metadata_filters": {
    "os": "Ubuntu",
    "cpu_cores": 8
  }
}
```

### Error Handling
All errors follow standard format:
```json
{
  "error": "Validation Error",
  "message": "Invalid CI type provided",
  "details": [
    {
      "field": "_type",
      "error": "must be one of [server, virtual-machine, ...]"
    }
  ]
}
```

## Validation

The API uses Joi validation schemas with comprehensive rules:

- String length limits
- Enum validation
- UUID format validation
- CIDR network format
- Date/time format
- Nested object validation
- Array item validation

## Security

### Authentication Methods
1. **JWT Tokens**: Short-lived session tokens
2. **API Keys**: Long-lived programmatic access

### Security Headers
- Content Security Policy (CSP)
- CORS enabled
- Helmet security middleware

### Credential Encryption
All credentials stored with AES-256 encryption:
- Credentials encrypted at rest
- Secrets redacted in responses
- Audit logging for credential access

## Monitoring

### Health Check
```bash
curl http://localhost:3000/api/v1/cmdb-health
```

Response:
```json
{
  "status": "healthy",
  "timestamp": "2025-10-18T12:00:00Z",
  "services": {
    "neo4j": "up",
    "postgres": "up",
    "redis": "up"
  }
}
```

### API Documentation Health
```bash
curl http://localhost:3000/api-docs/health
```

Response:
```json
{
  "status": "ok",
  "openapi_version": "3.0.0",
  "api_version": "2.0.0",
  "paths_count": 100,
  "schemas_count": 45
}
```

## Updating the Specification

When adding new endpoints:

1. Edit `openapi.yaml`
2. Add path definition under `paths:`
3. Define request/response schemas under `components/schemas:`
4. Add examples for request bodies
5. Document all parameters and responses
6. Restart API server to reload spec

## Additional Resources

- **Swagger Editor**: https://editor.swagger.io/ (paste YAML for validation)
- **OpenAPI Specification**: https://swagger.io/specification/
- **Swagger UI Documentation**: https://swagger.io/tools/swagger-ui/
- **HappyCMDB Docs**: http://localhost:8080

## Support

For issues or questions about the API:
- GitHub Issues: https://github.com/happycmdb/happycmdb/issues
- Documentation: http://localhost:8080
- Email: support@happycmdb.io
