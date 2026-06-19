# API Overview

HappyCMDB provides both REST and GraphQL APIs for comprehensive access to all CMDB functionality.

## API Endpoints

### REST API
- **Base URL**: `http://localhost:3000/api/v1`
- **Authentication**: JWT Bearer tokens
- **Content Type**: `application/json`

### GraphQL API
- **Endpoint**: `http://localhost:3000/graphql`
- **GraphQL Playground**: `http://localhost:3000/graphql` (in development mode)
- **Authentication**: JWT Bearer tokens in headers

## Authentication

All API requests require authentication using JWT tokens.

### Obtaining a Token

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{
    "username": "admin",
    "password": "your-password"
  }'
```

Response:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 3600
}
```

### Using the Token

Include the token in the Authorization header:

```bash
curl -X GET http://localhost:3000/api/v1/cis \\
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

## API Capabilities

### Configuration Items (CIs)
- List all CIs with filtering and pagination
- Get CI details by ID
- Create, update, delete CIs
- Query CI relationships
- Search CIs by attributes

### Relationships
- Create relationships between CIs
- Query relationship graph
- Find dependencies
- Impact analysis

### Discovery
- Trigger discovery jobs
- Monitor job status
- Configure discovery providers
- View discovery results

### Reports
- Generate analytics reports
- Query data mart
- Export data
- Custom queries

## Rate Limiting

API requests are rate-limited to prevent abuse:

- **Authenticated requests**: 1000 requests per hour
- **Unauthenticated requests**: 100 requests per hour

Rate limit headers are included in responses:
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1625097600
```

## Error Handling

All errors follow a consistent format:

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Configuration item not found",
    "details": {
      "ciId": "abc123"
    }
  }
}
```

Common error codes:
- `UNAUTHORIZED`: Invalid or missing authentication
- `FORBIDDEN`: Insufficient permissions
- `RESOURCE_NOT_FOUND`: Resource doesn't exist
- `VALIDATION_ERROR`: Invalid request data
- `RATE_LIMIT_EXCEEDED`: Too many requests
- `INTERNAL_ERROR`: Server error

## Next Steps

- [REST API Documentation](./rest)
- [GraphQL API Documentation](./graphql)
- [Authentication Guide](./authentication)
