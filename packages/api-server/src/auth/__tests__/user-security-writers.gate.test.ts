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
 * migrations, and infrastructure/scripts.
 */

import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

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
    name: 'credentialEpoch (the operator rotation only)',
    pattern: /\.\s*_?credentialEpoch\s*=(?!=)|REMOVE\s+\w+\._?credentialEpoch\b/g,
    reviewed: { 'packages/api-server/src/scripts/rotate-user-password.ts': 1 },
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
];

/** Rules that forbid an operation everywhere, whatever the file. */
const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: 'mutating a rotation decision', pattern: /(MERGE|DELETE|SET|REMOVE)[^\n;`]*\(?\s*\w*:CredentialRotationDecision|MATCH\s*\(\s*(\w+):CredentialRotationDecision[^`;]*\b(SET|REMOVE|DELETE)\s+\1\b/g },
  // Map writes bypass the per-property rules above.
  { name: 'a map write to a :User node (SET u = / SET u +=)', pattern: /MATCH\s*\(\s*(\w+)\s*:User\b[^`;]*?\bSET\s+\1\s*\+?=\s*[$\{]/g },
  {
    name: 'a :User node created or merged with a security property',
    pattern: /(CREATE|MERGE)\s*\(\s*\w*\s*:User\b[^)]*?\b(_?passwordHash|_?platformAdmin|_?seedProvenance|_?defaultPasswordSuspect|_?credentialEpoch)\s*:/g,
  },
];

const SCANNED_EXTENSIONS = /\.(ts|js|cypher|sql)$/;
const SKIPPED = /(^|\/)(node_modules|dist|__tests__|coverage)(\/|$)|\.(test|spec)\.ts$/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const rel = relative(ROOT, path);
    if (SKIPPED.test(rel)) continue;
    if (statSync(path).isDirectory()) walk(path, out);
    else if (SCANNED_EXTENSIONS.test(entry)) out.push(rel);
  }
}

function scannedFiles(): string[] {
  const files: string[] = [];
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    const src = join(ROOT, 'packages', pkg, 'src');
    if (statSync(join(ROOT, 'packages', pkg)).isDirectory() && safeIsDir(src)) walk(src, files);
  }
  walk(join(ROOT, 'infrastructure/scripts'), files);
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
  for (const [file, text] of sources) {
    for (const rule of RULES) {
      const actual = count(rule.pattern, text);
      const reviewed = rule.reviewed[file] ?? 0;
      if (actual !== reviewed) found.push(`${file}: ${rule.name} (found ${actual}, reviewed ${reviewed})`);
    }
    for (const rule of FORBIDDEN) {
      if (count(rule.pattern, text) > 0) found.push(`${file}: forbidden ${rule.name}`);
    }
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
  ])('fails on %s', (_label, file, addition) => {
    expect(violations(new Map([[file, sources.get(file)!]]))).toEqual([]);
    expect(violations(new Map([[file, `${sources.get(file)}\n${addition}\n`]]))).not.toEqual([]);
  });

  // Negative cases in files that hold no reviewed writer.
  it.each([
    ['a marker clearer in the auth service', 'packages/api-server/src/auth/auth.service.ts',
      "await session.run('MATCH (u:User) WHERE u._id = $id SET u.defaultPasswordSuspect = false')"],
    ['a platform-admin writer in a route', 'packages/api-server/src/rest/admin.controller.ts',
      "'MATCH (u:User {id: $id}) SET u.platformAdmin = true'"],
    ['a user created with a hash outside the seed writers', 'packages/api-server/src/rest/users.controller.ts',
      "'CREATE (u:User {_id: $id, _passwordHash: $hash})'"],
    ['a new migration clearing the marker', 'packages/database/src/postgres/migrations/099_x.sql',
      "UPDATE x SET n.defaultPasswordSuspect = false;"],
  ])('fails on %s', (_label, file, line) => {
    expect(violations(new Map([[file, line]]))).not.toEqual([]);
  });
});
