---
title: Authentication
description: JWT authentication, role-based access control, and security best practices
---

# Authentication

JWT-based authentication system with role-based access control.

## Quick Integration

### 1. Update App.tsx Router

Add authentication routes and protect existing routes:

```tsx
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Login } from './pages/Login';
import { Settings } from './pages/Settings';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { UserMenu } from './components/auth/UserMenu';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public route */}
        <Route path="/login" element={<Login />} />

        {/* Protected routes */}
        <Route path="/" element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        } />

        <Route path="/settings" element={
          <ProtectedRoute>
            <Settings />
          </ProtectedRoute>
        } />

        {/* Admin-only route example */}
        <Route path="/admin" element={
          <ProtectedRoute requiredRoles={['admin']}>
            <AdminPanel />
          </ProtectedRoute>
        } />
      </Routes>
    </BrowserRouter>
  );
}
```

### 2. Add UserMenu to Header/Navbar

```tsx
import { UserMenu } from './components/auth/UserMenu';

function AppHeader() {
  return (
    <AppBar>
      <Toolbar>
        <Typography variant="h6">HappyCMDB</Typography>
        <Box sx={{ flexGrow: 1 }} />
        <UserMenu />
      </Toolbar>
    </AppBar>
  );
}
```

### 3. Use Authentication in Components

```tsx
import { useAuth } from './hooks/useAuth';

function MyComponent() {
  const { user, isAuthenticated, hasRole, logout } = useAuth();

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  return (
    <div>
      <h1>Welcome, {user?.name}</h1>

      {hasRole(['admin', 'operator']) && (
        <Button onClick={startDiscovery}>Start Discovery</Button>
      )}

      <Button onClick={logout}>Logout</Button>
    </div>
  );
}
```

## Environment Variables

Add to your `.env` file:

```env
VITE_API_URL=http://localhost:3000
```

## Backend API Endpoints

Implement these endpoints in your backend:

### Authentication
```
POST   /api/v1/auth/login           - { email, password } → { token, user }
POST   /api/v1/auth/logout          - Logout user
GET    /api/v1/auth/me              - Get current user
PUT    /api/v1/auth/profile         - { name, avatar }
PUT    /api/v1/auth/password        - { currentPassword, newPassword }
DELETE /api/v1/auth/account         - Delete account
```

### Settings
```
GET    /api/v1/settings             - Get general settings
PUT    /api/v1/settings             - Update general settings
PUT    /api/v1/settings/notifications - Update notification settings
PUT    /api/v1/settings/discovery/{provider} - Update provider credentials
POST   /api/v1/discovery/test-connection - Test provider connection
GET    /api/v1/settings/database   - Get database status (admin only)
```

### API Keys
```
GET    /api/v1/auth/api-keys        - List user's API keys
POST   /api/v1/auth/api-keys        - { name, scopes[] } → { key }
DELETE /api/v1/auth/api-keys/:id    - Revoke API key
```

## JWT Token Structure

Your backend should generate JWT tokens with this payload:

```json
{
  "id": "user-id",
  "email": "user@example.com",
  "roles": ["admin"],
  "iat": 1234567890,
  "exp": 1234571490
}
```

## Tenant Scoping (Organization Claim)

Business services are tenant-scoped. The tenant of a request is the `_organizationId`
(a UUID) of the authenticated user, read from the Neo4j `User` node property
`_organizationId` (or `organizationId`) on **every request**, for both bearer tokens and API keys.
Access tokens also carry it as a claim minted at login and refresh. That claim is
informational only: it is replaced by the user's current organization, so moving or
removing a user's organization takes effect immediately. Request bodies can never set it.
Refresh tokens are accepted only by the refresh endpoint; as a bearer token they get **401**.

- `/api/v1/business-services/**` and `/api/v1/architecture/business-services/:serviceId/analysis`
  return **403** `{"_error":"Forbidden","_message":"Organization claim required"}` when the
  user has no organization or it is not a UUID. The check runs before any data access.
- Reads and writes only see rows whose `dim_business_services.organization_id`
  equals the tenant. Another organization's service returns the same **404**
  as a service that does not exist.
- `organization_id` in a create or update body is rejected with **400**.
- **Accepted limitation (founder-approved, 2026-09-30):** `service_id` is unique across
  all organizations. Creating a service with an id another organization already uses
  returns **409** and leaves that row untouched, but the 409 reveals that the id exists.
  No key change is planned.
- Migration `008_business_service_organization_scope.sql` backfills existing
  services to the internal organization `00000000-0000-0000-0000-000000000000`.
  Users need `organizationId` set (the seeded admin has the internal organization).

```cypher
// Assign an existing user to the internal organization
MATCH (u:User) WHERE u._username = 'svc-happyhive' OR u.username = 'svc-happyhive'
SET u.organizationId = '00000000-0000-0000-0000-000000000000';
```

### Rolling back migration 008

API images built before 008 insert business services without `organization_id`, so
every create fails with `23502` while the column exists. Before deploying such an
image, run the manual rollback (no migration runner executes it):

```bash
psql -v ON_ERROR_STOP=1 -f packages/database/src/postgres/migrations/rollback/008_business_service_organization_scope.down.sql
```

It drops the index and the column, which discards every organization assignment,
and deletes the `cmdb.schema_migrations` row so 008 applies again later. Re-applying
008 puts all services back in the internal organization. Until the old image is
running, the 008-aware API returns 500 on business-service routes.

### Tenant fixture seed (acceptance testing, scratch databases only)

`packages/api-server/src/scripts/seed-tenant-fixture.ts` prepares a **scratch** CMDB
for tenant-scoping acceptance tests (the CO-1 runner). The api-server image build does not
compile it (`tsconfig.json` excludes `src/scripts`), and it has its own build. The runtime
image still ships the `.ts` source and a TypeScript toolchain, so the guards below, not
packaging, are what keep it away from real databases. It:

1. claims the PostgreSQL database (`cmdb.tenant_fixture_marker` table) and the Neo4j
   graph (`(:TenantFixtureMarker)` node) as tenant-fixture scratch stores;
2. runs the PostgreSQL migrations;
3. upserts an active and an inactive business service owned by `--organization-id`,
   and an active one owned by `--other-organization-id`;
4. upserts two enabled `viewer` users: `--service-user` with that organization,
   and `--no-org-user` with none.

It fails closed before connecting to anything:

- `--target scratch` is required.
- `NODE_ENV=production` is refused.
- Connections come only from the dedicated variables `CMDB_SEED_POSTGRES_HOST/PORT/DB/USER/PASSWORD`
  and `CMDB_SEED_NEO4J_URI/USERNAME/PASSWORD`, never from the api-server's `POSTGRES_*` or `NEO4J_*`.
  Both hosts must be loopback (`127.0.0.1`, `::1`, `localhost`). Neo4j must be a direct
  `bolt://host[:port]` URI: routing schemes (`neo4j://`, `neo4j+s://`, `bolt+routing://`)
  are refused, because a routing driver connects to server-advertised addresses the
  loopback check never sees.
- It opens no Redis connection.

Before writing, it refuses a PostgreSQL database that has tables but no marker, and a graph
that has nodes but no marker. It only ever modifies services (`metadata.tenant_fixture`) and
users (`_tenantFixture`) that it created itself, in the same organization. Any other existing
service id or username is refused and left untouched. The internal organization
`00000000-0000-0000-0000-000000000000` is refused for both organizations.

Passwords come only from `CMDB_SEED_SERVICE_USER_PASSWORD` and
`CMDB_SEED_NO_ORG_USER_PASSWORD` (at least 8 characters). They are stored as bcrypt
hashes and never printed. Tokens come from `POST /api/v1/auth/login`. Usernames must
pass the login schema (alphanumeric, 3–30 characters).

```bash
npm run build:tenant-fixture --workspace=packages/api-server
CMDB_SEED_POSTGRES_HOST=127.0.0.1 CMDB_SEED_POSTGRES_PORT=5432 CMDB_SEED_POSTGRES_DB=cmdb_scratch \
CMDB_SEED_POSTGRES_USER=... CMDB_SEED_POSTGRES_PASSWORD=... \
CMDB_SEED_NEO4J_URI=bolt://127.0.0.1:7687 CMDB_SEED_NEO4J_USERNAME=neo4j CMDB_SEED_NEO4J_PASSWORD=... \
CMDB_SEED_SERVICE_USER_PASSWORD=... CMDB_SEED_NO_ORG_USER_PASSWORD=... \
node packages/api-server/dist/tenant-fixture/api-server/src/scripts/seed-tenant-fixture.js --target scratch \
  --organization-id 6f1c2a9e-4b7d-4e2a-9c31-8d5e0f7a2b64 --service-id bs-fulfillment \
  --inactive-service-id bs-retired --other-organization-id 0d9b4e17-3c62-4f88-a5d1-72e9c4b6f305 \
  --other-service-id bs-foreign --service-user hiveservice --no-org-user noorguser
```

Re-running converges to the same state and re-hashes the passwords. stdout carries
exactly one JSON line naming what was seeded, and every log line goes to stderr.
Migration 001 needs the `timescaledb` and `uuid-ossp` extensions, so the target
PostgreSQL must provide them.

## Backend JWT Middleware

### Express Middleware

```typescript
import jwt from 'jsonwebtoken';

export const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

// Role-based middleware
export const requireRole = (roles: string[]) => {
  return (req, res, next) => {
    if (!req.user || !roles.some(role => req.user.roles.includes(role))) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    next();
  };
};
```

## Testing the Authentication Flow

### Manual Testing Steps

1. **Test Login**:
   - Navigate to `/login`
   - Enter credentials
   - Verify redirect to dashboard
   - Verify token in localStorage

2. **Test Protected Routes**:
   - Clear localStorage
   - Try accessing `/settings`
   - Verify redirect to `/login`

3. **Test Role-Based Access**:
   - Login as viewer
   - Try accessing Settings > Database tab
   - Verify tab is hidden

4. **Test Logout**:
   - Click user menu > Logout
   - Verify redirect to `/login`
   - Verify token removed from localStorage

5. **Test Token Expiration**:
   - Generate expired token
   - Make API request
   - Verify auto-logout and redirect

### Unit Test Example

```typescript
import { renderHook, act } from '@testing-library/react';
import { useAuth } from './hooks/useAuth';

describe('useAuth', () => {
  it('should login successfully', async () => {
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.login({
        email: 'admin@example.com',
        password: 'password123',
      });
    });

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.email).toBe('admin@example.com');
  });
});
```

## Common Issues and Solutions

### Issue: Token not being sent with requests
**Solution**: Ensure axios interceptor is configured in auth.service.ts

### Issue: Infinite redirect loop
**Solution**: Check that Login page doesn't require authentication

### Issue: 401 errors after token expires
**Solution**: Token expiration is handled automatically, ensure backend JWT exp is set correctly

### Issue: Role-based access not working
**Solution**: Verify JWT payload includes roles array

## Security Best Practices

1. **Always use HTTPS in production**
2. **Set JWT expiration time (recommended: 1 hour)**
3. **Implement refresh token mechanism** (future enhancement)
4. **Never log tokens in production**
5. **Validate all inputs on backend**
6. **Use secure password hashing (bcrypt)**
7. **Implement rate limiting on login endpoint**
8. **Add CSRF protection if needed**

## Quick Start Checklist

- [ ] Add Login and Settings routes to App.tsx
- [ ] Add UserMenu to app header
- [ ] Wrap protected routes with ProtectedRoute
- [ ] Set VITE_API_URL in .env
- [ ] Implement backend auth endpoints
- [ ] Generate JWT tokens with correct payload
- [ ] Add JWT authentication middleware
- [ ] Test login/logout flow
- [ ] Test role-based access
- [ ] Test token expiration handling

## Example: Complete Authentication Flow

### Frontend Login Component

```tsx
import React from 'react';
import { useForm } from 'react-hook-form';
import { useAuth } from '@hooks/useAuth';
import { Box, TextField, Button, Card } from '@mui/material';

export const Login: React.FC = () => {
  const { login } = useAuth();
  const { register, handleSubmit, formState: { errors } } = useForm();

  const onSubmit = async (data: any) => {
    try {
      await login(data.email, data.password);
    } catch (error) {
      console.error('Login failed:', error);
    }
  };

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <Card sx={{ p: 4, maxWidth: 400, width: '100%' }}>
        <form onSubmit={handleSubmit(onSubmit)}>
          <TextField
            fullWidth
            label="Email"
            margin="normal"
            {...register('email', { required: 'Email is required' })}
            error={!!errors.email}
            helperText={errors.email?.message}
          />
          <TextField
            fullWidth
            label="Password"
            type="password"
            margin="normal"
            {...register('password', { required: 'Password is required' })}
            error={!!errors.password}
            helperText={errors.password?.message}
          />
          <Button type="submit" variant="contained" fullWidth sx={{ mt: 2 }}>
            Login
          </Button>
        </form>
      </Card>
    </Box>
  );
};
```

### Backend Login Endpoint

```typescript
import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user in database
    const user = await db.users.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Verify password
    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Generate JWT
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        roles: user.roles,
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roles: user.roles,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

export default router;
```

## See Also

- [Web UI Guide](/components/web-ui)
- [Configuration Reference](/configuration/environment-variables)
- [Security Best Practices](/guides/security)
