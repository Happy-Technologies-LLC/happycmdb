// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Inventory gate 4 (HP1-S6, design v16 §10.4 gate 4 / E-7): exactly the
 * reviewed sites may write each user-security property. A new writer
 * anywhere in deployable source, init scripts or migrations fails the
 * build until it is reviewed and added here.
 *
 * Scanned: every packages/<name>/src tree (TypeScript, committed JavaScript, Cypher, SQL;
 * tests excluded), infrastructure/scripts and the PostgreSQL migrations.
 */

import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '../../../../..');

/** Property-write patterns, each with the files allowed to contain such a write. */
const RULES: Array<{ name: string; pattern: RegExp; allowed: string[] }> = [
  {
    name: 'platformAdmin (set only by the reviewed operator grant)',
    pattern: /\.\s*_?platformAdmin\s*=(?!=)|REMOVE\s+\w+\._?platformAdmin\b/g,
    allowed: ['packages/api-server/src/scripts/identity-window.ts'],
  },
  {
    name: 'seedProvenance (seed writers and the window stamp; never cleared)',
    pattern: /\.\s*_?seedProvenance\s*=(?!=)|REMOVE\s+\w+\._?seedProvenance\b/g,
    allowed: [
      'infrastructure/scripts/init-neo4j.cypher',
      'infrastructure/scripts/seed-data.ts',
      'packages/api-server/src/scripts/identity-window.ts',
    ],
  },
  {
    name: 'defaultPasswordSuspect = true (marker setters)',
    pattern: /\.\s*defaultPasswordSuspect\s*=\s*true\b/g,
    allowed: [
      'infrastructure/scripts/init-neo4j.cypher',
      'infrastructure/scripts/seed-data.ts',
      'packages/api-server/src/auth/neo4j-auth.repository.ts',
      'packages/api-server/src/scripts/identity-window.ts',
    ],
  },
  {
    name: 'defaultPasswordSuspect cleared (the operator rotation only)',
    pattern: /\.\s*defaultPasswordSuspect\s*=\s*(?!true\b)[^=\s]|REMOVE\s+\w+\.defaultPasswordSuspect\b/g,
    allowed: ['packages/api-server/src/scripts/rotate-user-password.ts'],
  },
  {
    name: '_defaultPasswordSuspect (no writer; REMOVE by the rotation only)',
    pattern: /\.\s*_defaultPasswordSuspect\s*=(?!=)|REMOVE\s+\w+\._defaultPasswordSuspect\b/g,
    allowed: ['packages/api-server/src/scripts/rotate-user-password.ts'],
  },
  {
    name: 'credentialEpoch (the operator rotation only)',
    pattern: /\.\s*_?credentialEpoch\s*=(?!=)|REMOVE\s+\w+\._?credentialEpoch\b/g,
    allowed: ['packages/api-server/src/scripts/rotate-user-password.ts'],
  },
  {
    name: 'password hash (rotation, guarded self-service change, seed writers)',
    pattern: /\.\s*_?passwordHash\s*=(?!=)/g,
    allowed: [
      'infrastructure/scripts/init-neo4j.cypher',
      'infrastructure/scripts/seed-data.ts',
      'packages/api-server/src/auth/neo4j-auth.repository.ts',
      'packages/api-server/src/scripts/rotate-user-password.ts',
      'packages/api-server/src/scripts/seed-tenant-fixture.ts',
    ],
  },
  {
    name: 'api_keys.credential_epoch updates (none; set once at INSERT)',
    pattern: /UPDATE\s+api_keys\s+SET[^;`]*credential_epoch\s*=/gi,
    allowed: [],
  },
  {
    name: ':CredentialRotationDecision (created by the rotation; constraint in init-neo4j; named in the 020 audit comment)',
    pattern: /CredentialRotationDecision/g,
    allowed: [
      'infrastructure/scripts/init-neo4j.cypher',
      'packages/api-server/src/scripts/rotate-user-password.ts',
      'packages/database/src/postgres/migrations/020_auth_credential_events.sql',
    ],
  },
  {
    name: 'bulk API-key revocation by user (the operator rotation only)',
    pattern: /UPDATE\s+api_keys\s+SET\s+enabled\s*=\s*false/gi,
    allowed: ['packages/api-server/src/scripts/rotate-user-password.ts'],
  },
  {
    name: 'auth_credential_events INSERT (login marker, window scan, rotation)',
    pattern: /INSERT\s+INTO\s+auth_credential_events/gi,
    allowed: [
      'packages/api-server/src/auth/neo4j-auth.repository.ts',
      'packages/api-server/src/scripts/identity-window.ts',
      'packages/api-server/src/scripts/rotate-user-password.ts',
    ],
  },
];

/** Rules that forbid an operation everywhere, whatever the file. */
const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: 'mutating a rotation decision', pattern: /(MERGE|DELETE|SET|REMOVE)[^\n;`]*\(?\s*\w*:CredentialRotationDecision|MATCH\s*\(\s*(\w+):CredentialRotationDecision[^`;]*\b(SET|REMOVE|DELETE)\s+\1\b/g },
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

/** Writers outside the allowed files, as `file: rule` strings. */
function violations(sources: Map<string, string>): string[] {
  const found: string[] = [];
  for (const [file, text] of sources) {
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(text) && !rule.allowed.includes(file)) found.push(`${file}: ${rule.name}`);
    }
    for (const rule of FORBIDDEN) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(text)) found.push(`${file}: forbidden ${rule.name}`);
    }
  }
  return found.sort();
}

describe('inventory gate 4: user-security property writers', () => {
  it('only the reviewed sites write platformAdmin, seedProvenance, the marker, the generation, hashes, decisions and the audit', () => {
    const sources = new Map(scannedFiles().map(file => [file, readFileSync(join(ROOT, file), 'utf8')]));

    expect(violations(sources)).toEqual([]);
  });

  // Negative cases: each plausible regression is caught.
  it.each([
    ['a second marker clearer in the auth service', 'packages/api-server/src/auth/auth.service.ts',
      "await session.run('MATCH (u:User) WHERE u._id = $id SET u.defaultPasswordSuspect = false')"],
    ['an underscore-spelling marker setter', 'packages/api-server/src/auth/neo4j-auth.repository.ts',
      "'MATCH (u:User) WHERE elementId(u) = $e SET u._defaultPasswordSuspect = true'"],
    ['a generation writer in changePassword', 'packages/api-server/src/auth/neo4j-auth.repository.ts',
      "'SET u.credentialEpoch = $epoch'"],
    ['an unguarded password write in updateUser', 'packages/api-server/src/rest/users.controller.ts',
      "setClauses.push('u._passwordHash = $passwordHash')"],
    ['a platform-admin writer in a route', 'packages/api-server/src/rest/admin.controller.ts',
      "'MATCH (u:User {id: $id}) SET u.platformAdmin = true'"],
    ['deleting rotation decisions', 'packages/api-server/src/scripts/rotate-user-password.ts',
      "'MATCH (d:CredentialRotationDecision) DETACH DELETE d'"],
    ['an API-key generation update', 'packages/api-server/src/auth/neo4j-auth.repository.ts',
      "'UPDATE api_keys SET credential_epoch = $1 WHERE id = $2'"],
  ])('fails on %s', (_label, file, line) => {
    expect(violations(new Map([[file, line]]))).not.toEqual([]);
  });
});
