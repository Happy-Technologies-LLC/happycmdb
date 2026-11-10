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
  "_name": "AWS Production SSH Key",
  "_description": "SSH key for production EC2 instances",
  "_protocol": "ssh_key",
  "_scope": "cloud_provider",
  "_credentials": {
    "username": "ec2-user",
    "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n...",
    "passphrase": "optional-passphrase"
  },
  "_affinity": {
    "_networks": ["10.0.0.0/8"],
    "_hostname_patterns": ["*-prod-*", "*.example.com"],
    "_os_types": ["linux"],
    "_cloud_providers": ["aws"],
    "_environments": ["production"],
    "_priority": 8
  },
  "_tags": ["production", "aws", "ec2"]
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

**Response** (201 Created):
```json
{
  "success": true,
  "data": {
    "_id": "550e8400-e29b-41d4-a716-446655440000",
    "_name": "AWS Production SSH Key",
    "_description": "SSH key for production EC2 instances",
    "_protocol": "ssh_key",
    "_scope": "cloud_provider",
    "_affinity": {
      "_networks": ["10.0.0.0/8"],
      "_hostname_patterns": ["*-prod-*", "*.example.com"],
      "_os_types": ["linux"],
      "_cloud_providers": ["aws"],
      "_environments": ["production"],
      "_priority": 8
    },
    "_tags": ["production", "aws", "ec2"],
    "_createdBy": "admin@example.com",
    "_createdAt": "2025-11-15T10:00:00Z",
    "_updatedAt": "2025-11-15T10:00:00Z",
    "_credentialsSummary": {
      "username": "ec2-user",
      "hasPrivateKey": true,
      "hasPassphrase": true
    }
  }
}
```

**Error Responses**:
- `400 Bad Request` - Invalid credential data
- `409 Conflict` - Credential name already exists
- `401 Unauthorized` - Missing or invalid JWT token
- `403 Forbidden` (`code: c4_principal_admin_required`) - Non-admin sent the `happylab-c4` tag (see [The `happylab-c4` tag](#the-happylab-c4-tag))

---

### List Credentials

Retrieve all credentials (summary only, no sensitive data).

**Endpoint**: `GET /api/v1/credentials`

**Query Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `_protocol` | string | No | Filter by protocol (ssh_key, aws_iam, etc.) |
| `_scope` | string | No | Filter by scope (cloud_provider, ssh, etc.) |
| `_tags` | string | No | Comma-separated tags to filter by |
| `_created_by` | string | No | Filter by creator email |
| `_limit` | number | No | Results per page (default: 100, max: 1000) |
| `_offset` | number | No | Pagination offset (default: 0) |

**Example Request**:
```bash
curl "http://localhost:3000/api/v1/credentials?_protocol=ssh_key&_limit=20" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "credentials": [
      {
        "_id": "550e8400-e29b-41d4-a716-446655440000",
        "_name": "AWS Production SSH Key",
        "_protocol": "ssh_key",
        "_scope": "cloud_provider",
        "_tags": ["production", "aws", "ec2"],
        "_createdBy": "admin@example.com",
        "_createdAt": "2025-11-15T10:00:00Z",
        "_lastUsedAt": "2025-11-15T14:30:00Z",
        "_usageCount": 42
      }
    ],
    "pagination": {
      "total": 1,
      "limit": 20,
      "offset": 0
    }
  }
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

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "_id": "550e8400-e29b-41d4-a716-446655440000",
    "_name": "AWS Production SSH Key",
    "_description": "SSH key for production EC2 instances",
    "_protocol": "ssh_key",
    "_scope": "cloud_provider",
    "_affinity": {
      "_networks": ["10.0.0.0/8"],
      "_hostname_patterns": ["*-prod-*", "*.example.com"],
      "_os_types": ["linux"],
      "_cloud_providers": ["aws"],
      "_environments": ["production"],
      "_priority": 8
    },
    "_tags": ["production", "aws", "ec2"],
    "_createdBy": "admin@example.com",
    "_createdAt": "2025-11-15T10:00:00Z",
    "_updatedAt": "2025-11-15T10:00:00Z",
    "_lastUsedAt": "2025-11-15T14:30:00Z",
    "_usageCount": 42,
    "_credentialsSummary": {
      "username": "ec2-user",
      "hasPrivateKey": true,
      "hasPassphrase": true
    }
  }
}
```

**Error Responses**:
- `404 Not Found` - Credential does not exist
- `401 Unauthorized` - Missing or invalid JWT token

---

### Update Credential

Update credential properties (name, affinity, tags, or credentials).

**Endpoint**: `PUT /api/v1/credentials/:id`

**Request Body**:
```json
{
  "_name": "AWS Production SSH Key (Updated)",
  "_affinity": {
    "_networks": ["10.0.0.0/8", "172.16.0.0/12"],
    "_priority": 9
  },
  "_tags": ["production", "aws", "ec2", "high-priority"]
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "_id": "550e8400-e29b-41d4-a716-446655440000",
    "_name": "AWS Production SSH Key (Updated)",
    "_updatedAt": "2025-11-15T15:00:00Z"
  }
}
```

**Error Responses**:
- `404 Not Found` - Credential does not exist
- `400 Bad Request` - Invalid update data
- `401 Unauthorized` - Missing or invalid JWT token
- `403 Forbidden` (`code: c4_principal_admin_required`) - Non-admin added the `happylab-c4` tag or edited a credential that carries it

---

### Delete Credential

Delete a credential permanently.

**Endpoint**: `DELETE /api/v1/credentials/:id`

**Example Request**:
```bash
curl -X DELETE "http://localhost:3000/api/v1/credentials/550e8400-e29b-41d4-a716-446655440000" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Credential deleted successfully"
}
```

**Error Responses**:
- `404 Not Found` - Credential does not exist
- `409 Conflict` - Credential is in use by discovery definitions
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

**Response** (200 OK): secrets are never returned; `credential.credentials` is always `***REDACTED***`.
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
      "affinity": {},
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
      "OS type match: linux",
      "Environment match: production"
    ]
  }
}
```

**Error Responses**:
- `404 Not Found` - No matching credential found
- `400 Bad Request` - Invalid context data
- `401 Unauthorized` - Missing or invalid JWT token

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

**Response** (200 OK): results are sorted by `score` descending; secrets are never returned, `credential.credentials` is always `***REDACTED***`.
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
        "affinity": {},
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
        "OS type match: linux",
        "Environment match: production"
      ]
    },
    {
      "credential": {
        "id": "660f9511-f3ac-52e5-b827-557766551111",
        "name": "Generic Linux SSH Key",
        "description": null,
        "protocol": "ssh_key",
        "scope": "cloud_provider",
        "credentials": "***REDACTED***",
        "affinity": {},
        "tags": [],
        "created_by": "user-id",
        "created_at": "2025-11-15T14:30:00.000Z",
        "updated_at": "2025-11-15T14:30:00.000Z",
        "last_validated_at": null,
        "validation_status": null
      },
      "score": 20,
      "reasons": ["OS type match: linux"]
    }
  ],
  "count": 2
}
```

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

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "valid": true,
    "message": "Credential successfully validated against target resource",
    "validatedAt": "2025-11-15T16:00:00Z"
  }
}
```

**Failure Response** (200 OK): a credential that fails validation is still a `200`; `valid` is `false` and the message is fixed text.
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
  "_name": "Production Linux Servers",
  "_description": "Fallback credentials for production Linux servers",
  "_credential_ids": [
    "550e8400-e29b-41d4-a716-446655440000",
    "660f9511-f3ac-52e5-b827-557766551111"
  ],
  "_strategy": "sequential",
  "_stop_on_success": true,
  "_tags": ["production", "linux"]
}
```

**Strategies**:
- `sequential` - Try credentials one by one in order
- `parallel` - Try all credentials simultaneously
- `adaptive` - Start sequential, switch to parallel on failure

**Response** (201 Created):
```json
{
  "success": true,
  "data": {
    "_id": "770g0622-g4bd-63f6-c938-668877662222",
    "_name": "Production Linux Servers",
    "_credential_ids": [
      "550e8400-e29b-41d4-a716-446655440000",
      "660f9511-f3ac-52e5-b827-557766551111"
    ],
    "_strategy": "sequential",
    "_stop_on_success": true,
    "_createdAt": "2025-11-15T10:00:00Z"
  }
}
```

---

### List Credential Sets

**Endpoint**: `GET /api/v1/credential-sets`

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "credentialSets": [
      {
        "_id": "770g0622-g4bd-63f6-c938-668877662222",
        "_name": "Production Linux Servers",
        "_credential_count": 2,
        "_strategy": "sequential",
        "_createdAt": "2025-11-15T10:00:00Z"
      }
    ],
    "total": 1
  }
}
```

---

### Get Credential Set

**Endpoint**: `GET /api/v1/credential-sets/:id`

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "_id": "770g0622-g4bd-63f6-c938-668877662222",
    "_name": "Production Linux Servers",
    "_description": "Fallback credentials for production Linux servers",
    "_credentials": [
      {
        "_id": "550e8400-e29b-41d4-a716-446655440000",
        "_name": "AWS Production SSH Key",
        "_protocol": "ssh_key"
      },
      {
        "_id": "660f9511-f3ac-52e5-b827-557766551111",
        "_name": "Generic Linux SSH Key",
        "_protocol": "ssh_key"
      }
    ],
    "_strategy": "sequential",
    "_stop_on_success": true,
    "_tags": ["production", "linux"],
    "_createdAt": "2025-11-15T10:00:00Z"
  }
}
```

---

### Update Credential Set

**Endpoint**: `PUT /api/v1/credential-sets/:id`

**Request Body**:
```json
{
  "_strategy": "adaptive",
  "_credential_ids": [
    "550e8400-e29b-41d4-a716-446655440000",
    "660f9511-f3ac-52e5-b827-557766551111",
    "880h1733-h5ce-74g7-d049-779988773333"
  ]
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "_id": "770g0622-g4bd-63f6-c938-668877662222",
    "_strategy": "adaptive",
    "_credential_count": 3,
    "_updatedAt": "2025-11-15T15:00:00Z"
  }
}
```

---

### Delete Credential Set

**Endpoint**: `DELETE /api/v1/credential-sets/:id`

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Credential set deleted successfully"
}
```

---

### Select Credentials from Set

Select credentials from a set using the configured strategy and context.

**Endpoint**: `POST /api/v1/credential-sets/:id/select`

**Permission**: `write`. It reads the set's member secrets server-side; a `viewer` gets `403` before any lookup.

**Request Body** (field names per the route's `selectCredentialsSchema`; both optional):
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

**Response** (200 OK): secrets are never returned; `credentials` is always `***REDACTED***`.
```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "AWS Production SSH Key",
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

---

## Affinity Matching

The unified credentials system uses intelligent affinity matching to automatically select the best credential for a given resource.

### Matching Rules

Credentials are matched based on the following criteria (in priority order):

1. **Network Match** - IP address falls within `_networks` CIDR ranges
2. **Hostname Pattern Match** - Hostname matches wildcard patterns in `_hostname_patterns`
3. **OS Type Match** - OS type matches `_os_types`
4. **Device Type Match** - Device type matches `_device_types`
5. **Environment Match** - Environment matches `_environments`
6. **Cloud Provider Match** - Cloud provider matches `_cloud_providers`
7. **Protocol Match** - Required protocol matches `_protocol`
8. **Scope Match** - Required scope matches `_scope`
9. **Priority** - Manual priority setting (1-10, higher = better)

### Match Score Calculation

- Each matching criterion adds points to the match score
- Priority multiplier increases the final score
- Scores range from 0 (no match) to 100 (perfect match)
- Credentials below 50% match score are excluded

### Example Affinity Configuration

```json
{
  "_affinity": {
    "_networks": ["10.0.0.0/8", "172.16.0.0/12"],
    "_hostname_patterns": ["*-prod-*", "*.example.com", "prod-*"],
    "_os_types": ["linux", "ubuntu", "centos"],
    "_device_types": ["server", "virtual-machine"],
    "_environments": ["production"],
    "_cloud_providers": ["aws"],
    "_priority": 9
  }
}
```

This configuration matches:
- Any IP in 10.0.0.0/8 or 172.16.0.0/12
- Hostnames containing "-prod-" or ending with ".example.com" or starting with "prod-"
- Linux-based operating systems
- Server or VM device types
- Production environment
- AWS cloud provider
- High priority (9/10)

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
  "_name": "AWS Production Account",
  "_protocol": "aws_iam",
  "_scope": "cloud_provider",
  "_credentials": {
    "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
    "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "region": "us-east-1"
  },
  "_affinity": {
    "_cloud_providers": ["aws"],
    "_environments": ["production"]
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
7. **Monitoring**: Track `_usageCount` and `_lastUsedAt` to identify unused credentials

---

## See Also

- [Discovery API](/api/rest/discovery.md) - Discovery definitions using credentials
- [Authentication API](/api/authentication.md) - User authentication and API keys
- [Components: Credentials](/components/credentials.md) - Unified credential system overview
