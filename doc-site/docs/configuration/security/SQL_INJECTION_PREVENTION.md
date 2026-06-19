# SQL and Cypher Injection Prevention

**Document Status**: ✅ **CRITICAL SECURITY REQUIREMENTS**
**Last Updated**: October 2025
**Applies To**: All HappyCMDB v2.0+ deployments

## Overview

This document outlines **mandatory security practices** for preventing SQL and Cypher injection vulnerabilities in HappyCMDB. All developers must follow these guidelines when writing database queries.

**Security Rating Impact**: Proper implementation of these practices is **CRITICAL** for achieving API Security scores above 60%.

---

## Table of Contents

1. [Security Principles](#security-principles)
2. [SQL Injection Prevention](#sql-injection-prevention)
3. [Cypher Injection Prevention](#cypher-injection-prevention)
4. [Validation Utilities](#validation-utilities)
5. [Code Examples](#code-examples)
6. [Testing](#testing)
7. [Common Vulnerabilities](#common-vulnerabilities)

---

## Security Principles

### The Golden Rules

1. **ALWAYS use parameterized queries** for user input (values, filters, search terms)
2. **ALWAYS validate identifiers** (table names, column names, labels) against whitelists
3. **NEVER concatenate user input** into SQL/Cypher query strings
4. **NEVER trust user input** - validate everything

### What to Parameterize vs. What to Validate

| Category | Approach | Example |
|----------|----------|---------|
| **User Data** (IDs, names, filters) | ✅ Parameterized queries | `WHERE id = $1` |
| **Table/Column Names** | ✅ Whitelist validation | `validateTableName('dim_ci')` |
| **Sort Directions** | ✅ Whitelist validation | `validateSortDirection('asc')` |
| **Labels/Types** | ✅ Whitelist validation | `sanitizeCITypeForLabel('server')` |
| **Relationship Types** | ✅ Whitelist validation | `validateRelationshipType('DEPENDS_ON')` |

---

## SQL Injection Prevention

### PostgreSQL Parameterized Queries

#### ✅ SECURE: Using Parameterized Queries

```typescript
import { getPostgresClient } from '@cmdb/database';

// CORRECT: User input is parameterized
const result = await client.query(
  'SELECT * FROM credentials WHERE id = $1 AND name = $2',
  [userId, userName]
);
```

#### ❌ VULNERABLE: String Concatenation

```typescript
// WRONG: SQL injection vulnerability!
const result = await client.query(
  `SELECT * FROM credentials WHERE id = '${userId}' AND name = '${userName}'`
);
// Attacker can use: userId = "1' OR '1'='1"
```

### Dynamic Table Names (Whitelist Validation)

Since PostgreSQL doesn't support parameterized table names, use **whitelist validation**:

#### ✅ SECURE: Validated Table Names

```typescript
import { validateTableName, validateTableNames } from '@cmdb/common';

// Single table
const tableName = validateTableName(userInput); // Throws if not in whitelist
await client.query(`TRUNCATE TABLE ${tableName} CASCADE`);

// Multiple tables
const tables = ['dim_ci', 'fact_ci_relationships', 'dim_date'];
const validatedTables = validateTableNames(tables);

for (const table of validatedTables) {
  await client.query(`REINDEX TABLE ${table}`);
}
```

#### ❌ VULNERABLE: Unvalidated Table Names

```typescript
// WRONG: Allows table name injection!
await client.query(`TRUNCATE TABLE ${userInput} CASCADE`);
// Attacker can use: userInput = "dim_ci; DROP TABLE credentials; --"
```

### ORDER BY Clause (Whitelist Validation)

Column names in `ORDER BY` clauses cannot be parameterized:

#### ✅ SECURE: Validated Sort Fields

```typescript
import { validateCISortField, validateSortDirection } from '@cmdb/common';

// Validate against whitelist
const sortField = validateCISortField(req.query.sort_by || 'name');
const sortDirection = validateSortDirection(req.query.sort_order || 'asc');

// Safe to use in query
const query = `SELECT * FROM ci ORDER BY ${sortField} ${sortDirection}`;
```

#### ❌ VULNERABLE: Unvalidated Sort Fields

```typescript
// WRONG: Allows ORDER BY injection!
const query = `SELECT * FROM ci ORDER BY ${req.query.sort_by} ${req.query.sort_order}`;
// Attacker can use: sort_by = "name; DROP TABLE credentials; --"
```

### Available SQL Validators

```typescript
import {
  validateTableName,           // For table names
  validateTableNames,          // For multiple tables
  validateCISortField,         // For CI query sorting
  validateConnectorSortField,  // For connector query sorting
  validateConnectorConfigSortField, // For connector config sorting
  validateConnectorRunSortField,    // For run history sorting
  validateSortDirection,       // For ASC/DESC validation
  containsSQLInjectionPatterns // Defense-in-depth check
} from '@cmdb/common';
```

---

## Cypher Injection Prevention

### Neo4j Parameterized Queries

#### ✅ SECURE: Using Parameterized Queries

```typescript
import { getNeo4jClient } from '@cmdb/database';

const session = neo4jClient.getSession();

// CORRECT: All user input is parameterized
const result = await session.run(
  'MATCH (ci:CI {id: $id}) WHERE ci.name = $name RETURN ci',
  { id: ciId, name: ciName }
);
```

#### ❌ VULNERABLE: String Interpolation

```typescript
// WRONG: Cypher injection vulnerability!
const result = await session.run(
  `MATCH (ci:CI {id: '${ciId}'}) WHERE ci.name = '${ciName}' RETURN ci`
);
// Attacker can use: ciId = "abc'}) DETACH DELETE (ci) MATCH (x {id: 'def"
```

### Dynamic Labels (Whitelist Validation)

Neo4j doesn't support parameterized labels in CREATE/MATCH statements:

#### ✅ SECURE: Validated Labels

```typescript
import { sanitizeCITypeForLabel, buildSafeCypherLabel } from '@cmdb/common';

// Validate and sanitize CI type
const sanitizedType = sanitizeCITypeForLabel(ciType); // 'virtual-machine' → 'virtual_machine'

// Build safe label string
const label = buildSafeCypherLabel(ciType); // ':CI:virtual_machine'

// Safe to use in CREATE
await session.run(
  `CREATE (ci${label} {
    id: $id,
    name: $name,
    type: $type
  }) RETURN ci`,
  { id, name, type: ciType }
);
```

#### ❌ VULNERABLE: Unvalidated Labels

```typescript
// WRONG: Allows label injection!
await session.run(
  `CREATE (ci:CI:${ciType} { id: $id, name: $name }) RETURN ci`,
  { id, name }
);
// Attacker can use: ciType = "server)--() DETACH DELETE (ci) MATCH (x:"
```

### Dynamic Relationship Types (Whitelist Validation)

#### ✅ SECURE: Validated Relationship Types

```typescript
import { validateRelationshipType } from '@cmdb/common';

// Validate relationship type
const validatedType = validateRelationshipType(relType); // 'depends-on' → 'DEPENDS_ON'

// Safe to use in MERGE
await session.run(
  `MATCH (from:CI {id: $fromId})
   MATCH (to:CI {id: $toId})
   MERGE (from)-[r:${validatedType}]->(to)
   SET r.created_at = datetime()`,
  { fromId, toId }
);
```

#### ❌ VULNERABLE: Unvalidated Relationship Types

```typescript
// WRONG: Allows relationship type injection!
await session.run(
  `MATCH (from:CI {id: $fromId})
   MATCH (to:CI {id: $toId})
   MERGE (from)-[r:${relType}]->(to)`,
  { fromId, toId }
);
// Attacker can use: relType = "DEPENDS_ON]->(x) DETACH DELETE (x) MATCH ()-[r:"
```

### Available Cypher Validators

```typescript
import {
  validateNodeLabel,           // For Neo4j node labels
  validateRelationshipType,    // For relationship types
  validateCIProperty,          // For property names
  sanitizeCITypeForLabel,      // Converts kebab-case → snake_case + validates
  buildSafeCypherLabel,        // Builds ':CI:type' label string
  containsCypherInjectionPatterns // Defense-in-depth check
} from '@cmdb/common';
```

---

## Validation Utilities

### Whitelist Approach

All validators use **strict whitelist validation**:

1. **Predefined list** of allowed values (table names, column names, labels, etc.)
2. **Reject anything** not in the whitelist
3. **Throw errors** on invalid input (fail closed, not open)

### Example: Adding New CI Types

To add a new CI type to the whitelist:

**File**: `/packages/common/src/security/cypher-validators.ts`

```typescript
export const VALID_NODE_LABELS = [
  'CI',
  'server',
  'virtual_machine',
  'container',
  // Add new type here:
  'my_new_ci_type',
] as const;
```

### Example: Adding New Sort Fields

**File**: `/packages/common/src/security/sql-validators.ts`

```typescript
export const VALID_CI_SORT_FIELDS = [
  'id',
  'name',
  'type',
  // Add new sort field here:
  'my_new_field',
] as const;
```

---

## Code Examples

### Secure CI Query with Pagination

```typescript
import { validateCISortField, validateSortDirection } from '@cmdb/common';
import { getNeo4jClient } from '@cmdb/database';

async function getCIs(filters: any) {
  const session = getNeo4jClient().getSession();

  try {
    // Build base query with parameterized filters
    let query = 'MATCH (ci:CI) WHERE 1=1';
    const params: any = {};

    if (filters.type) {
      query += ' AND ci.type = $type';
      params.type = filters.type;
    }

    if (filters.search) {
      query += ' AND toLower(ci.name) CONTAINS toLower($search)';
      params.search = filters.search;
    }

    // Validate sort parameters (cannot be parameterized)
    const sortField = validateCISortField(filters.sort_by || 'name');
    const sortDirection = validateSortDirection(filters.sort_order || 'asc');

    // Add validated sorting
    query += ` RETURN ci ORDER BY ci.${sortField} ${sortDirection} SKIP $offset LIMIT $limit`;
    params.offset = filters.offset || 0;
    params.limit = filters.limit || 100;

    return await session.run(query, params);
  } finally {
    await session.close();
  }
}
```

### Secure Table Maintenance

```typescript
import { validateTableNames } from '@cmdb/common';
import { getPostgresClient } from '@cmdb/database';

async function rebuildIndexes() {
  const client = await getPostgresClient().getClient();

  const tables = ['dim_ci', 'fact_ci_relationships', 'fact_ci_discovery'];

  // Validate all table names before use
  const validatedTables = validateTableNames(tables);

  try {
    for (const table of validatedTables) {
      // Safe to use validated table name
      await client.query(`REINDEX TABLE ${table}`);
      await client.query(`ANALYZE ${table}`);
    }
  } finally {
    client.release();
  }
}
```

---

## Testing

### Unit Tests

All security validators have comprehensive unit tests:

- **File**: `/packages/common/src/security/__tests__/sql-validators.test.ts`
- **File**: `/packages/common/src/security/__tests__/cypher-validators.test.ts`

**Test coverage includes**:
- Valid inputs (acceptance tests)
- Invalid inputs (rejection tests)
- SQL injection attack patterns
- Cypher injection attack patterns
- Edge cases and special characters

### Running Security Tests

```bash
# Run all security validator tests
cd packages/common
npm test -- security

# Run with coverage
npm test -- --coverage security
```

### Integration Tests

Add SQL injection tests to your API integration tests:

```typescript
describe('CI API - SQL Injection Prevention', () => {
  it('should reject SQL injection in sort parameter', async () => {
    const response = await request(app)
      .get('/api/v1/cis')
      .query({ sort_by: "name; DROP TABLE credentials; --" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid sort field');
  });

  it('should reject Cypher injection in CI type', async () => {
    const response = await request(app)
      .post('/api/v1/cis')
      .send({
        id: 'test-ci',
        name: 'Test CI',
        type: "server)--() DETACH DELETE (ci) MATCH (x:"
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid node label');
  });
});
```

---

## Common Vulnerabilities

### 1. ORDER BY Injection

**Vulnerability**:
```typescript
// ❌ VULNERABLE
const query = `SELECT * FROM ci ORDER BY ${req.query.sort_by}`;
```

**Attack**:
```
GET /api/v1/cis?sort_by=name; DROP TABLE credentials; --
```

**Fix**:
```typescript
// ✅ SECURE
const sortField = validateCISortField(req.query.sort_by || 'name');
const query = `SELECT * FROM ci ORDER BY ${sortField}`;
```

---

### 2. Table Name Injection

**Vulnerability**:
```typescript
// ❌ VULNERABLE
await client.query(`TRUNCATE TABLE ${tableName} CASCADE`);
```

**Attack**:
```typescript
tableName = "dim_ci; DROP TABLE credentials; --"
```

**Fix**:
```typescript
// ✅ SECURE
const validatedTable = validateTableName(tableName);
await client.query(`TRUNCATE TABLE ${validatedTable} CASCADE`);
```

---

### 3. Cypher Label Injection

**Vulnerability**:
```typescript
// ❌ VULNERABLE
await session.run(
  `CREATE (ci:CI:${ciType} { id: $id }) RETURN ci`,
  { id }
);
```

**Attack**:
```typescript
ciType = "server)--() DETACH DELETE (ci) MATCH (x:"
```

**Fix**:
```typescript
// ✅ SECURE
const sanitizedType = sanitizeCITypeForLabel(ciType);
await session.run(
  `CREATE (ci:CI:${sanitizedType} { id: $id }) RETURN ci`,
  { id }
);
```

---

### 4. Relationship Type Injection

**Vulnerability**:
```typescript
// ❌ VULNERABLE
await session.run(
  `MERGE (from)-[r:${relType}]->(to)`,
  { fromId, toId }
);
```

**Attack**:
```typescript
relType = "DEPENDS_ON]->(x) DETACH DELETE (x) MATCH ()-[r:"
```

**Fix**:
```typescript
// ✅ SECURE
const validatedType = validateRelationshipType(relType);
await session.run(
  `MERGE (from)-[r:${validatedType}]->(to)`,
  { fromId, toId }
);
```

---

## Enforcement Checklist

Before merging any code that touches database queries:

- [ ] All user values are parameterized (`$1, $2, $3` for PostgreSQL, `$param` for Neo4j)
- [ ] All table/column names use whitelist validation
- [ ] All Cypher labels use whitelist validation
- [ ] All relationship types use whitelist validation
- [ ] No string concatenation with user input
- [ ] Unit tests cover SQL/Cypher injection attempts
- [ ] Integration tests verify validation works

---

## Additional Resources

- [OWASP SQL Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html)
- [Neo4j Security Guide](https://neo4j.com/docs/operations-manual/current/security/)
- [PostgreSQL Security Best Practices](https://www.postgresql.org/docs/current/sql-injection.html)

---

## Questions or Issues?

If you encounter a situation not covered by this guide:

1. **Default to parameterized queries** whenever possible
2. **Use whitelist validation** for identifiers
3. **Ask the security team** before implementing custom escaping
4. **Add test cases** for any new validation patterns

**Remember**: One missed injection vulnerability can compromise the entire CMDB. When in doubt, validate!
