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
  "success": true,
  "data": {
    "_accessToken": "<access-token>",
    "_expiresIn": 900,
    "_user": { "_id": "...", "_username": "admin", "_role": "admin" }
  }
}
```

`_expiresIn` is the access token lifetime in seconds (`JWT_ACCESS_TOKEN_EXPIRES_IN`, default `15m`). The refresh token is not in the body: a login sent with the header `X-CMDB-Auth: 1` sets it as the `__Secure-cmdb_rt` cookie, and `POST /api/v1/auth/refresh` (also with `X-CMDB-Auth: 1`) exchanges that cookie for a new access token. See [Authentication](/api/authentication).

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

The API mounts no global rate limiter (`ApiServer.setupMiddleware`), so there is no per-token, per-user or per-hour request budget for REST routes in general. Limiters exist only on three auth routes registered in `AuthController` (`POST /api/v1/auth/login` and `PUT /api/v1/auth/password` through `RateLimitMiddleware.limit('auth', …)`; `POST /api/v1/auth/refresh` through its own `auth-refresh` bucket on `rateLimit.endpoints.rest`, default 1000 per hour per client address). Analysis requests (`executeBoundedAnalysis`) and GraphQL requests (`admitGraphQLRequest`) have in-process admission gates that answer `429`. The shipped `infrastructure/docker/nginx.conf` adds per-client-address zones: `api_limit` (100r/s, `burst=50`, `location /api/`), `auth_limit` (5r/m, `burst=2`, login and password change only), `auth_session_limit` (2r/s, `burst=20`, the other `/api/v1/auth/` paths) and `graphql_limit` (50r/s, `burst=20`, `location /graphql`). Budgets and zones are listed in [API_DOCUMENTATION.md](https://github.com/Happy-Technologies-LLC/happycmdb/blob/main/packages/api-server/docs/API_DOCUMENTATION.md#rate-limiting) and [Authentication](/api/authentication#rate-limiting).

Only the auth endpoints (`POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `PUT /api/v1/auth/password`) send rate limit headers, on allowed and on their own `429` responses. The headers are absent when `rateLimit.enabled` is `false`, when the request carries the bypass header (`rateLimit.bypassHeader`) with the value of `rateLimit.bypassSecret`, when the endpoint's `max` is `0` (`rateLimit.endpoints.auth.max` for login and password; `rateLimit.endpoints.rest.max` for refresh, which is then not mounted), and when the limiter store errors (refresh fails open and sets none; the fail-closed `503` of login and password carries none). Other routes send none, and their `429` responses (including nginx's) carry none either:
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1625097600000
```

`X-RateLimit-Reset` is the reset time in Unix epoch milliseconds, not seconds. Requests refused before the limiter runs carry no rate-limit headers: `requireAuthHeader` on refresh, and `authenticate()` / `requireJwtSession()` on password.

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
- `429` (rate limited): REST responses carry no error code (auth endpoints send `_error: "Too Many Requests"`; analysis and impact endpoints send `error: "... rate limit exceeded"`); GraphQL sends `extensions.code: "TOO_MANY_REQUESTS"`
- `INTERNAL_ERROR`: Server error

## Next Steps

- [REST API Documentation](./rest)
- [GraphQL API Documentation](./graphql)
- [Authentication Guide](./authentication)
