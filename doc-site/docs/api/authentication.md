# Authentication API

Complete API reference for user authentication, token management, and API key operations in HappyCMDB v3.0.

## Overview

HappyCMDB supports two authentication methods:
1. **JWT Tokens** - For interactive user sessions (recommended for web/mobile apps)
2. **API Keys** - For service-to-service communication and automation

## Base URL

```
http://localhost:3000/api/v1/auth
```

## Default credentials, credential generation and operator rotation

The seeded development admin (`admin` / `Admin123!`, used in the examples below) only works with
`NODE_ENV=development`. In every other environment:

- **Default passwords are refused.** A login with `Admin123!`, or with any string bcrypt treats as the
  same key (for example `'Admin123!\0'` repeated to 72 bytes), gets the same response as a wrong
  password: `401` with `{"success":false,"error":"Authentication failed"}`. A login password containing
  U+0000 is also refused. The server log records the reason `default_credential_refused` (never the
  password).
- **Marked accounts.** If such a login matches the account's stored hash, the account is marked
  (`defaultPasswordSuspect`). A marked account cannot log in, refresh, use API keys or keep a
  WebSocket open, even with a different password. Login never clears the mark. The seeded admin
  is marked when it is created.
- **Recovery is operator-only.** An operator with direct database access runs
  `packages/api-server/src/scripts/rotate-user-password.ts --user-id <id> --operator <name>` and
  supplies the new password on stdin. The new password must be 12–72 UTF-8 bytes, contain no U+0000,
  and not be a default.
  - The rotation sets the new hash, clears the mark and increments the user's **credential
    generation**.
  - Every earlier access token, refresh token, API key and WebSocket of that user stops working.
    Pre-rotation API keys are also revoked.
  - Each run is audited in `auth_credential_events`: an intent row, then exactly one outcome.
  - When the run cannot see its outcome (Neo4j unreachable), it reports `PENDING`. Resolve that with
    `--reconcile` before rotating anyone else.
  - **Existing databases: prepare once before the first rotation.** The rotation's outcome fence
    needs the Neo4j uniqueness constraint `credential_rotation_decision_event`. New databases get it
    from `infrastructure/scripts/init-neo4j.cypher`; never re-run that script on an existing
    database. Instead run `rotate-user-password.ts --prepare` (same `CMDB_ROTATE_*` connection
    variables; creates the constraint idempotently and confirms it) or apply
    `packages/database/src/neo4j/migrations/002_credential_rotation_decision.cypher` with
    `cypher-shell`. Without it every rotation is refused with `decision_constraint_missing`.

**User lookup index (Neo4j migration 003).** Every authenticated request loads the user by `_id` or
`id`. New databases get the `user_id_lookup` index on `User._id` from `init-neo4j.cypher`. On an
existing database an operator applies
`packages/database/src/neo4j/migrations/003_user_id_lookup_index.cypher` once with `cypher-shell`,
then waits until `SHOW INDEXES YIELD name, state WHERE name = 'user_id_lookup'` reports `ONLINE`.
Never re-run `init-neo4j.cypher` on an existing database (it also writes the seeded admin and sample
data), and note that `rotate-user-password.ts --prepare` does not create this index. Without it
authentication is unchanged but slower, because each lookup scans every user.

**One user per identifier.** An identifier must resolve to exactly one user node across both
spellings (`_id`/`id` for tokens and API keys, `_username`/`username` for login). If two different
nodes match, for example one user's `_id` equal to another user's `id`, every login, token, refresh
token and API key for that identifier gets the standard `401`, and profile writes change nothing.
An operator must make the identifiers unique.

**New passwords** (`PUT /api/v1/auth/password`) are refused with `400 Password not allowed` in every
environment when they are a default or a default-equivalent, contain U+0000, or exceed 72 UTF-8
bytes. A password change or account deletion authorized before an operator rotation is refused with
`401 Credentials changed`.

**A self-service password change ends every session AND every API key of the user** (HAP-1285): it
advances the user's credential generation together with the new hash. Every other access token,
refresh cookie and WebSocket of the user is refused on its next use (WebSockets within the 2-minute
re-check), and so is every API key of the user: keys are valid only at the generation they were
created in, so they stop authenticating (`401`), are listed by `GET /api/v1/auth/api-keys` with
`_enabled: false`, and must be recreated. The changing device stays signed in: the `200` response
(message "Password changed. All other sessions and all your API keys have been revoked; this device
stays signed in.") carries `data` (`_accessToken`, `_expiresIn`, `_user`, as login) and sets a new
`__Secure-cmdb_rt` cookie, whose 7-day cap starts at the change.

**Password changes are rate-limited and audited** (HAP-1368). `PUT /api/v1/auth/password` shares the
login limit per client address (`RATE_LIMIT_AUTH_MAX` per `RATE_LIMIT_AUTH_WINDOW_MS`, the same
bucket as login) and adds a per-user limit across all client addresses at login's per-account budget
(`RATE_LIMIT_AUTH_ACCOUNT_MAX` per `RATE_LIMIT_AUTH_ACCOUNT_WINDOW_MS`, default 5 per 15 minutes).
Past either limit it answers `429`; while the rate-limit store is unreachable it answers `503` and
changes nothing. Each attempt that reaches a decision appends one row to the
hash-chained `audit_log` (entity `USER`, the user id as entity and actor, client address (null when
unavailable), organization, a fixed `metadata.outcome`; never a password, hash or token): `success`,
`wrong_password` (400), `policy_failure` (400, the new password is not allowed), `rotation_lost` (401,
credentials changed since the session was issued), `user_not_found` (404) and `rate_limited` (429).
Response bodies are the same with or without the audit row. `policy_failure`, `user_not_found` and
`rotation_lost` rows are recorded before (or without) proof of the current password: the request has a
valid session but has not shown the current password, so a row records a refused attempt by that
session, not a verified one (`rotation_lost` is also written when the guarded write loses a race after
the proof; the row does not say which). The `503` for an audit chain that is not
ready (`AUDIT_CHAIN_KEY` unset) is refused before the current password is checked and is not audited:
the chain cannot be written then. Request-validation `400`s (malformed body) are not audited. A user
without an organization claim is not audited (an error is logged). `rate_limited` is the first `429`
per user and refusing bucket (the client bucket, the user bucket) per window, and its row's
`metadata.bucket` names the refusing bucket (`client`, `user`; the login-only `account` and
`account-global` buckets do not apply here). Each audit write takes the
global audit-chain lock, so retries past the limit append no further rows until the window passes
(a Redis `SET rate-limit:auth-user-refused:<userId>[:client] NX PX <window>` decides; if Redis fails the
`429` is unchanged and no row is written). The claim is taken before the write so concurrent refusals
write one row; when the write fails or is skipped (no organization claim) the claim is released
(`DEL`), so the next `429` in the window retries and the window is not left without its row. Requires PostgreSQL
migration `049_audit_entity_user.sql`.

**Platform administrators** are a dedicated flag, set only by the operator command
`scripts/identity-window.ts grant-platform-admin`. Role `admin` and organization grant nothing. A
seeded account (the init or seed-data admin, or any account with seed provenance or a default
password) never qualifies. API keys never act as platform administrators. The flag is checked on
every request against the stored user record; tokens and verified request identities carry no
platform-admin claim, so revoking the flag takes effect on the next request. No route accepts platform
administrators yet: global TBM and connector controls still refuse every caller.

---

## JWT Authentication

### Login

Authenticate with username and password to obtain JWT tokens. `username` is alphanumeric, 3-30 characters; `password` is at least 8 characters. Email is not accepted as a login identifier.

**Endpoint**: `POST /api/v1/auth/login`

**Request Body**:
```json
{
  "username": "admin",
  "password": "Admin123!"
}
```

A body with `email` instead of `username` fails validation (`username` is required); `email` alongside `username` is ignored (unknown fields are stripped).

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "_accessToken": "<access-token>",
    "_expiresIn": 900,
    "_user": {
      "_id": "user-admin-001",
      "_username": "admin",
      "_role": "admin"
    }
  }
}
```
The refresh token is not in the body: with the header `X-CMDB-Auth: 1` (exactly; the web UI sends it) it is set as `__Secure-cmdb_rt=<refresh JWT>; Max-Age=<refresh TTL>; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict` (HAP-1211 H1, renamed from `cmdb_rt` in H2). `Max-Age` is the refresh TTL, but never more than what is left of the 7-day absolute cap from the login (HAP-1382), so the cookie never outlives the session refresh still accepts. A login without that header (scripts, the CLI, or a cross-site form, which cannot add a custom header) gets the same `200` body and **no cookie** (HAP-1211 H2, login CSRF): it cannot refresh and signs in again when the access token expires. Browsers do not store a `Secure` cookie from plain `http://` other than `localhost`, and never store a `__Secure-` cookie from plain `http://`.

**Caching** (HAP-1382): every `/api/v1/auth/*` response, refusals included, carries `Cache-Control: no-store` and `Pragma: no-cache`, so no browser or proxy cache keeps an access token, an API key, the refresh cookie or account data. A failure of the user or API-key store answers the endpoint's fixed body (`"message": "Internal error"`) and logs only the error class, its code and the user id, never the driver's message.

**Web UI session (HAP-1211 H2)**: the web UI holds the access token only in memory, never in `localStorage` or `sessionStorage`. A reload or a new tab restores the session with `POST /api/v1/auth/refresh`, the UI renews the access token about a minute before it expires, and a logout in one tab signs out the other tabs of the same browser. **Cut-over**: the first load after the upgrade signs every web UI user out once, because a session saved by an older release (a `localStorage` token, or a `cmdb_rt` cookie) is not carried over; the server does not clear an old `cmdb_rt` cookie, which expires on its own and is never read. On plain `http://` (local development without TLS) the browser refuses the `__Secure-` cookie, so a reload there always asks you to sign in again.

**Token Lifetimes**:
- **Access Token**: 15 minutes by default (`JWT_ACCESS_TOKEN_EXPIRES_IN`)
- **Refresh Token**: 7 days by default (`JWT_REFRESH_TOKEN_EXPIRES_IN`); each refresh issues a new one with a full TTL (sliding). **Absolute cap** (HAP-1285): refresh is refused once more than 7 days have passed since the login (or self-service password change) the session began with, however often it was renewed; then sign in again. The cap is fixed, not configurable. The last access token issued keeps its own TTL, so a session lasts at most 7 days plus the access TTL.

**Error Responses**:
- `401 Unauthorized` - Invalid credentials
- `403 Forbidden` - Account disabled
- `429 Too Many Requests` - Rate limit exceeded (per client address 20 login attempts per hour by default; per-account limits also apply, see [Rate Limiting](#rate-limiting))

---

### Refresh Token

**Endpoint**: `POST /api/v1/auth/refresh` with the header `X-CMDB-Auth: 1` (exactly). Exchanges the `__Secure-cmdb_rt` cookie (the only token source; no body is read) for a new access token and a new `__Secure-cmdb_rt` cookie (same attributes, full TTL: sliding, within the 7-day absolute cap from login; its `Max-Age` is clamped to the time left of that cap, HAP-1382).

**Error Responses** (fixed bodies): `403 Forbidden` without `X-CMDB-Auth: 1`, checked first. `401 Unauthorized` when the cookie is missing, duplicated or malformed, or the token is invalid, expired, not a refresh token, of an older credential generation (HP1-S6, including after a self-service password change), more than 7 days past its login (HAP-1285; a refresh token issued before HAP-1285 carries no login time and is refused too), or its user is disabled.

---

### Logout

**Endpoint**: `POST /api/v1/auth/logout` → `{ "success": true, "message": "Logged out successfully" }`. Expires the `__Secure-cmdb_rt` cookie (`Max-Age=0`, past `Expires`, same attributes); no header and no access token are required.

**Stateless** (founder decision, HAP-1211 H1b): logout only clears this browser's cookie. A refresh cookie captured before logout can still be renewed until 7 days after the login it came from (HAP-1285 absolute cap), or earlier when the user changes their password, an operator rotation changes the user's credential generation, or the account is disabled or deleted. The access token stays valid until it expires (15 minutes by default).

**Accepted residual** (HAP-1297): logout needs no `X-CMDB-Auth` header, no access token and no cookie to be answered, so a cross-site `POST` can sign a browser out (a forced logout; the user signs in again). `SameSite=Strict` does not limit this: it only keeps the browser from sending the cookie on a cross-site request, and logout does not need the cookie in the request to answer with the expiring `Set-Cookie`. The `X-CMDB-Auth: 1` header rule protects refresh and the login cookie, not logout. What bounds the impact is that logout only expires the cookie: it reads, issues and revokes nothing, and the in-memory access token keeps working until it expires.

---

### Get Current User

Get information about the currently authenticated user.

**Endpoint**: `GET /api/v1/auth/me`

**Headers**:
```
Authorization: Bearer YOUR_ACCESS_TOKEN
```

**Response** (200 OK), the caller's own record only (also the `data` of `PUT /api/v1/auth/profile`):
```json
{
  "success": true,
  "data": {
    "userId": "user-1",
    "username": "alice",
    "email": "alice@example.com",
    "name": "Alice",
    "avatar": "data:image/png;base64,...",
    "role": "operator",
    "createdAt": "2025-01-01T00:00:00Z",
    "lastLoginAt": "2025-11-15T10:00:00Z",
    "platformAdmin": false,
    "organizationId": "org-acme"
  }
}
```

`platformAdmin` is the effective platform-administrator status the server enforces (the stored flag, never true for a seeded account). `organizationId` is the caller's organization, `null` for a user without one. Both come from the stored user, not from the request or token claims; the UI displays them and never decides access from them.

**Error Responses**:
- `401 Unauthorized` - Missing or invalid access token

---

## API Key Authentication

### Generate API Key

Create a new API key for programmatic access.

**Endpoint**: `POST /api/v1/auth/api-key`

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

**Endpoint**: `GET /api/v1/auth/api-keys`

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

**Endpoint**: `DELETE /api/v1/auth/api-key/:keyId`

**Headers**:
```
Authorization: Bearer YOUR_ACCESS_TOKEN
```

**Example Request**:
```bash
curl -X DELETE "http://localhost:3000/api/v1/auth/api-key/apikey-123-abc" \
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
  -H "Authorization: Bearer <access-token>"
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

Only three authentication endpoints carry a rate limiter: `POST /api/v1/auth/login`, `PUT /api/v1/auth/password` and `POST /api/v1/auth/refresh`. The other `/api/v1/auth/*` routes (`logout`, `me`, `profile`, `account`, and the API key routes `POST /api/v1/auth/api-key`, `GET /api/v1/auth/api-keys`, `DELETE /api/v1/auth/api-key/:keyId`) have no dedicated limiter. The API key routes are session-only: they need a JWT session (`authenticate` then `requireJwtSession`), and an API key cannot call them. No generic REST limiter is mounted on the other `/api/v1/*` routes.

### Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| `POST /api/v1/auth/login` | 20 per IP (`RATE_LIMIT_AUTH_*`), 5 per account + IP (`RATE_LIMIT_AUTH_ACCOUNT_*`) and 20 per account across all IPs (`RATE_LIMIT_AUTH_ACCOUNT_GLOBAL_*`); the account is the trimmed, lowercased username | 1 hour per IP; 15 minutes per account + IP and per account |
| `PUT /api/v1/auth/password` | Login's 20 per IP (shared bucket) and 5 per user across all IPs (`RATE_LIMIT_AUTH_ACCOUNT_*`) | 1 hour per IP; 15 minutes per user |
| `POST /api/v1/auth/refresh` | The REST budget (`RATE_LIMIT_REST_MAX`, default 1000; `0` = unlimited) under its own key, so renewals never use up the login limit (HAP-1211 H2) | `RATE_LIMIT_REST_WINDOW_MS` (default 1 hour) per IP |
| Other `/api/v1/auth/*` endpoints, including `POST /api/v1/auth/api-key` | No dedicated limiter | n/a |

The client address ("IP") is `req.ip`: `X-Forwarded-For` counts only for the hops `TRUST_PROXY` trusts (default:
none). See [Proxy Trust & Login Rate Limiting](/configuration/environment-variables#proxy-trust-login-rate-limiting).
Every per-IP bucket key (login, password change, refresh) uses the address normalized (HAP-1715): an IPv4 address
is itself, an IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) is its IPv4 address, and any other IPv6 address is its
`/64`, so a client rotating through its own `/64` shares one bucket. A value that is not an IP address shares one
`unknown` bucket.
While the rate-limit store is unreachable, login and password change answer a fixed `503` with
`Cache-Control: no-store` and never check the password (fail closed); refresh is let through (fail open).

### Rate Limit Headers

The three limited endpoints return rate limit info in response headers, on allowed and on `429` responses. They are absent when `rateLimit.enabled` is `false`, when the request carries the bypass header (`rateLimit.bypassHeader`) with the value of `rateLimit.bypassSecret`, when the endpoint's `max` is `0` (`rateLimit.endpoints.auth.max` for login and password; `rateLimit.endpoints.rest.max` for refresh, which is then not mounted), and when the limiter store errors (refresh fails open and sets none; the fail-closed `503` of login and password carries none). Nginx's own `429` carries none:

```
X-RateLimit-Limit: 20
X-RateLimit-Remaining: 15
X-RateLimit-Reset: 1699642800000
```

`X-RateLimit-Reset` is a Unix timestamp in **milliseconds** (the request time plus the window), not seconds. Divide by 1000 for epoch seconds, or pass it to `new Date(...)`. The `429` body's `_resetAt` is the same instant as an ISO 8601 string, and `_retryAfter` is in seconds. Requests refused before the limiter runs carry no rate-limit headers: `requireAuthHeader` on refresh (a fixed `403` without `X-CMDB-Auth: 1`), and `authenticate()` / `requireJwtSession()` on password (`401`, or `403` for an API key).

**429 Too Many Requests Response**:
```json
{
  "_error": "Too Many Requests",
  "_message": "Rate limit exceeded. Try again in 3600 seconds",
  "_retryAfter": 3600,
  "_limit": 20,
  "_resetAt": "2023-11-10T19:00:00.000Z"
}
```

On login and password change, the headers and every `429` report only the per-IP bucket (HAP-1795). The
per-account, per-account + IP and per-user buckets still refuse with `429`, but their counts, limits and
windows never appear: a refusal by one of them carries the same headers (`X-RateLimit-Remaining: 0`) and body
as a per-IP refusal, and `_retryAfter` is the per-IP window.

---

## Security Best Practices

### For JWT Tokens

1. **Store Securely**: Never store tokens in localStorage or sessionStorage (any script on the page can read them). Keep the access token in memory and the refresh token in the httpOnly cookie.
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
2. Frontend calls `POST /api/v1/auth/login` with `X-CMDB-Auth: 1` (without it no refresh cookie is set)
3. Keep `accessToken` in memory; the server sets the refresh token as the `__Secure-cmdb_rt` HttpOnly cookie
4. Include `accessToken` in Authorization header for all API calls
5. Before token expiry, call `POST /api/v1/auth/refresh` with `X-CMDB-Auth: 1` (the browser sends the cookie)
6. On logout, call `POST /api/v1/auth/logout` (expires the cookie) and discard the access token

### API/Script Flow

1. Administrator creates API key via UI or `POST /api/v1/auth/api-key`
2. Store API key in environment variable or secret manager
3. Include API key in `X-API-Key` header for all requests
4. Monitor usage and rotate key periodically

### Mobile App Flow

1. User authenticates with `POST /api/v1/auth/login`
2. Store `accessToken` in secure storage (Keychain/Keystore)
3. Log in with `X-CMDB-Auth: 1` and keep the `__Secure-cmdb_rt` cookie from the response in encrypted secure storage
4. Implement background token refresh
5. Clear tokens on logout

---

## Troubleshooting

### "Invalid or expired token"

**Cause**: Access token has expired (15-minute lifetime by default)

**Solution**:
1. Use refresh token to get new access token
2. If refresh token is also expired, re-authenticate with username/password

**Example**:
```bash
# Get new access token (cookie jar written by a login call sent with -H "X-CMDB-Auth: 1" -c cookies.txt)
curl -X POST "http://localhost:3000/api/v1/auth/refresh" -H "X-CMDB-Auth: 1" -b cookies.txt -c cookies.txt
```

---

### "Rate limit exceeded"

**Cause**: Too many authentication attempts from same IP

**Solution**: Wait for rate limit window to reset (shown in `_retryAfter` seconds)

**Prevention**: Implement exponential backoff in client code

---

### "Account disabled"

**Cause**: User account has been disabled by administrator

**Solution**: Contact system administrator to re-enable account

---

### "API key not found"

**Cause**: API key has been revoked or never existed

**Solution**: Generate a new API key via `POST /api/v1/auth/api-key`

---

## Testing Authentication

### Test Login with cURL

```bash
# Login
curl -X POST "http://localhost:3000/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "Admin123!"
  }'

# Save access token from response
export ACCESS_TOKEN="<access-token>"

# Test authenticated request
curl "http://localhost:3000/api/v1/cis" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

### Test API Key with cURL

```bash
# Generate API key (requires logged-in access token first)
curl -X POST "http://localhost:3000/api/v1/auth/api-key" \
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
JWT_ACCESS_TOKEN_EXPIRES_IN=15m   # default; refresh token: JWT_REFRESH_TOKEN_EXPIRES_IN (default 7d)

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
