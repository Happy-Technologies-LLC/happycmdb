// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Inventory gate 4 (HP1-S6, design v16 §10.4 gate 4 / E-7): exactly the
 * reviewed sites may write each user-security property. Each rule pins the
 * number of matching writes per reviewed file, so a new writer fails the
 * build even inside a file that already holds a reviewed one, until it is
 * reviewed and the count updated here.
 *
 * Scanned: every packages/<name>/src tree (TypeScript, committed JavaScript,
 * Cypher, SQL; tests excluded), which includes the PostgreSQL and Neo4j
 * migrations, and infrastructure/scripts. Also (HAP-1642): packages/<name>/
 * scripts, scripts and deploy, and .mjs, .cjs and shell files. Backticks
 * around one identifier are stripped once before every rule, so
 * `` u.`scopes` `` counts as u.scopes.
 *
 * Known limits (documented, not gated; the control is review of HAP-1632's
 * reviewed grant path, the only intended scopes writer): map writes to a node
 * matched without the :User label (MATCH (n) WHERE elementId(n) = $e SET n
 * += $p); dynamic labels (n:$($label)); Cypher composed across statements or
 * files (SET ${clauses} passes: each clause literal is counted by the property
 * rules); apoc.cypher.run (read-only) and Cypher strings built at runtime;
 * comments between tokens; a `;` or parenthesis inside a string value of a
 * :User statement; a label written `: User` (space) or `:(User)`.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';

const ROOT = join(__dirname, '../../../../..');

/** Property-write patterns, each with the reviewed files and their exact number of matching writes. */
const RULES: Array<{ name: string; pattern: RegExp; reviewed: Record<string, number> }> = [
  {
    name: 'platformAdmin (set only by the reviewed operator grant)',
    pattern: /\.\s*_?platformAdmin\s*=(?!=)|REMOVE\s+\w+\._?platformAdmin\b/g,
    reviewed: { 'packages/api-server/src/scripts/identity-window.ts': 1 },
  },
  {
    name: 'seedProvenance (seed writers and the window stamp; never cleared)',
    pattern: /\.\s*_?seedProvenance\s*=(?!=)|REMOVE\s+\w+\._?seedProvenance\b/g,
    reviewed: {
      'infrastructure/scripts/init-neo4j.cypher': 1,
      'infrastructure/scripts/seed-data.ts': 1,
      'packages/api-server/src/scripts/identity-window.ts': 1,
    },
  },
  {
    name: 'defaultPasswordSuspect = true (marker setters)',
    pattern: /\.\s*defaultPasswordSuspect\s*=\s*true\b/g,
    reviewed: {
      'infrastructure/scripts/init-neo4j.cypher': 1,
      'infrastructure/scripts/seed-data.ts': 1,
      'packages/api-server/src/auth/neo4j-auth.repository.ts': 1,
      'packages/api-server/src/scripts/identity-window.ts': 1,
    },
  },
  {
    name: 'defaultPasswordSuspect cleared (the operator rotation only)',
    pattern: /\.\s*defaultPasswordSuspect\s*=\s*(?!true\b)[^=\s]|REMOVE\s+\w+\.defaultPasswordSuspect\b/g,
    reviewed: { 'packages/api-server/src/scripts/rotate-user-password.ts': 1 },
  },
  {
    name: '_defaultPasswordSuspect (no writer; REMOVE by the rotation only)',
    pattern: /\.\s*_defaultPasswordSuspect\s*=(?!=)|REMOVE\s+\w+\._defaultPasswordSuspect\b/g,
    reviewed: { 'packages/api-server/src/scripts/rotate-user-password.ts': 1 },
  },
  {
    name: 'credentialEpoch (the operator rotation and the guarded self-service password change)',
    pattern: /\.\s*_?credentialEpoch\s*=(?!=)|REMOVE\s+\w+\._?credentialEpoch\b/g,
    reviewed: {
      'packages/api-server/src/auth/neo4j-auth.repository.ts': 1, // GUARDED_PASSWORD_CYPHER (HAP-1285)
      'packages/api-server/src/scripts/rotate-user-password.ts': 1,
    },
  },
  {
    name: 'password hash (rotation, guarded self-service change, seed writers)',
    pattern: /\.\s*_?passwordHash\s*=(?!=)/g,
    reviewed: {
      'infrastructure/scripts/init-neo4j.cypher': 1,
      'infrastructure/scripts/seed-data.ts': 1,
      'packages/api-server/src/auth/neo4j-auth.repository.ts': 2, // GUARDED_PASSWORD_CYPHER: both spellings
      'packages/api-server/src/scripts/rotate-user-password.ts': 2, // APPLY_CYPHER: both spellings
      'packages/api-server/src/scripts/seed-tenant-fixture.ts': 1,
    },
  },
  {
    name: 'api_keys.credential_epoch updates (none; set once at INSERT)',
    pattern: /UPDATE\s+api_keys\s+SET[^;`]*credential_epoch\s*=/gi,
    reviewed: {},
  },
  {
    name: ':CredentialRotationDecision (created by the rotation; constraint in init-neo4j and neo4j migration 002; named in the 020 audit comment)',
    pattern: /CredentialRotationDecision/g,
    reviewed: {
      'infrastructure/scripts/init-neo4j.cypher': 1,
      'packages/api-server/src/scripts/rotate-user-password.ts': 7,
      'packages/database/src/neo4j/migrations/002_credential_rotation_decision.cypher': 3,
      'packages/database/src/postgres/migrations/020_auth_credential_events.sql': 1,
    },
  },
  {
    name: 'bulk API-key revocation by user (the operator rotation only)',
    pattern: /UPDATE\s+api_keys\s+SET\s+enabled\s*=\s*false/gi,
    reviewed: { 'packages/api-server/src/scripts/rotate-user-password.ts': 1 },
  },
  {
    name: 'auth_credential_events INSERT (login marker, window scan, rotation)',
    pattern: /INSERT\s+INTO\s+auth_credential_events/gi,
    reviewed: {
      'packages/api-server/src/auth/neo4j-auth.repository.ts': 1,
      'packages/api-server/src/scripts/identity-window.ts': 1,
      'packages/api-server/src/scripts/rotate-user-password.ts': 3,
    },
  },
  {
    name: 'organizationId (seed writers and the FD-5 operator assignment only)',
    pattern: /\.\s*_?organizationId\s*=(?!=)|REMOVE\s+\w+\._?organizationId\b/g,
    reviewed: {
      'infrastructure/scripts/init-neo4j.cypher': 1,
      'infrastructure/scripts/seed-data.ts': 1,
      'packages/api-server/src/scripts/identity-window.ts': 1,
      'packages/api-server/src/scripts/seed-tenant-fixture.ts': 1,
    },
  },
  {
    name: 'scopes (no writer; the HAP-1632 operator grant only)',
    pattern: /\.\s*_?scopes\s*=(?!=)|REMOVE\s+\w+\._?scopes\b/g,
    reviewed: {
      // Reviewed (HAP-1615): `auth.scopes = raw.scopes` maps a connector descriptor's OAuth scopes; not a :User write.
      'packages/integration-framework/src/descriptor-mapper.ts': 1,
    },
  },
];

/** Rules that forbid an operation everywhere, whatever the file. */
const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: 'mutating a rotation decision', pattern: /(MERGE|DELETE|SET|REMOVE)[^\n;`]*\(?\s*\w*:CredentialRotationDecision|MATCH\s*\(\s*(\w+):CredentialRotationDecision[^`;]*\b(SET|REMOVE|DELETE)\s+\1\b/g },
  { name: 'an APOC procedure that can write a node', pattern: /apoc\.(?:create|merge|refactor|periodic)\.\w+|apoc\.cypher\.(?:doIt|runWrite|runMany|runFile)/gi },
];

/**
 * Rules for each statement (text between two `;`, after backtick normalisation) naming the :User label, whatever the
 * variable, keyword case or clause order: map writes and runtime-built property names bypass the per-property rules.
 */
const USER_STATEMENT: Array<{ name: string; pattern: RegExp }> = [
  { name: 'a map write (SET x = / SET x += / , x +=) in a :User statement', pattern: /(?:\bSET\s+|,\s*)(?:\w+|\\?`[^`\n]*`)\s*\+?=(?!=)/i },
  { name: 'a :User node built from a parameter map', pattern: /:User\b(?::\w+)*\s*\$/ },
  { name: 'a runtime-built property name in a :User statement', pattern: /\w\.\$\{|\b\w+\s*\[[^\][\n]*\]\s*\+?=(?!=)|\w\.['"]\s*\+|\w\.\\?`/ },
];

const SECURITY_KEY = /(?:^|[{,\s])_?(?:passwordHash|platformAdmin|seedProvenance|defaultPasswordSuspect|credentialEpoch|scopes)\s*:/;

/** Whether a :User node outside MATCH (CREATE, MERGE or a clause-less fragment) has a security key; linear: each node is read once to its closing parenthesis. */
function createsUserWithSecurityKey(text: string): boolean {
  for (const statement of text.split(';')) {
    const tokens = /\b(?:MATCH|CREATE|MERGE)\b|:User\b/gi;
    let clause = '';
    for (let token = tokens.exec(statement); token; token = tokens.exec(statement)) {
      if (!token[0].startsWith(':')) clause = token[0].toUpperCase();
      else if (token[0] === ':User' && clause !== 'MATCH') {
        let end = token.index;
        for (let depth = 1; end < statement.length && depth > 0; end++) depth += statement[end] === '(' ? 1 : statement[end] === ')' ? -1 : 0;
        if (SECURITY_KEY.test(statement.slice(token.index, end))) return true;
        tokens.lastIndex = end;
      }
    }
  }
  return false;
}

const SCANNED_EXTENSIONS = /\.(ts|js|cypher|sql|sh|mjs|cjs)$/;
const LEGACY_EXTENSIONS = /\.(ts|js|cypher|sql)$/;
const SKIPPED = /(^|\/)(node_modules|dist|__tests__|coverage)(\/|$)|\.(test|spec)\.ts$/;

function walk(root: string, dir: string, out: string[], extensions: RegExp): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const rel = relative(root, path);
    if (SKIPPED.test(rel)) continue;
    if (statSync(path).isDirectory()) walk(root, path, out, extensions);
    else if (extensions.test(entry)) out.push(rel);
  }
}

/** The scanned files under `root`; `legacy` is the walk before HAP-1642, kept for the L5 fail-first row. */
function scannedFiles(root = ROOT, legacy = false): string[] {
  const files: string[] = [];
  const trees = legacy ? ['infrastructure/scripts'] : ['infrastructure/scripts', 'scripts', 'deploy'];
  for (const pkg of readdirSync(join(root, 'packages'))) {
    if (statSync(join(root, 'packages', pkg)).isDirectory()) trees.push(`packages/${pkg}/src`, ...(legacy ? [] : [`packages/${pkg}/scripts`]));
  }
  for (const tree of trees) if (safeIsDir(join(root, tree))) walk(root, join(root, tree), files, legacy ? LEGACY_EXTENSIONS : SCANNED_EXTENSIONS);
  return [...new Set(files)].sort();
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function count(pattern: RegExp, text: string): number {
  pattern.lastIndex = 0;
  return text.match(pattern)?.length ?? 0;
}

/** Writes that differ from the reviewed per-file counts, as `file: rule (found n, reviewed m)` strings. */
function violations(sources: Map<string, string>): string[] {
  const found: string[] = [];
  // Backtick normalisation, once, before every rule below (HAP-1642 L4).
  sources = new Map([...sources].map(([file, raw]) => [file, raw.replace(/\\?`(\w+)\\?`/g, '$1')]));
  for (const [file, text] of sources) {
    for (const rule of RULES) {
      const actual = count(rule.pattern, text);
      const reviewed = rule.reviewed[file] ?? 0;
      if (actual !== reviewed) found.push(`${file}: ${rule.name} (found ${actual}, reviewed ${reviewed})`);
    }
    for (const rule of FORBIDDEN) {
      if (count(rule.pattern, text) > 0) found.push(`${file}: forbidden ${rule.name}`);
    }
    const statements = text.split(';').filter(statement => statement.includes(':User'));
    for (const rule of USER_STATEMENT) {
      if (statements.some(statement => rule.pattern.test(statement))) found.push(`${file}: forbidden ${rule.name}`);
    }
    if (createsUserWithSecurityKey(text)) found.push(`${file}: forbidden a :User node created or merged with a security property`);
  }
  return found.sort();
}

describe('inventory gate 4: user-security property writers', () => {
  const files = scannedFiles();
  const sources = new Map(files.map(file => [file, readFileSync(join(ROOT, file), 'utf8')]));

  it('only the reviewed sites write platformAdmin, seedProvenance, the marker, the generation, hashes, decisions and the audit', () => {
    expect(violations(sources)).toEqual([]);
  });

  const REPOSITORY = 'packages/api-server/src/auth/neo4j-auth.repository.ts';
  const ROTATION = 'packages/api-server/src/scripts/rotate-user-password.ts';
  const IDENTITY_WINDOW = 'packages/api-server/src/scripts/identity-window.ts';
  // Negative cases inside already-reviewed files: the real source plus one plausible regression.
  it.each([
    ['the former unguarded updateUser password setter, restored in the repository', REPOSITORY,
      "setClauses.push('u._passwordHash = $passwordHash');"],
    ['a second marker setter in the repository', REPOSITORY,
      "const AGAIN = 'MATCH (u:User) WHERE u._id = $id SET u.defaultPasswordSuspect = true';"],
    ['an underscore-spelling marker setter in the repository', REPOSITORY,
      "const U = 'MATCH (u:User) WHERE elementId(u) = $e SET u._defaultPasswordSuspect = true';"],
    ['a generation writer in the repository', REPOSITORY, "const E = 'SET u.credentialEpoch = $epoch';"],
    ['an API-key generation update in the repository', REPOSITORY,
      "const K = 'UPDATE api_keys SET credential_epoch = $1 WHERE id = $2';"],
    ['a map write to the user in the repository', REPOSITORY,
      "const PATCH = 'MATCH (u:User) WHERE elementId(u) = $e SET u += $props';"],
    ['a map replace of the user in the repository', REPOSITORY,
      "const PUT = 'MATCH (u:User {_id: $id}) SET u = $props';"],
    ['deleting rotation decisions in the rotation', ROTATION,
      "const PURGE = 'MATCH (d:CredentialRotationDecision) DETACH DELETE d';"],
    ['a second organization writer in the identity window', IDENTITY_WINDOW,
      "const AGAIN = 'MATCH (u:User) WHERE elementId(u) = $e SET u.organizationId = $org';"],
    ['an organization removal in the repository', REPOSITORY, "const R = 'MATCH (u:User) WHERE u._id = $id REMOVE u._organizationId';"],
    ['a scopes writer in the repository (HAP-1615)', REPOSITORY,
      "const GRANT = 'MATCH (u:User) WHERE u._id = $id SET u.scopes = $s';"],
  ])('fails on %s', (_label, file, addition) => {
    expect(violations(new Map([[file, sources.get(file)!]]))).toEqual([]);
    expect(violations(new Map([[file, `${sources.get(file)}\n${addition}\n`]]))).not.toEqual([]);
  });

  // Negative cases in files that hold no reviewed writer.
  // HAP-1642: the L1-L4 rows below passed the gate before HAP-1642.
  const USERS = 'packages/api-server/src/rest/users.controller.ts';
  it.each([
    ['a marker clearer in the auth service', 'packages/api-server/src/auth/auth.service.ts',
      "await session.run('MATCH (u:User) WHERE u._id = $id SET u.defaultPasswordSuspect = false')"],
    ['a platform-admin writer in a route', 'packages/api-server/src/rest/admin.controller.ts',
      "'MATCH (u:User {id: $id}) SET u.platformAdmin = true'"],
    ['a user created with a hash outside the seed writers', 'packages/api-server/src/rest/users.controller.ts',
      "'CREATE (u:User {_id: $id, _passwordHash: $hash})'"],
    ['a new migration clearing the marker', 'packages/database/src/postgres/migrations/099_x.sql',
      "UPDATE x SET n.defaultPasswordSuspect = false;"],
    ['L1 a map write through another variable', USERS, "'MATCH (u:User {_id: $id}) FOREACH (x IN [u] | SET x += $props)'"],
    ['L1 a map write after a property item', USERS, "'MATCH (u:User) WHERE u._id = $id SET u.name = $n, u += $props'"],
    ['L1 a lowercase map write', USERS, "'match (u:User) where u._id = $id set u += $props'"],
    ['L1 a map write after a nested template', USERS, "`MATCH (u:User) WHERE u._id = $id ${on ? `AND u._enabled = true` : ''} SET u += $props`"],
    ['L2 a map write after MERGE', USERS, "'MERGE (u:User {_id: $id}) SET u += $props'"],
    ['L2 a user created from a parameter map', USERS, "'CREATE (u:User $props)'"],
    ['L3 a forbidden key after datetime()', USERS, "'CREATE (u:User {_id: $id, _createdAt: datetime(), scopes: $s})'"],
    ['L4 an APOC property setter', USERS, "'MATCH (u:User) CALL apoc.create.setProperty(u, $k, $v) YIELD node RETURN node'"],
    ['L4 a backtick-quoted property', USERS, "'MATCH (u:User) WHERE u._id = $id SET u.`scopes` = $s'"],
    ['L4 a backtick-quoted key in a created user', USERS, "'CREATE (u:User {_id: $id, `scopes`: $s})'"],
    ['L4 a dynamic Cypher key', USERS, "'MATCH (u:User) WHERE u._id = $id SET u[$key] = $v'"],
    ['L4 an interpolated key', USERS, "`MATCH (u:User) WHERE u._id = $id SET u.${key} = $v`"],
    ['L4 a concatenated key', USERS, "'MATCH (u:User) WHERE u._id = $id SET u.' + key + ' = $v'"],
  ])('fails on %s', (_label, file, line) => {
    expect(violations(new Map([[file, line]]))).not.toEqual([]);
  });

  // The shapes of real writers (file:line on main at HAP-1642) stay clean outside the reviewed files.
  it.each([
    ['a CI map write (journal.ts:98)',
      "`MATCH (ci:CI {id: $id}) WHERE ci.organization_id = $org SET ci += $props, ci.updated_at = datetime() WITH ci`"],
    ['a CI lookup by an interpolated key (identity-reconciliation-engine.ts:258)',
      "`MATCH (ci:CI) WHERE ci.organization_id = $organizationId AND ci.${attributeName} = $value`"],
    ['the profile update through a FOREACH variable (neo4j-auth.repository.ts:219-221)',
      "setClauses.push('x._name = $name'); run(`MATCH (u:User) WHERE u._id = $id WITH collect(DISTINCT u) AS matched " +
      "FOREACH (x IN CASE WHEN size(matched) = 1 THEN matched ELSE [] END | SET ${setClauses.join(', ')}) RETURN matched[0] AS u`);"],
    ['a seed MERGE with property items (seed-data.ts:149)',
      "`MERGE (u:User {_username: $username}) SET u._id = $id, u._email = $email, u._createdAt = datetime()`"],
    ['a fixture user created after datetime() (seed-tenant-fixture.ts:404)',
      "'CREATE (u:User {_id: $id, _createdAt: datetime(), _tenantFixture: true})'"],
    ['a non-user map write', "'CREATE (bs:BusinessService) SET bs = $props'"],
    ['read-only APOC calls (restore-neo4j.sh:256, graph-traversal.ts:180)',
      "\"CALL apoc.cypher.run('MATCH (n) RETURN count(n) AS c', {}) YIELD value RETURN apoc.convert.fromJsonMap(value.c)\""],
  ])('stays clean on %s', (_label, line) => {
    expect(violations(new Map([[USERS, line]]))).toEqual([]);
  });

  describe('L5: the widened walk', () => {
    const planted = ['infrastructure/scripts/grant.sh', 'packages/demo/scripts/grant.mjs', 'packages/demo/src/grant.cjs'];
    let root = '';
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'hap1642-'));
      for (const file of planted) {
        mkdirSync(join(root, dirname(file)), { recursive: true });
        writeFileSync(join(root, file), 'SET u.scopes = $s\n');
      }
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('scans .sh, .mjs and .cjs files and packages/*/scripts, which the old walk missed', () => {
      expect(scannedFiles(root, true)).toEqual([]);
      const files = scannedFiles(root);
      expect(files).toEqual(planted);
      const found = violations(new Map(files.map(file => [file, readFileSync(join(root, file), 'utf8')])));
      expect(found.map(line => line.split(':')[0])).toEqual(planted);
    });
  });
});
