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
 * :User statement; a label written `: User` (space) or `:(User)`; MATCH-only
 * label expressions without `:User` or `&User`, such as (u:Admin|User)
 * (CREATE and MERGE accept only `:` and `&`; both are gated, HAP-1673).
 *
 * Fails closed (HAP-1673): `& User` counts as the label even in a TypeScript
 * intersection type, so `X & User` in the same `;`-delimited text as a write
 * shape (`, x =`, `scopes:`) fails the gate. Write such code by naming the
 * intersection with a module-level alias (`type AdminUser = Admin & User;`)
 * and using AdminUser everywhere else.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';

const ROOT = join(__dirname, '../../../../..');

/** A REMOVE item's variable, bare or parenthesised (HAP-1673 P6). */
const REMOVE_VARIABLE = String.raw`(?:\(\s*\w+\s*\)|\w+)`;
/** An earlier REMOVE list item: a property (plain or backticked, HAP-1673 P6) or labels, then the comma. */
const REMOVE_ITEM = String.raw`${REMOVE_VARIABLE}(?:\s*\.\s*(?:\w+|\\?\x60[^\x60\n]*\x60)|(?:\s*:\w+)+)\s*,\s*`;
/** A REMOVE of `key` at any position of the list, in any keyword case (HAP-1663). */
const removes = (key: string): string => String.raw`\bREMOVE\s+(?:${REMOVE_ITEM})*${REMOVE_VARIABLE}\s*\.\s*${key}\b`;

/** Property-write patterns, each with the reviewed files and their exact number of matching writes. */
const RULES: Array<{ name: string; pattern: RegExp; reviewed: Record<string, number> }> = [
  {
    name: 'platformAdmin (set only by the reviewed operator grant)',
    pattern: new RegExp(String.raw`\.\s*_?platformAdmin\s*=(?!=)|${removes('_?platformAdmin')}`, 'gi'),
    reviewed: { 'packages/api-server/src/scripts/identity-window.ts': 1 },
  },
  {
    name: 'seedProvenance (seed writers and the window stamp; never cleared)',
    pattern: new RegExp(String.raw`\.\s*_?seedProvenance\s*=(?!=)|${removes('_?seedProvenance')}`, 'gi'),
    reviewed: {
      'infrastructure/scripts/init-neo4j.cypher': 1,
      'infrastructure/scripts/seed-data.ts': 1,
      'packages/api-server/src/scripts/identity-window.ts': 1,
    },
  },
  {
    name: 'defaultPasswordSuspect = true (marker setters)',
    pattern: /\.\s*defaultPasswordSuspect\s*=\s*true\b/gi,
    reviewed: {
      'infrastructure/scripts/init-neo4j.cypher': 1,
      'infrastructure/scripts/seed-data.ts': 1,
      'packages/api-server/src/auth/neo4j-auth.repository.ts': 1,
      'packages/api-server/src/scripts/identity-window.ts': 1,
    },
  },
  {
    name: 'defaultPasswordSuspect cleared (the operator rotation only)',
    pattern: new RegExp(String.raw`\.\s*defaultPasswordSuspect\s*=\s*(?!true\b)[^=\s]|${removes('defaultPasswordSuspect')}`, 'gi'),
    reviewed: { 'packages/api-server/src/scripts/rotate-user-password.ts': 1 },
  },
  {
    name: '_defaultPasswordSuspect (no writer; REMOVE by the rotation only)',
    pattern: new RegExp(String.raw`\.\s*_defaultPasswordSuspect\s*=(?!=)|${removes('_defaultPasswordSuspect')}`, 'gi'),
    reviewed: { 'packages/api-server/src/scripts/rotate-user-password.ts': 1 },
  },
  {
    name: 'credentialEpoch (the operator rotation and the guarded self-service password change)',
    pattern: new RegExp(String.raw`\.\s*_?credentialEpoch\s*=(?!=)|${removes('_?credentialEpoch')}`, 'gi'),
    reviewed: {
      'packages/api-server/src/auth/neo4j-auth.repository.ts': 1, // GUARDED_PASSWORD_CYPHER (HAP-1285)
      'packages/api-server/src/scripts/rotate-user-password.ts': 1,
    },
  },
  {
    name: 'password hash (rotation, guarded self-service change, seed writers)',
    pattern: new RegExp(String.raw`\.\s*_?passwordHash\s*=(?!=)|${removes('_?passwordHash')}`, 'gi'),
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
    pattern: /(?<![^;`])(?:(?!UPDATE\s+api_keys\s+SET)[^;`])*UPDATE\s+api_keys\s+SET[^;`]*credential_epoch\s*=/gi,
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
    pattern: new RegExp(String.raw`\.\s*_?organizationId\s*=(?!=)|${removes('_?organizationId')}`, 'gi'),
    reviewed: {
      'infrastructure/scripts/init-neo4j.cypher': 1,
      'infrastructure/scripts/seed-data.ts': 1,
      'packages/api-server/src/scripts/identity-window.ts': 1,
      'packages/api-server/src/scripts/seed-tenant-fixture.ts': 1,
    },
  },
  {
    name: 'scopes (no writer; the HAP-1632 operator grant only)',
    pattern: new RegExp(String.raw`\.\s*_?scopes\s*=(?!=)|${removes('_?scopes')}`, 'gi'),
    reviewed: {
      // Reviewed (HAP-1615): `auth.scopes = raw.scopes` maps a connector descriptor's OAuth scopes; not a :User write.
      'packages/integration-framework/src/descriptor-mapper.ts': 1,
    },
  },
];

/**
 * The rotation-decision rule, linear in the input (HAP-1674; the unanchored forms were quadratic, and cubic for a long
 * word, on a hostile 50k-char line). It fires on a write keyword before the label on one line, or on a keyword line
 * followed by only whitespace and a word before the label on a later line. Starting only at a line's first keyword loses
 * nothing: a later keyword on that line sees the same label tail, and the keywords cannot overlap.
 */
const ROTATION_LABEL = ':CredentialRotationDecision';
const ROTATION_KEYWORD = String.raw`(?:MERGE|DELETE|SET|REMOVE)`;
const KEYWORD_BEFORE_ROTATION_LABEL = new RegExp(
  String.raw`(?<![^\n;\x60])(?:(?!${ROTATION_KEYWORD})[^\n;\x60])*${ROTATION_KEYWORD}[^\n;\x60]*(?:${ROTATION_LABEL}|\n\s*\w*${ROTATION_LABEL})`,
  'i',
);

/** `MATCH (v:CredentialRotationDecision` and, later in the same statement, `SET|REMOVE|DELETE v`; the variables are collected in one pass, as a backreference regex is quadratic. */
function mutatesBoundRotationDecision(text: string): boolean {
  for (const statement of text.split(/[;\x60]/)) {
    const bound = new Set<string>();
    const events = /MATCH\s*\(\s*(\w+):CredentialRotationDecision|\b(?:SET|REMOVE|DELETE)(?=\s+(\w+)\b)/gi;
    for (let event = events.exec(statement); event; event = events.exec(statement)) {
      if (event[1] !== undefined) bound.add(event[1].toLowerCase());
      else if (bound.has(event[2].toLowerCase())) return true;
    }
  }
  return false;
}

/** Rules that forbid an operation everywhere, whatever the file. */
const FORBIDDEN: Array<{ name: string; found: (text: string) => boolean }> = [
  { name: 'mutating a rotation decision', found: text => KEYWORD_BEFORE_ROTATION_LABEL.test(text) || mutatesBoundRotationDecision(text) },
  { name: 'an APOC call outside the read-only allowlist', found: text => /\bapoc\s*\.\s*(?!convert\s*\.\s*fromJsonMap\b|cypher\s*\.\s*run\b)\w+/i.test(text) },
  { name: 'a built-in vector property write (db.create.set*VectorProperty)', found: text => /\bdb\s*\.\s*create\s*\.\s*set\w*VectorProperty\b/i.test(text) },
  { name: 'a Graph Data Science procedure (gds.*, which includes the write procedures)', found: text => /\bgds\s*\./i.test(text) },
];

/**
 * Rules for each statement (text between two `;`, after backtick normalisation) naming the :User label, whatever the
 * variable, keyword case or clause order: map writes and runtime-built property names bypass the per-property rules.
 */
const USER_STATEMENT: Array<{ name: string; pattern: RegExp }> = [
  { name: 'a map write (SET x = / SET x += / , x +=) in a :User statement', pattern: /(?:\bSET\s+|,\s*)(?:\w+|\\?`[^`\n]*`)\s*\+?=(?!=)/i },
  { name: 'a :User node built from a parameter map', pattern: /\$(?<=(?::|&\s*)User\b(?:(?::|\s*&\s*)\w+)*\s*\$)/ },
  { name: 'a runtime-built property name in a :User statement', pattern: /\w\.\$\{|\b\w+\s*\[[^\][\n]*\]\s*\+?=(?!=)|\w\.['"]\s*\+|\w\.\\?`/ },
  { name: 'adding the :User label (SET x:User) in a :User statement', pattern: /(?:\bSET\s+|,\s*)\w+(?:\s*:\w+)*\s*:User\b/i },
];

const SECURITY_KEY = /(?:^|[{,\s])_?(?:passwordHash|platformAdmin|seedProvenance|defaultPasswordSuspect|credentialEpoch|scopes|organizationId)\s*:/;

/** The :User label, alone or in an `&` label expression (HAP-1673 P3). */
const USER_LABEL = /(?::|&\s*)User/;

/** Whether a :User node outside MATCH (CREATE, MERGE or a clause-less fragment) has a security key; linear: each node is read once to its closing parenthesis. */
function createsUserWithSecurityKey(text: string): boolean {
  for (const statement of text.split(';')) {
    const tokens = /\b(?:MATCH|CREATE|MERGE)\b|(?::|&\s*)User\b/gi;
    let clause = '';
    for (let token = tokens.exec(statement); token; token = tokens.exec(statement)) {
      if (/^\w/.test(token[0])) clause = token[0].toUpperCase();
      else if (token[0].endsWith('User') && clause !== 'MATCH') {
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
      if (rule.found(text)) found.push(`${file}: forbidden ${rule.name}`);
    }
    const statements = text.split(';').filter(statement => USER_LABEL.test(statement));
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
    ['HAP-1663 the :User label added after the key', USERS, "'CREATE (u {_id: $id, scopes: $s}) SET u :User'"],
    ['HAP-1663 the :User label added in a later statement', USERS, "'CREATE (n {_id: $id, scopes: $s}); MATCH (n {_id: $id}) SET n:User'"],
    ['HAP-1663 the :User label as a SET list item', USERS, "'CREATE (u:Person {scopes: $s}) SET u.name = $n, u:User'"],
    ['HAP-1663 an APOC atomic property write', USERS, "'MATCH (u:User {_id: $id}) CALL apoc.atomic.insert(u, \"scopes\", 0, $x)'"],
    ['HAP-1663 an APOC user built from a document', USERS, "'CALL apoc.graph.fromDocument({type: \"User\", _id: $id, scopes: $s}, {write: true})'"],
    ['HAP-1663 a built-in vector property write', USERS, "CALL db.create.setNodeVectorProperty(u, 'platformAdmin', [1.0])"],
    // HAP-1673: the rows below passed the gate before HAP-1673.
    ['HAP-1673 P1 a user created with an organization', USERS, "'CREATE (u:User {_id: $id, _organizationId: $org})'"],
    ['HAP-1673 P2 a GDS write procedure', USERS, "\"CALL gds.pageRank.write('g', {writeProperty: 'platformAdmin'})\""],
    ['HAP-1673 P3 a user created with an & label expression', USERS, "'CREATE (u:Admin&User {_id: $id, scopes: $s})'"],
    ['HAP-1673 P3 an & label user built from a parameter map', USERS, "'CREATE (u:Admin&User $props)'"],
    ['HAP-1673 P4 a password hash REMOVE', USERS, "'MATCH (u:User {_id: $id}) REMOVE u._passwordHash'"],
    ['HAP-1673 P6 a REMOVE after a backticked name with a space', USERS, "'MATCH (n {_id: $id}) REMOVE n.`full name`, n.scopes'"],
    ['HAP-1673 P6 a REMOVE through a parenthesised variable', USERS, "'MATCH (n {_id: $id}) REMOVE (n).scopes'"],
    ['HAP-1673 I1 an uppercase marker setter', USERS, "'MATCH (u:User {_id: $id}) SET u.defaultPasswordSuspect = TRUE'"],
  ])('fails on %s', (_label, file, line) => {
    expect(violations(new Map([[file, line]]))).not.toEqual([]);
  });

  /** The `forbidden ...` verdicts of one line in a file that holds no reviewed writer, for the rule named `rule`. */
  const forbiddenIn = (rule: string, line: string): string[] => violations(new Map([[USERS, line]])).filter(found => found.endsWith(`forbidden ${rule}`));

  // HAP-1674: every guarded key under every REMOVE shape; each must be one hit of the key's own rule.
  const REMOVE_KEYS = ['passwordHash', 'platformAdmin', 'seedProvenance', 'defaultPasswordSuspect', 'credentialEpoch', 'scopes', 'organizationId'];
  const REMOVE_SHAPES: Array<[string, (key: string) => string]> = [
    ['lowercase', key => `'MATCH (u:User {_id: $id}) remove u.${key}'`],
    ['second list item', key => `'MATCH (u:User {_id: $id}) REMOVE u.name, u.${key}'`],
    ['spaces around the dot', key => `'MATCH (u:User {_id: $id}) REMOVE u . ${key}'`],
  ];
  it.each(REMOVE_KEYS.flatMap(key => REMOVE_SHAPES.map(([shape, line]): [string, string, string] => [key, shape, line(key)])))(
    'HAP-1674 fails on a %s REMOVE: %s',
    (_key, _shape, line) => {
      expect(violations(new Map([[USERS, line]]))).toEqual([expect.stringMatching(/ \(found 1, reviewed 0\)$/)]);
    },
  );

  const APOC = 'an APOC call outside the read-only allowlist';
  it.each([
    ['apoc.cypher.doIt', "CALL apoc.cypher.doIt($query, {})"],
    ['apoc.cypher.runWrite', "CALL apoc.cypher.runWrite($query, {})"],
    ['apoc.cypher.runMany', "CALL apoc.cypher.runMany($query, {})"],
    ['apoc.convert.setJsonProperty', "CALL apoc.convert.setJsonProperty(u, 'k', $v)"],
    ['a name that only starts like the allowlisted fromJsonMap', 'RETURN apoc.convert.fromJsonMapX($s)'],
    ['an uppercase writer', 'CALL APOC.CYPHER.RUNWRITE($query, {})'],
    ['a writer with spaces around the dots', 'CALL apoc . cypher . runWrite ($query, {})'],
    ['a writer split over lines', 'CALL apoc\n  .cypher\n  .doIt($query, {})'],
  ])('HAP-1674 forbids %s', (_label, line) => {
    expect(forbiddenIn(APOC, line)).toHaveLength(1);
  });

  it.each([
    ['db.create.setVectorProperty', "CALL db.create.setVectorProperty(u, 'k', [1.0])"],
    ['an uppercase relationship writer with spaces', "CALL DB . CREATE . SETRELATIONSHIPVECTORPROPERTY(r, 'k', [1.0])"],
  ])('HAP-1674 forbids %s', (_label, line) => {
    expect(forbiddenIn('a built-in vector property write (db.create.set*VectorProperty)', line)).toHaveLength(1);
  });

  const ROTATION_DECISION = 'mutating a rotation decision';
  it.each([
    ['a lowercase DETACH DELETE of a matched decision (P5)', 'match (d:CredentialRotationDecision {id: $i}) detach delete d'],
    ['a lowercase MERGE of a decision (P5)', 'merge (d:CredentialRotationDecision {id: $i})'],
    ['a SET on the matched variable', 'MATCH (d:CredentialRotationDecision {id: $i}) SET d.note = $n'],
    ['a MERGE whose label is on the next line', 'MERGE (\n    d:CredentialRotationDecision {id: $i})'],
  ])('HAP-1674 forbids %s', (_label, line) => {
    expect(forbiddenIn(ROTATION_DECISION, line)).toHaveLength(1);
  });

  it.each([
    ['a read of a decision', 'MATCH (d:CredentialRotationDecision {id: $i}) RETURN d'],
    ['a SET on another variable than the matched decision', 'MATCH (d:CredentialRotationDecision {id: $i}), (e:Other) SET e.note = $n'],
    ['a SET in an earlier statement than the decision', 'SET e.note = $n; MATCH (d:CredentialRotationDecision) RETURN d'],
  ])('HAP-1674 does not forbid %s', (_label, line) => {
    expect(forbiddenIn(ROTATION_DECISION, line)).toEqual([]);
  });

  // HAP-1674: hostile 50k+ char lines, one per formerly quadratic regex (the rotation-decision keyword and variable shapes,
  // the api_keys UPDATE, the :User label chain). The whole gate must stay under 200 ms, best of three.
  it.each([
    ['a keyword line', 'SET '.repeat(13_000)],
    ['a keyword word', 'SET'.repeat(17_000)],
    ['repeated MATCH (v:CredentialRotationDecision', 'MATCH (a:CredentialRotationDecision '.repeat(5_500)],
    ['repeated UPDATE api_keys SET', 'UPDATE api_keys SET '.repeat(10_000)],
    ['a :User label chain', ':User:A'.repeat(14_000)],
  ])('HAP-1674 gates %s of 50k+ chars in under 200 ms', (_label, hostile) => {
    expect(hostile.length).toBeGreaterThanOrEqual(50_000);
    const sourcesByFile = new Map([[USERS, hostile]]);
    const elapsed = Math.min(...[0, 1, 2].map(() => {
      const start = performance.now();
      violations(sourcesByFile);
      return performance.now() - start;
    }));
    expect(elapsed).toBeLessThan(200);
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
    ['read-only APOC calls (graph-traversal.ts:180)',
      "\"CALL apoc.cypher.run('MATCH (n) RETURN count(n) AS c', {}) YIELD value RETURN apoc.convert.fromJsonMap(value.c)\""],
    ['TypeScript `: User` annotations (HAP-1673)',
      'function toUser(row: Row, passwordHash: string): User { const user: User = { ...row, scopes: [] }, n = 1; return user; }'],
    ['an `X & User` intersection named by a module-level alias, beside a :User statement (HAP-1673)',
      "type AdminUser = Admin & User;\nconst Q = 'MATCH (u:User {_id: $id}) RETURN u';\n" +
      'function grant(u: AdminUser, scopes: string[]): AdminUser { return { ...u, scopes }; }'],
    ['allowlisted APOC calls in any case and spacing (HAP-1674)',
      'CALL APOC . CYPHER . RUN($q, {}) YIELD value RETURN Apoc.Convert.FromJsonMap(value.c)'],
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
