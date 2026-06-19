---
title: Unified Credential Management
description: Protocol-based credential storage with affinity matching and credential sets
---

# Unified Credential Management

HappyCMDB's unified credential system provides protocol-based authentication with affinity matching, credential sets, and intelligent credential selection. Introduced in v2.0, it replaces provider-specific credentials with standardized authentication protocols.

## Overview

The unified credential system eliminates credential proliferation by using standard authentication protocols instead of provider-specific credential types. It enables advanced features like credential affinity (matching credentials to targets), credential sets (try multiple credentials systematically), and unified management across all integrations.

### Key Features

- **Protocol-Based** - 14 standard authentication protocols (aws_iam, ssh_key, oauth2, etc.)
- **Credential Affinity** - Match credentials by network, hostname, OS, device type
- **Credential Sets** - Group credentials with sequential, parallel, or adaptive strategies
- **Unified Management** - One system for discovery, connectors, and ETL
- **Encryption at Rest** - AES-256-GCM encryption for all credential data
- **Validation Tracking** - Monitor credential health and expiration
- **Usage Analytics** - Track where and how often credentials are used
- **Audit Trail** - Complete history of credential access and operations

## Core Concepts

### Authentication Protocols

Instead of provider-specific types (aws, azure, gcp), use **standard authentication protocols**:

**Cloud Providers:**
- `aws_iam` - AWS IAM credentials (access key + secret)
- `azure_sp` - Azure Service Principal
- `gcp_sa` - GCP Service Account

**SSH Access:**
- `ssh_key` - SSH with private key
- `ssh_password` - SSH with password

**API Authentication:**
- `oauth2` - OAuth 2.0 flow
- `api_key` - API key authentication
- `bearer` - Bearer token
- `basic` - HTTP Basic auth

**Network Protocols:**
- `snmp_v2c` - SNMP v2c community string
- `snmp_v3` - SNMP v3 with auth/priv

**Additional:**
- `certificate` - X.509 certificate auth
- `kerberos` - Kerberos authentication
- `winrm` - Windows Remote Management

### Credential Affinity

Credentials can specify **where they work best** using affinity rules:

```typescript
affinity: {
  networks: ['10.0.0.0/8', '192.168.1.0/24'],
  hostname_patterns: ['*.prod.example.com', 'db-*'],
  os_types: ['linux', 'windows'],
  device_types: ['router', 'switch', 'firewall'],
  environments: ['production'],
  cloud_providers: ['aws'],
  priority: 9  // 1-10, higher = try first
}
```

**Use Cases:**
- **Network scanning** - Try specific credentials for specific subnets
- **Multi-datacenter** - Different credentials per location
- **Environment isolation** - Separate prod/dev credentials
- **Device-specific** - Router credentials vs server credentials

### Credential Sets

Group multiple credentials to try in order with different strategies:

**Strategies:**
- **Sequential** - Try one at a time until success
- **Parallel** - Try all simultaneously (fastest)
- **Adaptive** - Learn from past successes and prioritize

**Example: NMAP with Credential Library**
```typescript
const credentialSet = {
  name: "NMAP Production Scan",
  credential_ids: [
    linuxAdminCred.id,    // Try admin first (priority 10)
    legacyRootCred.id,    // Then root (priority 7)
    serviceAccountCred.id // Finally service account (priority 5)
  ],
  strategy: "adaptive",      // Learn which works where
  stop_on_success: false     // Try all to build mapping
}
```

## Architecture

### Database Schema

```sql
-- Unified credentials table
CREATE TABLE credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,

  -- Protocol-based (NOT provider-specific!)
  protocol VARCHAR(50) NOT NULL, -- e.g., 'ssh_key', 'aws_iam', 'oauth2'
  scope VARCHAR(50) NOT NULL,    -- 'ssh', 'cloud_provider', 'api', 'network'

  -- Encrypted credential data
  encrypted_credentials JSONB NOT NULL,

  -- Affinity matching
  affinity JSONB DEFAULT '{
    "networks": [],
    "hostname_patterns": [],
    "os_types": [],
    "device_types": [],
    "environments": [],
    "cloud_providers": [],
    "priority": 5
  }'::jsonb,

  -- Metadata
  tags TEXT[] DEFAULT '{}',
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  -- Validation tracking
  last_validated_at TIMESTAMP,
  validation_status VARCHAR(50), -- 'valid', 'invalid', 'expired', 'unknown'
  validation_error TEXT,

  -- Usage tracking
  usage_count INTEGER DEFAULT 0,
  last_used_at TIMESTAMP
);

CREATE INDEX idx_credentials_protocol ON credentials(protocol);
CREATE INDEX idx_credentials_scope ON credentials(scope);
CREATE INDEX idx_credentials_tags ON credentials USING gin(tags);

-- Credential sets
CREATE TABLE credential_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,

  -- Ordered array of credential IDs
  credential_ids UUID[] NOT NULL,

  -- Strategy
  strategy VARCHAR(50) NOT NULL DEFAULT 'sequential',
    CHECK (strategy IN ('sequential', 'parallel', 'adaptive')),
  stop_on_success BOOLEAN DEFAULT true,

  -- Metadata
  tags TEXT[] DEFAULT '{}',
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  -- Usage tracking
  usage_count INTEGER DEFAULT 0,
  last_used_at TIMESTAMP
);

-- Link credentials to discovery definitions
ALTER TABLE discovery_definitions
  ADD COLUMN credential_id UUID REFERENCES credentials(id),
  ADD COLUMN credential_set_id UUID REFERENCES credential_sets(id),
  ADD CONSTRAINT xor_credential_or_set
    CHECK ((credential_id IS NULL) != (credential_set_id IS NULL)
           OR (credential_id IS NULL AND credential_set_id IS NULL));

-- Link credentials to connector configurations
ALTER TABLE connector_configurations
  ADD COLUMN credential_id UUID REFERENCES credentials(id);
```

### Credential Service

The `UnifiedCredentialService` provides:

```typescript
class UnifiedCredentialService {
  // CRUD operations
  async create(data: UnifiedCredentialInput): Promise<UnifiedCredential>;
  async getById(id: string): Promise<UnifiedCredential>;
  async list(filters: CredentialFilters): Promise<UnifiedCredential[]>;
  async update(id: string, data: UnifiedCredentialUpdate): Promise<UnifiedCredential>;
  async delete(id: string): Promise<boolean>;

  // Affinity matching
  async findBestMatch(context: CredentialMatchContext): Promise<string | null>;
  async rankCredentials(credentials: UnifiedCredential[], context: CredentialMatchContext): Promise<CredentialMatchResult[]>;

  // Validation
  async validate(id: string): Promise<CredentialValidationResult>;
  async testConnection(id: string): Promise<TestResult>;
}
```

### Protocol Adapters

The `CredentialProtocolAdapter` converts unified credentials to provider-specific formats:

```typescript
class CredentialProtocolAdapter {
  // AWS
  static toAWSCredentials(credential: UnifiedCredential): AWSCredentials;

  // Azure
  static toAzureCredentials(credential: UnifiedCredential): AzureCredentials;

  // GCP
  static toGCPCredentials(credential: UnifiedCredential): GCPCredentials;

  // SSH
  static toSSHConfig(credential: UnifiedCredential): SSHConfig;

  // API
  static toAPIHeaders(credential: UnifiedCredential): Record<string, string>;

  // SNMP
  static toSNMPConfig(credential: UnifiedCredential): SNMPConfig;
}
```

## Supported Authentication Protocols

### AWS Credentials

**Type**: `aws`

**Required Fields**:
- `accessKeyId` - AWS Access Key ID
- `secretAccessKey` - AWS Secret Access Key
- `region` - Default AWS region (optional)

**Example**:
```json
{
  "type": "aws",
  "credentials": {
    "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
    "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "region": "us-east-1"
  }
}
```

**Required IAM Permissions**:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:Describe*",
        "rds:Describe*",
        "s3:ListAllMyBuckets",
        "s3:GetBucketLocation",
        "elasticloadbalancing:Describe*",
        "ecs:Describe*",
        "lambda:List*"
      ],
      "Resource": "*"
    }
  ]
}
```

### Azure Credentials

**Type**: `azure`

**Required Fields**:
- `tenantId` - Azure Active Directory Tenant ID
- `clientId` - Application (client) ID
- `clientSecret` - Client secret value
- `subscriptionId` - Azure subscription ID

**Example**:
```json
{
  "type": "azure",
  "credentials": {
    "tenantId": "tenant-id-here",
    "clientId": "client-id-here",
    "clientSecret": "client-secret-here",
    "subscriptionId": "subscription-id-here"
  }
}
```

**Required Permissions**:
- Reader role on the subscription
- Or custom role with:
  - `Microsoft.Compute/virtualMachines/read`
  - `Microsoft.Network/networkInterfaces/read`
  - `Microsoft.Storage/storageAccounts/read`
  - `Microsoft.Sql/servers/read`

### GCP Credentials

**Type**: `gcp`

**Required Fields**:
- `serviceAccountKey` - JSON service account key file content
- `projectId` - GCP project ID

**Example**:
```json
{
  "type": "gcp",
  "credentials": {
    "serviceAccountKey": "{...service account JSON...}",
    "projectId": "my-project-id"
  }
}
```

**Required Permissions**:
- Compute Viewer role
- Or custom role with:
  - `compute.instances.list`
  - `compute.zones.list`
  - `storage.buckets.list`
  - `sql.instances.list`

### SSH Credentials

**Type**: `ssh`

**Required Fields**:
- `username` - SSH username
- `password` OR `privateKey` - Authentication method

**Example (Password)**:
```json
{
  "type": "ssh",
  "credentials": {
    "username": "admin",
    "password": "secure-password"
  }
}
```

**Example (Private Key)**:
```json
{
  "type": "ssh",
  "credentials": {
    "username": "admin",
    "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----",
    "passphrase": "optional-key-passphrase"
  }
}
```

### API Key Credentials

**Type**: `api_key`

**Required Fields**:
- `apiKey` - API key or token
- `apiUrl` - Base URL for API (optional)

**Example**:
```json
{
  "type": "api_key",
  "credentials": {
    "apiKey": "your-api-key-here",
    "apiUrl": "https://api.example.com"
  }
}
```

### SNMP Credentials

**Type**: `snmp`

**Required Fields** (v2c):
- `version` - SNMP version ('2c' or '3')
- `community` - Community string (for v2c)

**Required Fields** (v3):
- `version` - SNMP version ('3')
- `username` - SNMPv3 username
- `authProtocol` - Authentication protocol ('MD5' or 'SHA')
- `authPassword` - Authentication password
- `privProtocol` - Privacy protocol ('DES' or 'AES')
- `privPassword` - Privacy password

**Example (v2c)**:
```json
{
  "type": "snmp",
  "credentials": {
    "version": "2c",
    "community": "public"
  }
}
```

**Example (v3)**:
```json
{
  "type": "snmp",
  "credentials": {
    "version": "3",
    "username": "snmpuser",
    "authProtocol": "SHA",
    "authPassword": "auth-password",
    "privProtocol": "AES",
    "privPassword": "priv-password"
  }
}
```

## API Reference

### Create Credential

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

**Response**:
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

::: warning Credential Response
The API never returns the actual credential values in responses. Only metadata is returned.
:::

### List Credentials

**Endpoint**: `GET /api/v1/credentials`

**Query Parameters**:
- `type` - Filter by credential type (optional)
- `limit` - Number of results (default: 50)
- `offset` - Pagination offset (default: 0)

**Example Request**:
```bash
curl http://localhost:3000/api/v1/credentials?type=aws&limit=20 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response**:
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
        "lastUsedAt": "2025-10-05T14:30:00Z"
      },
      {
        "id": "cred-456-def",
        "name": "AWS Development Account",
        "type": "aws",
        "createdBy": "admin@example.com",
        "createdAt": "2025-10-04T09:00:00Z",
        "lastUsedAt": "2025-10-05T12:00:00Z"
      }
    ],
    "total": 2,
    "limit": 20,
    "offset": 0
  }
}
```

### Get Credential

**Endpoint**: `GET /api/v1/credentials/:id`

**Example Request**:
```bash
curl http://localhost:3000/api/v1/credentials/cred-123-abc \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response**:
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

### Update Credential

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

**Response**:
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

### Delete Credential

**Endpoint**: `DELETE /api/v1/credentials/:id`

**Example Request**:
```bash
curl -X DELETE http://localhost:3000/api/v1/credentials/cred-123-abc \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response**:
```json
{
  "success": true,
  "data": {
    "deleted": true,
    "id": "cred-123-abc"
  }
}
```

::: danger Deletion Protection
Deletion fails if the credential is referenced by any discovery definitions. Remove from all definitions first.
:::

### Test Credential

**Endpoint**: `POST /api/v1/credentials/:id/test`

Tests if the credential successfully authenticates with the provider.

**Response**:
```json
{
  "success": true,
  "data": {
    "valid": true,
    "message": "Successfully authenticated with AWS",
    "testedAt": "2025-10-05T15:30:00Z"
  }
}
```

## Security Considerations

### Encryption

1. **Algorithm**: AES-256-GCM (Galois/Counter Mode)
2. **Key Management**:
   - Encryption key stored in environment variable `ENCRYPTION_KEY`
   - Key should be 32 bytes (256 bits)
   - Never commit encryption key to version control
3. **Initialization Vector**: Random IV generated per encryption operation
4. **Authentication**: GCM provides authenticated encryption

### Encryption Key Setup

**Generate a secure encryption key**:

```bash
# Linux/macOS
openssl rand -hex 32

# Output example: 8f7a3b2c9d1e6f0a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1
```

**Set in environment**:

```bash
export ENCRYPTION_KEY="8f7a3b2c9d1e6f0a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1"
```

**Or in .env file**:

```env
ENCRYPTION_KEY=8f7a3b2c9d1e6f0a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1
```

::: danger Encryption Key Security
- **NEVER** commit the encryption key to version control
- Store key in a secrets manager (AWS Secrets Manager, HashiCorp Vault, etc.)
- Rotate the key periodically (requires re-encrypting all credentials)
- Use different keys for different environments
:::

### Access Control

Credential access is controlled through:

1. **Authentication**: JWT token required for all API calls
2. **Authorization**: RBAC (Role-Based Access Control)
   - `credential:read` - View credential metadata
   - `credential:create` - Create new credentials
   - `credential:update` - Update existing credentials
   - `credential:delete` - Delete credentials
   - `credential:use` - Use credentials in discovery

### Audit Trail

All credential operations are logged:

```sql
CREATE TABLE credential_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id UUID REFERENCES discovery_credentials(id),
  action VARCHAR(50) NOT NULL,  -- 'created', 'updated', 'deleted', 'accessed'
  performed_by VARCHAR(255) NOT NULL,
  performed_at TIMESTAMP DEFAULT NOW(),
  details JSONB
);
```

**Query audit logs**:

```sql
-- Recent credential access
SELECT
  c.name,
  al.action,
  al.performed_by,
  al.performed_at
FROM credential_audit_log al
JOIN discovery_credentials c ON al.credential_id = c.id
WHERE al.performed_at >= NOW() - INTERVAL '7 days'
ORDER BY al.performed_at DESC;
```

## Credential Rotation

### Rotation Best Practices

1. **Schedule**: Rotate credentials every 90 days
2. **Process**:
   - Create new credentials in provider (AWS, Azure, etc.)
   - Update credential in HappyCMDB
   - Test with discovery definition
   - Deactivate old credentials in provider
3. **Zero Downtime**: Update credential, definitions continue using new values

### Rotation Workflow

```bash
# 1. Create new credentials in cloud provider
# (AWS Console, Azure Portal, etc.)

# 2. Update credential in HappyCMDB
curl -X PUT http://localhost:3000/api/v1/credentials/cred-123-abc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "credentials": {
      "accessKeyId": "NEW_ACCESS_KEY_ID",
      "secretAccessKey": "NEW_SECRET_ACCESS_KEY"
    }
  }'

# 3. Test credential
curl -X POST http://localhost:3000/api/v1/credentials/cred-123-abc/test \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# 4. Run a discovery definition to verify
curl -X POST http://localhost:3000/api/v1/discovery/definitions/def-456/run \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# 5. Deactivate old credentials in cloud provider
```

## CLI Usage

### List Credentials

```bash
cmdb credentials list
cmdb credentials list --type aws
```

### Create Credential

```bash
# Interactive mode
cmdb credentials create

# From file
cmdb credentials create --file aws-creds.json
```

**Example JSON file**:
```json
{
  "name": "AWS Production",
  "type": "aws",
  "credentials": {
    "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
    "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "region": "us-east-1"
  }
}
```

### Update Credential

```bash
cmdb credentials update cred-123-abc --file updated-creds.json
```

### Delete Credential

```bash
cmdb credentials delete cred-123-abc
```

### Test Credential

```bash
cmdb credentials test cred-123-abc
```

## Troubleshooting

### Authentication Failures

**Problem**: Credential test fails with authentication error

**Solution**:
1. Verify credentials are correct in provider console
2. Check IAM permissions are sufficient
3. Ensure credentials haven't expired
4. Review audit logs for details

### Encryption Errors

**Problem**: "Decryption failed" error when using credential

**Solution**:
1. Verify `ENCRYPTION_KEY` environment variable is set
2. Ensure key hasn't changed since credential creation
3. Check for database corruption in `encrypted_credentials` field

### Permission Denied

**Problem**: User cannot create/update credentials

**Solution**:
1. Check user roles and permissions
2. Verify JWT token is valid
3. Review access control policies

### Credential Not Found

**Problem**: Discovery fails with "credential not found"

**Solution**:
1. Verify credential ID in discovery definition
2. Check if credential was deleted
3. Ensure credential exists in database

## Best Practices

1. **Use Least Privilege** - Grant only required permissions to credentials
2. **Separate by Environment** - Use different credentials for prod/staging/dev
3. **Rotate Regularly** - Change credentials every 90 days
4. **Monitor Usage** - Track credential usage and set up alerts
5. **Secure Key Storage** - Store encryption key in secrets manager
6. **Test Before Use** - Always test credentials after creation/update
7. **Document Purpose** - Use descriptive names and descriptions
8. **Audit Regularly** - Review audit logs for suspicious activity
9. **Delete Unused** - Remove credentials no longer in use
10. **Backup Key** - Securely backup encryption key for disaster recovery

## Related Resources

- [Discovery Guide](/getting-started/discovery-guide)
- [Discovery Definitions](/components/discovery-definitions)
- [Security Configuration](/configuration/security/secrets)
- [REST API Reference](/api/rest/credentials)
- [Troubleshooting](/troubleshooting/discovery)

---

**Last Updated**: 2025-10-05
**Maintainer**: HappyCMDB Team
