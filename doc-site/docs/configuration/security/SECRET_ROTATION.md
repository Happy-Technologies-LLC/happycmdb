# Secret Rotation Guide - HappyCMDB v2.0

## Overview

This document provides procedures for rotating secrets and credentials in the HappyCMDB platform. Secret rotation should be performed:

- **Immediately** if secrets were exposed (committed to Git, logged, etc.)
- **Regularly** as part of security best practices (quarterly recommended)
- **After** employee/contractor departures
- **Following** security audits or penetration tests

## Secrets Requiring Rotation

### Wave 1 - Previously Hardcoded Secrets (January 2025)

The following secrets were removed from `docker-compose.yml` in Wave 1 and should be rotated if the repository was ever public or shared externally:

| Secret Type | Environment Variable | Rotation Priority | Notes |
|------------|---------------------|-------------------|-------|
| Neo4j Password | `NEO4J_PASSWORD` | **CRITICAL** | Was hardcoded as `cmdb_neo4j_pass` |
| PostgreSQL Password | `POSTGRES_PASSWORD` | **CRITICAL** | Was hardcoded as `cmdb_postgres_pass` |
| JWT Secret | `JWT_SECRET` | **CRITICAL** | Was hardcoded as `your-secret-jwt-key` |
| Encryption Key | `ENCRYPTION_KEY` | **CRITICAL** | Was hardcoded as `your-secret-encryption-key` |
| Grafana Admin Password | `GRAFANA_ADMIN_PASSWORD` | **HIGH** | Was hardcoded as `admin` |
| Rate Limit Bypass Secret | `RATE_LIMIT_BYPASS_SECRET` | **HIGH** | Was hardcoded as `your-internal-service-secret` |

### Wave 2 - Code-Level Secrets (Current)

The following secrets were found hardcoded in source code and should be rotated:

| Secret Type | Location | Rotation Priority | Status |
|------------|----------|-------------------|--------|
| Seed Script Password | `infrastructure/scripts/seed-data.ts` | **MEDIUM** | ✅ Fixed - Now uses env vars |
| Login Form Defaults | `web-ui/src/components/auth/LoginForm.tsx` | **HIGH** | ✅ Fixed - Removed hardcoded values |
| Test Passwords | Multiple test files | **LOW** | Test-only, but should use env vars |

## Rotation Procedures

### 1. Neo4j Password Rotation

**Impact**: High - All services connecting to Neo4j will be affected
**Downtime**: ~5 minutes

**Procedure**:

```bash
# 1. Generate new password
NEW_PASSWORD=$(openssl rand -base64 32)

# 2. Update Neo4j password (in running container)
docker exec cmdb-neo4j cypher-shell -u neo4j -p "$OLD_PASSWORD" \
  "ALTER CURRENT USER SET PASSWORD FROM '$OLD_PASSWORD' TO '$NEW_PASSWORD'"

# 3. Update .env file
sed -i "s/NEO4J_PASSWORD=.*/NEO4J_PASSWORD=$NEW_PASSWORD/" .env

# 4. Restart affected services
docker-compose -f infrastructure/docker/docker-compose.yml restart api-server discovery-engine etl-processor

# 5. Verify connectivity
docker-compose -f infrastructure/docker/docker-compose.yml logs api-server | grep "Neo4j connected"
```

**Rollback**:
```bash
# If rotation fails, revert password in Neo4j
docker exec cmdb-neo4j cypher-shell -u neo4j -p "$NEW_PASSWORD" \
  "ALTER CURRENT USER SET PASSWORD FROM '$NEW_PASSWORD' TO '$OLD_PASSWORD'"
```

### 2. PostgreSQL Password Rotation

**Impact**: High - All services connecting to PostgreSQL will be affected
**Downtime**: ~5 minutes

**Procedure**:

```bash
# 1. Generate new password
NEW_PASSWORD=$(openssl rand -base64 32)

# 2. Update PostgreSQL password
docker exec cmdb-postgres psql -U postgres -c \
  "ALTER USER cmdb_user WITH PASSWORD '$NEW_PASSWORD';"

# 3. Update .env file
sed -i "s/POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$NEW_PASSWORD/" .env

# 4. Restart affected services
docker-compose -f infrastructure/docker/docker-compose.yml restart api-server etl-processor

# 5. Verify connectivity
docker-compose -f infrastructure/docker/docker-compose.yml logs api-server | grep "PostgreSQL connected"
```

### 3. JWT Secret Rotation

**Impact**: Critical - All existing user sessions will be invalidated
**Downtime**: None (rolling restart possible)

**Procedure**:

```bash
# 1. Generate new JWT secret (minimum 32 characters)
NEW_JWT_SECRET=$(openssl rand -base64 48)

# 2. Update .env file
sed -i "s/JWT_SECRET=.*/JWT_SECRET=$NEW_JWT_SECRET/" .env

# 3. Restart API server
docker-compose -f infrastructure/docker/docker-compose.yml restart api-server

# 4. Notify users
echo "IMPORTANT: All users must log in again due to security maintenance"
```

**Considerations**:
- All users will be logged out immediately
- API tokens will be invalidated
- Schedule during maintenance window
- Notify users in advance

### 4. Encryption Key Rotation

**Impact**: **CRITICAL** - Requires re-encrypting all stored credentials
**Downtime**: ~30 minutes (depending on credential count)

⚠️ **WARNING**: This is a complex procedure. Test in staging first!

**Prerequisites**:
- Full database backup
- Tested rollback procedure
- Maintenance window scheduled

**Procedure**:

```bash
# 1. Backup current credentials
pg_dump -U cmdb_user -t discovery_credentials cmdb > credentials_backup.sql

# 2. Generate new encryption key
NEW_ENCRYPTION_KEY=$(openssl rand -base64 32)

# 3. Create re-encryption script (see below)
node infrastructure/scripts/reencrypt-credentials.js \
  --old-key="$OLD_ENCRYPTION_KEY" \
  --new-key="$NEW_ENCRYPTION_KEY"

# 4. Update .env file
sed -i "s/ENCRYPTION_KEY=.*/ENCRYPTION_KEY=$NEW_ENCRYPTION_KEY/" .env

# 5. Restart services
docker-compose -f infrastructure/docker/docker-compose.yml restart api-server discovery-engine

# 6. Test credential decryption
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/credentials/test-credential-id/test
```

**Re-encryption Script** (`infrastructure/scripts/reencrypt-credentials.js`):

```javascript
#!/usr/bin/env node
const { Pool } = require('pg');
const { EncryptionService } = require('@cmdb/common');

async function reencryptCredentials(oldKey, newKey) {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST,
    port: process.env.POSTGRES_PORT,
    database: process.env.POSTGRES_DATABASE,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
  });

  const oldEncryption = new EncryptionService(oldKey);
  const newEncryption = new EncryptionService(newKey);

  try {
    const { rows } = await pool.query('SELECT id, credentials FROM discovery_credentials');

    console.log(`Re-encrypting ${rows.length} credentials...`);

    for (const row of rows) {
      // Decrypt with old key
      const decrypted = oldEncryption.decrypt(row.credentials);

      // Encrypt with new key
      const encrypted = newEncryption.encrypt(decrypted);

      // Update database
      await pool.query(
        'UPDATE discovery_credentials SET credentials = $1, updated_at = NOW() WHERE id = $2',
        [encrypted, row.id]
      );

      console.log(`✓ Re-encrypted credential ${row.id}`);
    }

    console.log(`Successfully re-encrypted ${rows.length} credentials`);
  } catch (error) {
    console.error('Re-encryption failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Parse command-line arguments
const args = process.argv.slice(2);
const oldKey = args.find(arg => arg.startsWith('--old-key='))?.split('=')[1];
const newKey = args.find(arg => arg.startsWith('--new-key='))?.split('=')[1];

if (!oldKey || !newKey) {
  console.error('Usage: node reencrypt-credentials.js --old-key=OLD_KEY --new-key=NEW_KEY');
  process.exit(1);
}

reencryptCredentials(oldKey, newKey)
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
```

**Rollback**:
```bash
# Restore from backup
psql -U cmdb_user cmdb < credentials_backup.sql

# Revert encryption key
sed -i "s/ENCRYPTION_KEY=.*/ENCRYPTION_KEY=$OLD_ENCRYPTION_KEY/" .env

# Restart services
docker-compose -f infrastructure/docker/docker-compose.yml restart api-server discovery-engine
```

### 5. Grafana Admin Password Rotation

**Impact**: Low - Only affects Grafana admin access
**Downtime**: None

**Procedure**:

```bash
# 1. Generate new password
NEW_PASSWORD=$(openssl rand -base64 24)

# 2. Update .env file
sed -i "s/GRAFANA_ADMIN_PASSWORD=.*/GRAFANA_ADMIN_PASSWORD=$NEW_PASSWORD/" .env

# 3. Update Grafana database directly
docker exec cmdb-postgres psql -U cmdb_user -d grafana -c \
  "UPDATE \"user\" SET password = '*', salt = '*' WHERE login = 'admin';"

# 4. Restart Grafana
docker-compose -f infrastructure/docker/docker-compose.yml restart grafana

# 5. Login with new password
echo "New Grafana admin password: $NEW_PASSWORD"
```

### 6. Cloud Provider Credentials (AWS, Azure, GCP)

**Impact**: Medium - Affects discovery jobs only
**Downtime**: None (credential rotation happens in PostgreSQL)

**Procedure** (via Web UI):

1. Navigate to **Settings > Credentials**
2. Select the credential to rotate
3. Click **Edit Credential**
4. Update access keys/secrets
5. Click **Save** (automatically re-encrypts with current key)
6. Test credential: Click **Test Connection**

**Procedure** (via API):

```bash
# Update AWS credentials
curl -X PUT http://localhost:3000/api/v1/credentials/aws-prod \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "credentials": {
      "access_key_id": "AKIA_NEW_KEY",
      "secret_access_key": "new-secret-key"
    }
  }'

# Test the updated credential
curl -X POST http://localhost:3000/api/v1/credentials/aws-prod/test \
  -H "Authorization: Bearer $TOKEN"
```

## Rotation Checklist

Use this checklist when performing secret rotation:

### Pre-Rotation

- [ ] Identify which secrets need rotation
- [ ] Review impact and downtime estimates
- [ ] Schedule maintenance window (if needed)
- [ ] Notify users of potential downtime
- [ ] Create full database backup
- [ ] Test rotation procedure in staging environment
- [ ] Prepare rollback plan

### During Rotation

- [ ] Generate new secrets using cryptographically secure methods
- [ ] Document old secret values (store securely for rollback)
- [ ] Update secrets in order of dependency
- [ ] Test connectivity after each rotation
- [ ] Monitor service logs for errors
- [ ] Verify all services are healthy

### Post-Rotation

- [ ] Verify all services are operational
- [ ] Test end-to-end functionality
- [ ] Update secret documentation
- [ ] Securely destroy old secrets
- [ ] Update monitoring/alerting configurations
- [ ] Document rotation in change log
- [ ] Notify users that maintenance is complete

## Secret Generation Best Practices

### Password Requirements

- **Minimum length**: 32 characters
- **Character set**: A-Z, a-z, 0-9, special characters
- **Entropy**: At least 128 bits
- **Method**: Use cryptographically secure random generator

### Generation Commands

```bash
# General password (32 chars, base64)
openssl rand -base64 32

# Hex password (64 chars)
openssl rand -hex 32

# Alphanumeric password (32 chars)
< /dev/urandom tr -dc 'A-Za-z0-9' | head -c32

# Password with special characters
< /dev/urandom tr -dc 'A-Za-z0-9!@#$%^&*()_+' | head -c32
```

### bcrypt Password Hashing

```bash
# Generate bcrypt hash (for seed data)
node -e "console.log(require('bcryptjs').hashSync('YourPassword', 10))"

# Verify bcrypt hash
node -e "console.log(require('bcryptjs').compareSync('YourPassword', '\$2b\$10\$...'))"
```

## Emergency Rotation (Secrets Exposed)

If secrets are exposed (e.g., committed to Git, logged, or leaked):

1. **Immediate Action** (within 1 hour):
   ```bash
   # Rotate all critical secrets immediately
   ./infrastructure/scripts/emergency-rotation.sh
   ```

2. **Git History Cleanup** (if committed):
   ```bash
   # Use BFG Repo-Cleaner or git-filter-repo
   git filter-repo --path .env --invert-paths
   git push --force --all
   ```

3. **Audit**:
   - Check access logs for unauthorized access
   - Review database audit logs
   - Check for data exfiltration
   - Document incident timeline

4. **Notification**:
   - Notify security team
   - File incident report
   - Update stakeholders
   - Consider regulatory reporting requirements

## Automated Rotation (Future Enhancement)

Consider implementing automated secret rotation:

- Use AWS Secrets Manager, Azure Key Vault, or HashiCorp Vault
- Implement automatic rotation schedules (90 days)
- Use short-lived credentials where possible
- Implement secret versioning
- Enable audit logging for all secret access

## References

- [NIST SP 800-63B - Digital Identity Guidelines](https://pages.nist.gov/800-63-3/sp800-63b.html)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
- [CIS Controls - Secure Configuration](https://www.cisecurity.org/controls)

## Support

For assistance with secret rotation:

- **Documentation**: http://localhost:8080/operations/troubleshooting
- **Security Team**: security@happycmdb.local
- **Emergency**: Follow incident response procedures
