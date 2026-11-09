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

Sections 2-5 use these shell conventions:

- Run the commands in **bash** from the repository root. `read -s -p` is bash syntax (zsh's `read -p` reads from a coprocess). `.env` is the repository-root file that `docker-compose --env-file .env -f infrastructure/docker/docker-compose.yml` reads (README, Manual Setup).
- A block that ends in `read` must be pasted on its own, then typed into: lines pasted after a `read` would be consumed as its input. A `( ... )` block is parsed as a whole before it runs, so it is safe to paste.
- Each apply block is one `( set -eu ... )` subshell: the first failing command stops the rest, and its `umask 077` and `EXIT` trap (which removes `.env.new`) stay inside the subshell. Do not append `&&` or `||` to the closing `)`: bash ignores `set -e` inside a command that is part of such a list.
- `.env` is rewritten by awk, which reads the new value from its environment (`ENVIRON`), never from argv, and exits non-zero when the key is missing, so the old `.env` stays in place. `mv` leaves `.env` mode 600 and owned by you; it replaces the file, so restore any other owner or group your deployment needs (compare `ls -l .env` before and after).
- `docker-compose restart` keeps a container's old environment. `up -d --no-deps <service>` recreates the named services with the new `.env` value and leaves their dependencies running.
- The `EOF` terminator must start at column 0. The heredoc reaches `docker exec` on stdin; shell history records the literal `$NEW_PASSWORD`, not its value. Values embedded in a SQL string literal must not contain `'` or `\` (`openssl rand -base64` output is safe).
- While a command runs, its environment (the `docker exec` client, `node`) holds the value, visible only to the same user and root; PostgreSQL superusers can see the `ALTER USER` text in `pg_stat_activity` while it runs.
- When rotation is finished and rollback is no longer needed, `unset` the variables the section set.

### 1. Neo4j Password Rotation

**Impact**: High - All services connecting to Neo4j will be affected
**Downtime**: ~5 minutes

**Procedure**:

```bash
# 1. Read the current password (no echo, nothing on argv) and generate the new one
read -rsp 'Current Neo4j password: ' OLD_PASSWORD; echo
NEW_PASSWORD=$(openssl rand -base64 32)

# 2. Update Neo4j password (in running container). The statement goes to
#    cypher-shell on stdin, so neither password appears on any command line.
NEO4J_PASSWORD="$OLD_PASSWORD" docker exec -i -e NEO4J_PASSWORD cmdb-neo4j cypher-shell -u neo4j <<EOF
ALTER CURRENT USER SET PASSWORD FROM '$OLD_PASSWORD' TO '$NEW_PASSWORD';
EOF

# 3. Update .env file (awk reads the value from its environment, not argv;
#    unlike sed it needs no escaping of "/" or "&" in the base64 value)
(umask 077; NEW_PASSWORD="$NEW_PASSWORD" awk 'BEGIN{FS="="} $1=="NEO4J_PASSWORD"{print "NEO4J_PASSWORD=" ENVIRON["NEW_PASSWORD"]; next} {print}' .env > .env.new) && mv .env.new .env

# 4. Restart affected services
docker-compose -f infrastructure/docker/docker-compose.yml restart api-server discovery-engine etl-processor

# 5. Verify connectivity
docker-compose -f infrastructure/docker/docker-compose.yml logs api-server | grep "Neo4j connected"
```

Notes:

- Never pass a password as a `cypher-shell` argument or inside a `docker exec` command string: it would be visible in `ps` on the host, in `docker exec` and in the container's process list, and in shell history.
- The `EOF` terminator must start at column 0 (no indentation, no trailing spaces). The shell feeds the heredoc to `docker exec` over stdin, not on the command line; history records the literal `$OLD_PASSWORD`/`$NEW_PASSWORD`, not their values. `-i` is required and `-t` must not be used.
- Values must not contain `'` or `\` (they are embedded in a Cypher string literal). `openssl rand -base64` output is safe; escape a legacy current password that contains either character.
- The `docker exec` client environment holds the current password while the command runs (visible only to the same user and root).
- `mv` leaves `.env` mode 600 because of `umask 077`; confirm with `ls -l .env`.

**Rollback**:
```bash
# If rotation fails, revert password in Neo4j (same stdin form as step 2)
NEO4J_PASSWORD="$NEW_PASSWORD" docker exec -i -e NEO4J_PASSWORD cmdb-neo4j cypher-shell -u neo4j <<EOF
ALTER CURRENT USER SET PASSWORD FROM '$NEW_PASSWORD' TO '$OLD_PASSWORD';
EOF
```

The `EOF` terminator must start at column 0 (no indentation, no trailing spaces). The same rules as step 2 apply: no `'` or `\` in either value, and the `docker exec` client environment holds the current password while the command runs.

### 2. PostgreSQL Password Rotation

**Impact**: High - All services connecting to PostgreSQL will be affected
**Downtime**: ~5 minutes

**Procedure**:

```bash
# 1. Generate the new password and read the current one (no echo, nothing on argv).
#    Paste this block on its own, then type the password.
NEW_PG_PASSWORD=$(openssl rand -base64 32)
IFS= read -rsp 'Current PostgreSQL password: ' OLD_PG_PASSWORD; echo
```

```bash
(
set -eu
umask 077
trap 'rm -f .env.new' EXIT
: "${NEW_PG_PASSWORD:?}" "${OLD_PG_PASSWORD:?}"
# 2. Stage the new .env (fails here, before the database changes, if the key is missing)
NEW_PG_PASSWORD="$NEW_PG_PASSWORD" awk -F= '$1=="POSTGRES_PASSWORD"{print "POSTGRES_PASSWORD=" ENVIRON["NEW_PG_PASSWORD"]; f=1; next} {print} END{exit !f}' .env > .env.new
# 3. Update the PostgreSQL password. The SQL reaches psql on stdin; the SETs keep
#    this session's statements out of the server log (compose logs statements
#    slower than 1s, and failing statements by default). PGPASSWORD is only
#    needed if pg_hba.conf requires a password for local socket connections.
PGPASSWORD="$OLD_PG_PASSWORD" docker exec -i -e PGPASSWORD cmdb-postgres psql -X -v ON_ERROR_STOP=1 -U cmdb_user -d cmdb <<EOF
SET log_statement = 'none';
SET log_min_duration_statement = -1;
SET log_min_error_statement = panic;
ALTER USER cmdb_user WITH PASSWORD '$NEW_PG_PASSWORD';
EOF
# 4. Install the new .env and recreate the services that read POSTGRES_PASSWORD
#    (grafana uses it as GF_DATABASE_PASSWORD)
mv .env.new .env
docker-compose --env-file .env -f infrastructure/docker/docker-compose.yml up -d --no-deps api-server grafana
)
```

```bash
# 5. Verify connectivity (after the block above succeeds). /api/v1/cmdb-health/ready
#    answers 200 only when the API server can run SELECT 1 on PostgreSQL (and
#    reach Neo4j and Redis), 503 otherwise; retry while the container starts.
for i in $(seq 1 24); do curl -fsS http://localhost:3000/api/v1/cmdb-health/ready && break; sleep 5; done
```

The `postgres` service is not recreated: its `POSTGRES_PASSWORD` is only used when the data directory is first initialised.

If the block fails at `up -d` (after `mv`), the database and `.env` already hold the new password: re-run only the `docker-compose ... up -d` line. Do not re-run step 1, which would generate a different password.

### 3. JWT Secret Rotation

**Impact**: Critical - All existing user sessions will be invalidated
**Downtime**: None (rolling restart possible)

**Procedure**:

```bash
# 1. Generate new JWT secret (minimum 32 characters)
NEW_JWT_SECRET=$(openssl rand -base64 48)

(
set -eu
umask 077
trap 'rm -f .env.new' EXIT
: "${NEW_JWT_SECRET:?}"
# 2. Update .env file
NEW_JWT_SECRET="$NEW_JWT_SECRET" awk -F= '$1=="JWT_SECRET"{print "JWT_SECRET=" ENVIRON["NEW_JWT_SECRET"]; f=1; next} {print} END{exit !f}' .env > .env.new
mv .env.new .env
# 3. Recreate the API server with the new secret
docker-compose --env-file .env -f infrastructure/docker/docker-compose.yml up -d --no-deps api-server
# 4. Notify users
echo "IMPORTANT: All users must log in again due to security maintenance"
)
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
# 1. Backup current credentials (file mode 600; stops if the dump fails or is
#    empty). Paste this block on its own: pg_dump may prompt for a password.
(
set -eu
umask 077
trap 'rm -f credentials_backup.sql.tmp' EXIT
pg_dump -U cmdb_user -t discovery_credentials cmdb > credentials_backup.sql.tmp
test -s credentials_backup.sql.tmp
mv credentials_backup.sql.tmp credentials_backup.sql
)
```

```bash
# 2. Generate the new encryption key and read the current one (no echo,
#    nothing on argv). Paste this block on its own, then type the key.
NEW_ENCRYPTION_KEY=$(openssl rand -base64 32)
IFS= read -rsp 'Current ENCRYPTION_KEY: ' OLD_ENCRYPTION_KEY; echo
```

```bash
(
set -eu
umask 077
trap 'rm -f .env.new' EXIT
: "${NEW_ENCRYPTION_KEY:?}" "${OLD_ENCRYPTION_KEY:?}"
test -s credentials_backup.sql
# 3. Stage the new .env (fails here, before any credential changes, if the key is missing)
NEW_ENCRYPTION_KEY="$NEW_ENCRYPTION_KEY" awk -F= '$1=="ENCRYPTION_KEY"{print "ENCRYPTION_KEY=" ENVIRON["NEW_ENCRYPTION_KEY"]; f=1; next} {print} END{exit !f}' .env > .env.new
# 4. Re-encrypt with the script below. The keys reach it through its
#    environment, never as arguments.
OLD_ENCRYPTION_KEY="$OLD_ENCRYPTION_KEY" NEW_ENCRYPTION_KEY="$NEW_ENCRYPTION_KEY" \
  node infrastructure/scripts/reencrypt-credentials.js
# 5. Install the new .env and recreate the API server (it reads ENCRYPTION_KEY
#    as CREDENTIAL_ENCRYPTION_KEY)
mv .env.new .env
docker-compose --env-file .env -f infrastructure/docker/docker-compose.yml up -d --no-deps api-server
)
```

```bash
# 6. Test credential decryption (after the block above succeeds)
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/credentials/test-credential-id/test
```

If the block fails at `up -d` (after `mv`), the credentials are already re-encrypted and `.env` holds the new key: re-run only the `docker-compose ... up -d` line. Do not re-run step 2 or the block, which would try to decrypt with the old key again.

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

// Keys come from the environment, never argv (argv is visible in `ps`)
const oldKey = process.env.OLD_ENCRYPTION_KEY;
const newKey = process.env.NEW_ENCRYPTION_KEY;

if (!oldKey || !newKey) {
  console.error('Set OLD_ENCRYPTION_KEY and NEW_ENCRYPTION_KEY in the environment (see step 4 above)');
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

# Revert the encryption key and recreate the API server (same shell as the
# rotation, so OLD_ENCRYPTION_KEY is still set)
(
set -eu
umask 077
trap 'rm -f .env.new' EXIT
: "${OLD_ENCRYPTION_KEY:?}"
OLD_ENCRYPTION_KEY="$OLD_ENCRYPTION_KEY" awk -F= '$1=="ENCRYPTION_KEY"{print "ENCRYPTION_KEY=" ENVIRON["OLD_ENCRYPTION_KEY"]; f=1; next} {print} END{exit !f}' .env > .env.new
mv .env.new .env
docker-compose --env-file .env -f infrastructure/docker/docker-compose.yml up -d --no-deps api-server
)
```

### 5. Grafana Admin Password Rotation

**Impact**: Low - Only affects Grafana admin access
**Downtime**: None

**Procedure**:

```bash
# 1. Read the new password from your password manager (no echo, nothing on
#    argv, never printed). Paste this block on its own, then type the password.
IFS= read -rsp 'New Grafana admin password: ' NEW_GRAFANA_PASSWORD; echo
```

```bash
(
set -eu
umask 077
trap 'rm -f .env.new' EXIT
: "${NEW_GRAFANA_PASSWORD:?}"
# 2. Stage the new .env
NEW_GRAFANA_PASSWORD="$NEW_GRAFANA_PASSWORD" awk -F= '$1=="GRAFANA_ADMIN_PASSWORD"{print "GRAFANA_ADMIN_PASSWORD=" ENVIRON["NEW_GRAFANA_PASSWORD"]; f=1; next} {print} END{exit !f}' .env > .env.new
# 3. Reset the admin password in Grafana's database. The CLI reads the new
#    password from stdin (--password-from-stdin), not from its arguments.
docker exec -i cmdb-grafana grafana cli admin reset-admin-password --password-from-stdin <<EOF
$NEW_GRAFANA_PASSWORD
EOF
# 4. Install the new .env so it matches the database (no restart needed)
mv .env.new .env
)
# 5. Log in to Grafana with the password from your password manager
```

Notes:

- `GF_SECURITY_ADMIN_PASSWORD` (set from `GRAFANA_ADMIN_PASSWORD`) only applies when Grafana first creates the admin user, so changing `.env` and restarting does not rotate the password; the CLI reset does.
- The CLI resets user ID 1 (the admin created at first run). If your admin has another ID, add `--user-id <id>` after `--password-from-stdin`. The password must be a single line of at least 4 characters. Avoid `$`, `#`, quotes, `\` and leading or trailing spaces: Compose interpolates unquoted `.env` values, so such a password would differ between `.env` and the database.
- If the CLI cannot find Grafana's home directory, run it as `grafana cli --homepath /usr/share/grafana admin reset-admin-password --password-from-stdin`.

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
