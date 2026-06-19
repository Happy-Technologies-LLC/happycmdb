# Authentication API

Complete API reference for user authentication, token management, and API key operations in HappyCMDB v3.0.

## Overview

HappyCMDB supports two authentication methods:
1. **JWT Tokens** - For interactive user sessions (recommended for web/mobile apps)
2. **API Keys** - For service-to-service communication and automation

## Base URL

```
http://localhost:3000/api/auth
```

---

## JWT Authentication

### Login

Authenticate with username/email and password to obtain JWT tokens.

**Endpoint**: `POST /api/auth/login`

**Request Body**:
```json
{
  "username": "admin",
  "password": "Admin123!"
}
```

**Alternative (email-based)**:
```json
{
  "email": "admin@happycmdb.local",
  "password": "Admin123!"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1c2VyLWFkbWluLTAwMSIsInVzZXJuYW1lIjoiYWRtaW4iLCJyb2xlIjoiYWRtaW4iLCJpYXQiOjE2OTk1NTY0MDAsImV4cCI6MTY5OTY0MjgwMH0.signature",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1c2VyLWFkbWluLTAwMSIsInR5cGUiOiJyZWZyZXNoIiwiaWF0IjoxNjk5NTU2NDAwLCJleHAiOjE3MDIxNDg0MDB9.signature",
    "expiresIn": 86400,
    "tokenType": "Bearer",
    "user": {
      "_id": "user-admin-001",
      "_username": "admin",
      "_email": "admin@happycmdb.local",
      "_role": "admin",
      "_enabled": true,
      "_createdAt": "2025-01-01T00:00:00Z",
      "_lastLoginAt": "2025-11-15T10:00:00Z"
    }
  }
}
```

**Token Lifetimes**:
- **Access Token**: 24 hours (configurable via `JWT_EXPIRATION`)
- **Refresh Token**: 30 days

**Error Responses**:
- `401 Unauthorized` - Invalid credentials
- `403 Forbidden` - Account disabled
- `429 Too Many Requests` - Rate limit exceeded (max 20 login attempts per hour)

---

### Refresh Token

Exchange a refresh token for a new access token without re-entering credentials.

**Endpoint**: `POST /api/auth/refresh`

**Request Body**:
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1c2VyLWFkbWluLTAwMSIsInR5cGUiOiJyZWZyZXNoIiwiaWF0IjoxNjk5NTU2NDAwLCJleHAiOjE3MDIxNDg0MDB9.signature"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.new_access_token.signature",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.new_refresh_token.signature",
    "expiresIn": 86400,
    "tokenType": "Bearer"
  }
}
```

**Error Responses**:
- `401 Unauthorized` - Invalid or expired refresh token
- `403 Forbidden` - User account disabled

**Best Practice**: Implement token refresh 5-10 minutes before expiration to avoid interruptions.

---

### Logout

Logout from current session (client-side token invalidation).

**Endpoint**: `POST /api/auth/logout`

**Headers**:
```
Authorization: Bearer YOUR_ACCESS_TOKEN
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

**Note**: Since JWTs are stateless, logout primarily tells the server to ignore the token. Clients should delete tokens from local storage.

---

### Get Current User

Get information about the currently authenticated user.

**Endpoint**: `GET /api/auth/me`

**Headers**:
```
Authorization: Bearer YOUR_ACCESS_TOKEN
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "_id": "user-admin-001",
    "_username": "admin",
    "_email": "admin@happycmdb.local",
    "_role": "admin",
    "_enabled": true,
    "_createdAt": "2025-01-01T00:00:00Z",
    "_updatedAt": "2025-11-15T09:00:00Z",
    "_lastLoginAt": "2025-11-15T10:00:00Z",
    "permissions": [
      "ci:read",
      "ci:write",
      "ci:delete",
      "discovery:manage",
      "credentials:manage",
      "users:manage",
      "admin:*"
    ]
  }
}
```

**Error Responses**:
- `401 Unauthorized` - Missing or invalid access token

---

## API Key Authentication

### Generate API Key

Create a new API key for programmatic access.

**Endpoint**: `POST /api/auth/api-key`

**Headers**:
```
Authorization: Bearer YOUR_ACCESS_TOKEN
```

**Request Body**:
```json
{
  "name": "Production Automation Script",
  "expiresInDays": 365,
  "role": "operator"
}
```

**Supported Roles**:
- `viewer` - Read-only access
- `operator` - Read + discovery operations
- `admin` - Full access (use sparingly)

**Response** (201 Created):
```json
{
  "success": true,
  "data": {
    "_id": "apikey-123-abc",
    "_name": "Production Automation Script",
    "_key": "cmdb_live_sk1_1a2b3c4d5e6f7g8h9i0j",
    "_role": "operator",
    "_enabled": true,
    "_expiresAt": "2026-11-15T10:00:00Z",
    "_createdAt": "2025-11-15T10:00:00Z",
    "warning": "This API key will only be displayed once. Store it securely."
  }
}
```

**IMPORTANT**: The API key (`_key`) is only shown once. Store it securely immediately.

**API Key Format**: `cmdb_{env}_{prefix}_{random_string}`
- `env`: Environment (`test`, `live`)
- `prefix`: Key type (`sk1` = secret key v1)
- `random_string`: Cryptographically secure random string

**Error Responses**:
- `400 Bad Request` - Invalid expiration or role
- `401 Unauthorized` - Missing or invalid access token

---

### List API Keys

Get all API keys for the current user.

**Endpoint**: `GET /api/auth/api-keys`

**Headers**:
```
Authorization: Bearer YOUR_ACCESS_TOKEN
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "apiKeys": [
      {
        "_id": "apikey-123-abc",
        "_name": "Production Automation Script",
        "_role": "operator",
        "_enabled": true,
        "_createdAt": "2025-11-15T10:00:00Z",
        "_expiresAt": "2026-11-15T10:00:00Z",
        "_lastUsedAt": "2025-11-15T14:30:00Z",
        "keyPreview": "cmdb_live_sk1_1a2b...i0j",
        "daysUntilExpiration": 365
      },
      {
        "_id": "apikey-456-def",
        "_name": "CI Import Script",
        "_role": "operator",
        "_enabled": true,
        "_createdAt": "2025-10-01T10:00:00Z",
        "_expiresAt": null,
        "_lastUsedAt": null,
        "keyPreview": "cmdb_live_sk1_9z8y...a1b",
        "status": "never_used"
      }
    ],
    "total": 2
  }
}
```

**Note**: Full API keys are never returned in list operations for security.

---

### Revoke API Key

Revoke (delete) an API key permanently.

**Endpoint**: `DELETE /api/auth/api-key/:keyId`

**Headers**:
```
Authorization: Bearer YOUR_ACCESS_TOKEN
```

**Example Request**:
```bash
curl -X DELETE "http://localhost:3000/api/auth/api-key/apikey-123-abc" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "API key revoked successfully"
}
```

**Error Responses**:
- `404 Not Found` - API key does not exist
- `403 Forbidden` - Cannot revoke another user's API key (unless admin)

---

## Using Authentication

### JWT Token Authentication

Include the access token in the `Authorization` header for all API requests:

```bash
curl "http://localhost:3000/api/v1/cis" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token_here.signature"
```

**Example (JavaScript)**:
```javascript
const response = await fetch('http://localhost:3000/api/v1/cis', {
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  }
});
```

**Example (Python)**:
```python
import requests

headers = {
    'Authorization': f'Bearer {access_token}',
    'Content-Type': 'application/json'
}

response = requests.get('http://localhost:3000/api/v1/cis', headers=headers)
```

---

### API Key Authentication

Include the API key in the `X-API-Key` header:

```bash
curl "http://localhost:3000/api/v1/cis" \
  -H "X-API-Key: cmdb_live_sk1_1a2b3c4d5e6f7g8h9i0j"
```

**Example (JavaScript)**:
```javascript
const response = await fetch('http://localhost:3000/api/v1/cis', {
  headers: {
    'X-API-Key': 'cmdb_live_sk1_1a2b3c4d5e6f7g8h9i0j',
    'Content-Type': 'application/json'
  }
});
```

**Example (Python)**:
```python
import requests

headers = {
    'X-API-Key': 'cmdb_live_sk1_1a2b3c4d5e6f7g8h9i0j',
    'Content-Type': 'application/json'
}

response = requests.get('http://localhost:3000/api/v1/cis', headers=headers)
```

---

## Role-Based Access Control (RBAC)

HappyCMDB uses role-based access control to manage permissions.

### Roles

| Role | Permissions | Use Case |
|------|-------------|----------|
| **viewer** | Read-only access to CIs, dashboards, and reports | Auditors, business stakeholders |
| **operator** | Read + discovery operations + CI updates | DevOps engineers, operators |
| **admin** | Full access including user management | IT administrators |
| **service** | Service-to-service communication | Internal microservices |

### Permissions

Permissions follow the format: `resource:action`

**Example Permissions**:
- `ci:read` - View CIs
- `ci:write` - Create/update CIs
- `ci:delete` - Delete CIs
- `discovery:manage` - Manage discovery definitions
- `credentials:manage` - Manage credentials
- `users:manage` - Manage users (admin only)
- `admin:*` - Wildcard admin access

### Permission Inheritance

- **viewer**: `ci:read`, `dashboard:read`, `report:read`
- **operator**: All viewer permissions + `ci:write`, `discovery:manage`, `credentials:read`
- **admin**: All permissions (`*:*`)

---

## Rate Limiting

All authentication endpoints are rate-limited to prevent abuse.

### Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| `POST /api/auth/login` | 20 requests | 1 hour per IP |
| `POST /api/auth/refresh` | 20 requests | 1 hour per IP |
| `POST /api/auth/api-key` | 10 requests | 1 hour per user |
| Other endpoints | 1000 requests | 1 hour per user |

### Rate Limit Headers

Rate limit info is returned in response headers:

```
X-RateLimit-Limit: 20
X-RateLimit-Remaining: 15
X-RateLimit-Reset: 1699642800
```

**429 Too Many Requests Response**:
```json
{
  "success": false,
  "error": "Rate Limit Exceeded",
  "message": "Too many login attempts. Please try again in 45 minutes.",
  "retryAfter": 2700
}
```

---

## Security Best Practices

### For JWT Tokens

1. **Store Securely**: Never store tokens in localStorage (XSS vulnerable). Use httpOnly cookies or sessionStorage.
2. **HTTPS Only**: Always use HTTPS in production to prevent token interception.
3. **Token Expiration**: Implement automatic token refresh before expiration.
4. **Logout**: Implement proper logout to clear tokens from client.
5. **Token Rotation**: Refresh tokens are rotated on each refresh operation.

### For API Keys

1. **Secure Storage**: Store API keys in environment variables or secret managers (never in code).
2. **Least Privilege**: Use the minimum required role (prefer `viewer` or `operator` over `admin`).
3. **Key Rotation**: Rotate API keys regularly (every 90-180 days).
4. **Expiration**: Set expiration dates for API keys (avoid permanent keys).
5. **Monitoring**: Monitor API key usage via `_lastUsedAt` field.
6. **Revocation**: Immediately revoke compromised keys.

### Password Requirements

Passwords must meet these criteria:
- Minimum 8 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number
- At least one special character (!@#$%^&*)

**Example Strong Passwords**:
- `MySecure#Pass123`
- `HappyCMDB2025!`
- `Admin@CMDB$2025`

---

## Common Authentication Flows

### Web Application Flow

1. User enters credentials on login page
2. Frontend calls `POST /api/auth/login`
3. Store `accessToken` in memory, `refreshToken` in httpOnly cookie
4. Include `accessToken` in Authorization header for all API calls
5. Before token expiry, call `POST /api/auth/refresh` to get new tokens
6. On logout, call `POST /api/auth/logout` and clear tokens

### API/Script Flow

1. Administrator creates API key via UI or `POST /api/auth/api-key`
2. Store API key in environment variable or secret manager
3. Include API key in `X-API-Key` header for all requests
4. Monitor usage and rotate key periodically

### Mobile App Flow

1. User authenticates with `POST /api/auth/login`
2. Store `accessToken` in secure storage (Keychain/Keystore)
3. Store `refreshToken` in encrypted secure storage
4. Implement background token refresh
5. Clear tokens on logout

---

## Troubleshooting

### "Invalid or expired token"

**Cause**: Access token has expired (24-hour lifetime)

**Solution**:
1. Use refresh token to get new access token
2. If refresh token is also expired, re-authenticate with username/password

**Example**:
```bash
# Get new access token
curl -X POST "http://localhost:3000/api/auth/refresh" \
  -H "Content-Type: application/json" \
  -d '{"refreshToken": "YOUR_REFRESH_TOKEN"}'
```

---

### "Rate limit exceeded"

**Cause**: Too many authentication attempts from same IP

**Solution**: Wait for rate limit window to reset (shown in `retryAfter` seconds)

**Prevention**: Implement exponential backoff in client code

---

### "Account disabled"

**Cause**: User account has been disabled by administrator

**Solution**: Contact system administrator to re-enable account

---

### "API key not found"

**Cause**: API key has been revoked or never existed

**Solution**: Generate a new API key via `POST /api/auth/api-key`

---

## Testing Authentication

### Test Login with cURL

```bash
# Login
curl -X POST "http://localhost:3000/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "Admin123!"
  }'

# Save access token from response
export ACCESS_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# Test authenticated request
curl "http://localhost:3000/api/v1/cis" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

### Test API Key with cURL

```bash
# Generate API key (requires logged-in access token first)
curl -X POST "http://localhost:3000/api/auth/api-key" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test API Key",
    "role": "operator"
  }'

# Save API key from response
export API_KEY="cmdb_live_sk1_1a2b3c4d5e6f7g8h9i0j"

# Test API key request
curl "http://localhost:3000/api/v1/cis" \
  -H "X-API-Key: $API_KEY"
```

---

## Environment Variables

Configure authentication behavior via environment variables:

```bash
# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production-minimum-32-chars
JWT_EXPIRATION=24h

# API Key Configuration
API_KEY=your-api-key-for-service-to-service-authentication

# Rate Limiting
RATE_LIMIT_ENABLED=true
RATE_LIMIT_AUTH_MAX=20
RATE_LIMIT_AUTH_WINDOW_MS=3600000
```

**See**: `.env.example` for complete configuration

---

## Migration from v2.0

### No Breaking Changes

Authentication in v3.0 is fully backward compatible with v2.0:
- Same JWT token format
- Same login endpoints
- Same API key format

### New Features in v3.0

1. **API Key Management**: Create, list, and revoke API keys via API
2. **Enhanced RBAC**: More granular permission model
3. **Token Rotation**: Refresh tokens are automatically rotated
4. **Rate Limiting**: Built-in rate limiting for authentication endpoints

---

## See Also

- [Unified Credentials API](/api/rest/unified.md) - Manage infrastructure credentials
- [Discovery API](/api/rest/discovery.md) - Discovery operations requiring authentication
- [User Management Guide](/user-guides/administrator-guide.md) - Managing users and roles
