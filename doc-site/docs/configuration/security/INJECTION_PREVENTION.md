# SQL/NoSQL Injection Prevention Guide

**Version**: 1.0
**Last Updated**: 2025-10-19
**Owner**: Security Team

## Overview

This guide provides comprehensive strategies to prevent SQL and NoSQL injection attacks in HappyCMDB. Injection vulnerabilities occur when untrusted data is sent to an interpreter as part of a command or query.

---

## 1. SQL Injection Prevention (PostgreSQL)

### 1.1 Use Parameterized Queries

**ALWAYS use parameterized queries** (also called prepared statements). Never concatenate user input into SQL strings.

#### ❌ VULNERABLE CODE

```typescript
// NEVER DO THIS - Vulnerable to SQL injection
const userId = req.params.id;
const query = `SELECT * FROM users WHERE id = '${userId}'`;
const result = await client.query(query);

// Attack: ?id=' OR '1'='1
// Result: SELECT * FROM users WHERE id = '' OR '1'='1'
// Returns all users!
```

#### ✅ SECURE CODE

```typescript
// ALWAYS DO THIS - Use parameterized queries
const userId = req.params.id;
const query = 'SELECT * FROM users WHERE id = $1';
const result = await client.query(query, [userId]);

// Attack: ?id=' OR '1'='1
// Result: No injection - $1 is treated as literal string
```

### 1.2 PostgreSQL Query Examples

#### SELECT Queries

```typescript
// Single parameter
const result = await client.query(
  'SELECT * FROM ci WHERE ci_id = $1',
  [ciId]
);

// Multiple parameters
const result = await client.query(
  'SELECT * FROM ci WHERE ci_type = $1 AND environment = $2',
  [ciType, environment]
);

// IN clause (array parameter)
const result = await client.query(
  'SELECT * FROM ci WHERE ci_id = ANY($1::uuid[])',
  [ciIds]
);

// LIKE clause
const result = await client.query(
  'SELECT * FROM ci WHERE ci_name ILIKE $1',
  [`%${searchTerm}%`] // Parameterize, but build pattern safely
);
```

#### INSERT Queries

```typescript
// Single insert
const result = await client.query(
  'INSERT INTO ci (ci_name, ci_type, environment) VALUES ($1, $2, $3) RETURNING ci_id',
  [ciName, ciType, environment]
);

// Multiple inserts (batch)
const values = cis.map((ci, index) => {
  const offset = index * 3;
  return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
}).join(', ');

const params = cis.flatMap(ci => [ci.ci_name, ci.ci_type, ci.environment]);

const result = await client.query(
  `INSERT INTO ci (ci_name, ci_type, environment) VALUES ${values}`,
  params
);
```

#### UPDATE Queries

```typescript
// Simple update
const result = await client.query(
  'UPDATE ci SET ci_status = $1 WHERE ci_id = $2',
  [status, ciId]
);

// Multiple columns
const result = await client.query(
  'UPDATE ci SET ci_name = $1, environment = $2, updated_at = $3 WHERE ci_id = $4',
  [ciName, environment, new Date(), ciId]
);

// Conditional update
const result = await client.query(
  'UPDATE ci SET ci_status = $1 WHERE ci_id = $2 AND ci_status = $3',
  [newStatus, ciId, currentStatus]
);
```

#### DELETE Queries

```typescript
// Simple delete
const result = await client.query(
  'DELETE FROM ci WHERE ci_id = $1',
  [ciId]
);

// Conditional delete
const result = await client.query(
  'DELETE FROM ci WHERE ci_id = $1 AND ci_status = $2',
  [ciId, 'decommissioned']
);
```

### 1.3 Dynamic Query Building (Advanced)

When you need dynamic WHERE clauses or column names:

#### ✅ SAFE Dynamic WHERE Clause

```typescript
interface QueryFilters {
  ci_type?: string;
  environment?: string;
  ci_status?: string;
}

function buildDynamicQuery(filters: QueryFilters) {
  let query = 'SELECT * FROM ci WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;

  if (filters.ci_type) {
    query += ` AND ci_type = $${paramIndex}`;
    params.push(filters.ci_type);
    paramIndex++;
  }

  if (filters.environment) {
    query += ` AND environment = $${paramIndex}`;
    params.push(filters.environment);
    paramIndex++;
  }

  if (filters.ci_status) {
    query += ` AND ci_status = $${paramIndex}`;
    params.push(filters.ci_status);
    paramIndex++;
  }

  return { query, params };
}

// Usage
const { query, params } = buildDynamicQuery({ ci_type: 'server', environment: 'production' });
const result = await client.query(query, params);
```

#### ✅ SAFE Column Name Whitelisting

```typescript
// Whitelist allowed column names
const ALLOWED_SORT_COLUMNS = ['ci_name', 'created_at', 'updated_at', 'ci_type'];

function buildSortQuery(sortColumn: string, sortOrder: 'ASC' | 'DESC') {
  // Validate column name against whitelist
  if (!ALLOWED_SORT_COLUMNS.includes(sortColumn)) {
    throw new Error('Invalid sort column');
  }

  // Validate sort order
  if (!['ASC', 'DESC'].includes(sortOrder)) {
    throw new Error('Invalid sort order');
  }

  // Safe to use after validation (not a parameter, but validated)
  const query = `SELECT * FROM ci ORDER BY ${sortColumn} ${sortOrder}`;
  return query;
}
```

### 1.4 ORM Usage (TypeORM)

If using an ORM like TypeORM, use its query builder:

```typescript
// Query builder (safe)
const cis = await ciRepository
  .createQueryBuilder('ci')
  .where('ci.ci_type = :ciType', { ciType: 'server' })
  .andWhere('ci.environment = :environment', { environment: 'production' })
  .getMany();

// Repository methods (safe)
const ci = await ciRepository.findOne({
  where: { ci_id: ciId }
});

// Raw queries with parameters (safe)
const result = await ciRepository.query(
  'SELECT * FROM ci WHERE ci_type = $1',
  [ciType]
);
```

### 1.5 PostgreSQL Security Best Practices

- ✅ Use least-privilege database users (no DROP/CREATE for app user)
- ✅ Enable query logging for debugging (disable in production for performance)
- ✅ Use row-level security (RLS) for multi-tenant data
- ✅ Sanitize input even before it reaches the database
- ✅ Use database roles and grants to limit access
- ✅ Regularly audit database permissions

---

## 2. NoSQL Injection Prevention (Neo4j)

### 2.1 Use Parameterized Cypher Queries

Neo4j's Cypher query language supports parameterization similar to SQL.

#### ❌ VULNERABLE CODE

```typescript
// NEVER DO THIS - Vulnerable to Cypher injection
const ciName = req.query.name;
const query = `MATCH (ci:CI {ci_name: '${ciName}'}) RETURN ci`;
const result = await session.run(query);

// Attack: ?name=' OR 1=1 //
// Result: MATCH (ci:CI {ci_name: '' OR 1=1 //}) RETURN ci
// May return all nodes or cause errors
```

#### ✅ SECURE CODE

```typescript
// ALWAYS DO THIS - Use parameterized queries
const ciName = req.query.name;
const query = 'MATCH (ci:CI {ci_name: $ciName}) RETURN ci';
const result = await session.run(query, { ciName });

// Attack: ?name=' OR 1=1 //
// Result: No injection - $ciName is treated as literal string
```

### 2.2 Neo4j Cypher Examples

#### MATCH Queries

```typescript
// Single parameter
const result = await session.run(
  'MATCH (ci:CI {ci_id: $ciId}) RETURN ci',
  { ciId }
);

// Multiple parameters
const result = await session.run(
  'MATCH (ci:CI) WHERE ci.ci_type = $ciType AND ci.environment = $environment RETURN ci',
  { ciType, environment }
);

// Relationship queries
const result = await session.run(
  'MATCH (ci:CI {ci_id: $ciId})-[r:DEPENDS_ON]->(dep:CI) RETURN dep',
  { ciId }
);

// Pattern matching with parameters
const result = await session.run(
  'MATCH (ci:CI) WHERE ci.ci_name =~ $pattern RETURN ci',
  { pattern: `.*${searchTerm}.*` } // Parameterize pattern
);
```

#### CREATE Queries

```typescript
// Create node
const result = await session.run(
  'CREATE (ci:CI {ci_id: $ciId, ci_name: $ciName, ci_type: $ciType}) RETURN ci',
  { ciId, ciName, ciType }
);

// Create relationship
const result = await session.run(
  'MATCH (a:CI {ci_id: $sourceId}), (b:CI {ci_id: $targetId}) CREATE (a)-[r:DEPENDS_ON]->(b) RETURN r',
  { sourceId, targetId }
);

// Create with properties
const result = await session.run(
  'CREATE (ci:CI $properties) RETURN ci',
  { properties: { ci_id: ciId, ci_name: ciName, ci_type: ciType } }
);
```

#### UPDATE Queries (SET)

```typescript
// Update properties
const result = await session.run(
  'MATCH (ci:CI {ci_id: $ciId}) SET ci.ci_status = $status RETURN ci',
  { ciId, status }
);

// Update multiple properties
const result = await session.run(
  'MATCH (ci:CI {ci_id: $ciId}) SET ci += $properties RETURN ci',
  { ciId, properties: { ci_status: status, updated_at: new Date() } }
);

// Conditional update
const result = await session.run(
  'MATCH (ci:CI {ci_id: $ciId}) WHERE ci.ci_status = $currentStatus SET ci.ci_status = $newStatus RETURN ci',
  { ciId, currentStatus, newStatus }
);
```

#### DELETE Queries

```typescript
// Delete node
const result = await session.run(
  'MATCH (ci:CI {ci_id: $ciId}) DETACH DELETE ci',
  { ciId }
);

// Delete relationship
const result = await session.run(
  'MATCH (a:CI {ci_id: $sourceId})-[r:DEPENDS_ON]->(b:CI {ci_id: $targetId}) DELETE r',
  { sourceId, targetId }
);
```

### 2.3 Dynamic Cypher Query Building

#### ✅ SAFE Dynamic WHERE Clause

```typescript
interface CypherFilters {
  ci_type?: string;
  environment?: string;
  ci_status?: string;
}

function buildDynamicCypherQuery(filters: CypherFilters) {
  let query = 'MATCH (ci:CI)';
  const whereClauses: string[] = [];
  const params: any = {};

  if (filters.ci_type) {
    whereClauses.push('ci.ci_type = $ciType');
    params.ciType = filters.ci_type;
  }

  if (filters.environment) {
    whereClauses.push('ci.environment = $environment');
    params.environment = filters.environment;
  }

  if (filters.ci_status) {
    whereClauses.push('ci.ci_status = $ciStatus');
    params.ciStatus = filters.ci_status;
  }

  if (whereClauses.length > 0) {
    query += ' WHERE ' + whereClauses.join(' AND ');
  }

  query += ' RETURN ci';

  return { query, params };
}

// Usage
const { query, params } = buildDynamicCypherQuery({ ci_type: 'server', environment: 'production' });
const result = await session.run(query, params);
```

#### ✅ SAFE Label Whitelisting

```typescript
// Whitelist allowed node labels
const ALLOWED_LABELS = ['CI', 'Server', 'Application', 'Database', 'NetworkDevice'];

function buildLabelQuery(label: string) {
  // Validate label against whitelist
  if (!ALLOWED_LABELS.includes(label)) {
    throw new Error('Invalid node label');
  }

  // Safe to use after validation
  const query = `MATCH (n:${label}) RETURN n`;
  return query;
}
```

### 2.4 Neo4j Security Best Practices

- ✅ Use parameterized queries for all user input
- ✅ Enable authentication and authorization
- ✅ Use role-based access control (RBAC)
- ✅ Limit graph traversal depth to prevent DoS
- ✅ Use database roles to restrict access
- ✅ Sanitize input before constructing queries
- ✅ Avoid dynamic label/relationship type construction from user input

---

## 3. NoSQL Injection Prevention (MongoDB/Redis)

While HappyCMDB primarily uses PostgreSQL and Neo4j, here are best practices for other databases:

### 3.1 MongoDB

#### ❌ VULNERABLE CODE

```typescript
// NEVER DO THIS - Vulnerable to NoSQL injection
const userId = req.query.userId;
const user = await db.collection('users').findOne({ userId: userId });

// Attack: ?userId[$ne]=null
// Result: { userId: { $ne: null } } - Returns first user where userId is not null
```

#### ✅ SECURE CODE

```typescript
// ALWAYS DO THIS - Validate and sanitize
const userId = req.query.userId;

// Ensure userId is a string, not an object
if (typeof userId !== 'string') {
  throw new Error('Invalid userId');
}

const user = await db.collection('users').findOne({ userId: userId });
```

#### MongoDB Operator Blacklist

```typescript
function sanitizeMongoQuery(query: any): any {
  const DANGEROUS_OPERATORS = ['$where', '$regex', '$ne', '$gt', '$gte', '$lt', '$lte'];

  for (const key in query) {
    if (DANGEROUS_OPERATORS.includes(key)) {
      throw new Error(`Operator ${key} not allowed`);
    }

    if (typeof query[key] === 'object') {
      sanitizeMongoQuery(query[key]); // Recursive
    }
  }

  return query;
}
```

### 3.2 Redis

Redis is key-value store, so injection is less common, but still possible:

#### ✅ SAFE Redis Usage

```typescript
// Always validate keys
function validateRedisKey(key: string): string {
  // Only allow alphanumeric, dash, underscore, colon
  if (!/^[a-zA-Z0-9:_-]+$/.test(key)) {
    throw new Error('Invalid Redis key');
  }
  return key;
}

// Usage
const key = validateRedisKey(req.params.key);
const value = await redis.get(key);
```

---

## 4. Input Validation and Sanitization

### 4.1 Validation Before Database Queries

Always validate input **before** it reaches the database layer:

```typescript
import { isUUID, isAlphanumeric, isEmail } from 'validator';

function validateCIId(ciId: string): string {
  if (!isUUID(ciId, 4)) {
    throw new ValidationError('Invalid CI ID format');
  }
  return ciId;
}

function validateCIType(ciType: string): string {
  const ALLOWED_CI_TYPES = ['server', 'application', 'database', 'network-device'];
  if (!ALLOWED_CI_TYPES.includes(ciType)) {
    throw new ValidationError('Invalid CI type');
  }
  return ciType;
}

function validateSearchTerm(term: string): string {
  // Remove special characters that could be used for injection
  const sanitized = term.replace(/[^\w\s-]/g, '');

  // Limit length
  if (sanitized.length > 100) {
    throw new ValidationError('Search term too long');
  }

  return sanitized;
}
```

### 4.2 Type Enforcement

```typescript
// Use TypeScript types to enforce input structure
interface CreateCIRequest {
  ci_name: string;
  ci_type: 'server' | 'application' | 'database' | 'network-device';
  environment: 'production' | 'staging' | 'development';
  metadata?: Record<string, any>;
}

function createCI(request: CreateCIRequest) {
  // TypeScript ensures request matches expected structure
  // Still validate at runtime for untrusted input
}
```

### 4.3 Sanitization Libraries

Use battle-tested sanitization libraries:

```typescript
import validator from 'validator';
import { escape } from 'html-escaper';

// Escape HTML entities
const sanitizedName = escape(req.body.ci_name);

// Sanitize string
const sanitizedEmail = validator.normalizeEmail(req.body.email);

// Trim and limit length
const sanitizedDescription = validator.trim(req.body.description).substring(0, 500);
```

---

## 5. Testing for Injection Vulnerabilities

### 5.1 Manual Testing

Test with common injection payloads:

**SQL Injection Payloads**:
```
' OR '1'='1
' OR 1=1--
'; DROP TABLE users--
' UNION SELECT NULL--
admin'--
```

**NoSQL Injection Payloads** (MongoDB):
```
{"$ne": null}
{"$gt": ""}
{"$regex": ".*"}
```

**Cypher Injection Payloads** (Neo4j):
```
' OR 1=1 //
'} MATCH (n) RETURN n//
'} CREATE (n:Hacker)//
```

### 5.2 Automated Testing

Use SAST tools to detect injection vulnerabilities:

```bash
# Run Semgrep with SQL injection rules
semgrep --config "p/sql-injection" src/

# Run ESLint with security plugin
eslint --ext .ts src/ --config .eslintrc-security.json
```

### 5.3 Unit Tests

Write unit tests for injection scenarios:

```typescript
describe('SQL Injection Prevention', () => {
  it('should reject SQL injection in user input', async () => {
    const maliciousInput = "' OR '1'='1";

    await expect(
      getCIById(maliciousInput)
    ).rejects.toThrow('Invalid CI ID format');
  });

  it('should use parameterized queries', async () => {
    const spy = jest.spyOn(client, 'query');

    await getCIById('123e4567-e89b-12d3-a456-426614174000');

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('$1'),
      expect.arrayContaining(['123e4567-e89b-12d3-a456-426614174000'])
    );
  });
});
```

---

## 6. Database User Permissions

### 6.1 Principle of Least Privilege

**NEVER give the application database user full permissions**.

#### PostgreSQL Permissions

```sql
-- Create application user with limited permissions
CREATE USER cmdb_app WITH PASSWORD 'secure_password';

-- Grant only necessary permissions
GRANT CONNECT ON DATABASE cmdb TO cmdb_app;
GRANT USAGE ON SCHEMA public TO cmdb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cmdb_app;

-- DENY dangerous permissions
REVOKE CREATE ON SCHEMA public FROM cmdb_app;
REVOKE DROP ON ALL TABLES IN SCHEMA public FROM cmdb_app;
REVOKE ALTER ON ALL TABLES IN SCHEMA public FROM cmdb_app;
```

#### Neo4j Permissions

```cypher
// Create application user with limited permissions
CREATE USER cmdb_app SET PASSWORD 'secure_password';

// Grant read/write access to specific database
GRANT ACCESS ON DATABASE cmdb TO cmdb_app;
GRANT MATCH {*} ON GRAPH cmdb NODES * TO cmdb_app;
GRANT CREATE ON GRAPH cmdb NODES * TO cmdb_app;
GRANT SET PROPERTY {*} ON GRAPH cmdb NODES * TO cmdb_app;

// DENY admin permissions
DENY ALTER DATABASE ON DBMS TO cmdb_app;
DENY DROP DATABASE ON DBMS TO cmdb_app;
```

### 6.2 Separate Read-Only User

Create a separate read-only user for reporting queries:

```sql
-- PostgreSQL read-only user
CREATE USER cmdb_readonly WITH PASSWORD 'secure_password';
GRANT CONNECT ON DATABASE cmdb TO cmdb_readonly;
GRANT USAGE ON SCHEMA public TO cmdb_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO cmdb_readonly;
```

---

## 7. Injection Prevention Checklist

Use this checklist for code reviews:

- [ ] **All database queries use parameterized queries** (no string concatenation)
- [ ] **User input is validated before database queries** (type, format, whitelist)
- [ ] **Dynamic query building uses parameter binding** (not string interpolation)
- [ ] **Column/table names are whitelisted** (if dynamically constructed)
- [ ] **Database user has least-privilege permissions** (no DROP/ALTER)
- [ ] **Input sanitization is performed** (remove special characters)
- [ ] **Type enforcement is used** (TypeScript types, runtime validation)
- [ ] **Unit tests cover injection scenarios** (malicious input rejected)
- [ ] **SAST scans are run regularly** (automated vulnerability detection)
- [ ] **Code review includes security review** (peer verification)

---

## 8. Injection Prevention Validation Script

Run this script to validate injection prevention:

```bash
#!/bin/bash

# Check for SQL injection vulnerabilities
echo "Checking for SQL injection vulnerabilities..."
grep -rn "query.*+\|\.query(\`" packages/ --include="*.ts" && echo "⚠️  Potential SQL injection found" || echo "✓ No SQL injection patterns detected"

# Check for Cypher injection vulnerabilities
echo "Checking for Cypher injection vulnerabilities..."
grep -rn "session\.run(\`\${" packages/ --include="*.ts" && echo "⚠️  Potential Cypher injection found" || echo "✓ No Cypher injection patterns detected"

# Check for parameterized queries
echo "Checking for parameterized queries..."
grep -rn "\.query(.*\$[0-9]" packages/ --include="*.ts" | wc -l
echo "✓ Parameterized queries found"

# Run Semgrep
if command -v semgrep &> /dev/null; then
  echo "Running Semgrep SQL injection checks..."
  semgrep --config "p/sql-injection" packages/
else
  echo "⚠️  Semgrep not installed. Install with: pip install semgrep"
fi
```

---

## 9. References

- OWASP SQL Injection: https://owasp.org/www-community/attacks/SQL_Injection
- OWASP NoSQL Injection: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/05.6-Testing_for_NoSQL_Injection
- PostgreSQL Security: https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-PARAMETERS
- Neo4j Security: https://neo4j.com/docs/cypher-manual/current/syntax/parameters/
- Node.js Security Best Practices: https://nodejs.org/en/docs/guides/security/

---

**Last Updated**: 2025-10-19
**Next Review**: 2026-01-19 (Quarterly)
