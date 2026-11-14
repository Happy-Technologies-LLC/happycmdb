// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-659: a statement_timeout set with set_config() inside a running DO block does not bound that DO, so a new
// migration must open with top-level `SET LOCAL lock_timeout` / `SET LOCAL statement_timeout` (033-035, 039+ do).
// Applied migrations cannot be edited (their checksums are recorded), so the files that predate the rule are named
// here and the lint refuses every other file numbered 028 or above.
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const dir = join(__dirname, '..');
// Applied before the lint existed; all use set_config() inside DO. 038 is outside the "up to 037" range the
// ticket named, but its file has the same pattern and is applied.
const grandfathered = new Set([
  '028_change_history_reconciliation_org_provenance.sql',
  '029_reconciliation_conflict_identity_rules.sql',
  '030_drift_impact_org_provenance.sql',
  '031_business_service_mapping_ownership.sql',
  '032_secret_table_public_grants.sql',
  '036_history_criticality_org_contract.sql',
  '037_reconciliation_org_contract.sql',
  '038_drift_impact_org_contract.sql',
]);
const FIRST_LINTED = 28;

/** Top-level statements, comments dropped, dollar-quoted bodies reduced to `$$`; quoted strings kept verbatim. */
function topLevelStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  for (let i = 0; i < sql.length;) {
    const rest = sql.slice(i);
    const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(rest);
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
    } else if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      current += '$$';
      i = end < 0 ? sql.length : end + dollar[0].length;
    } else if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length && (sql[j] !== "'" || sql[j + 1] === "'")) j += sql[j] === "'" ? 2 : 1;
      current += sql.slice(i, j + 1);
      i = j + 1;
    } else if (sql[i] === ';') {
      statements.push(current.trim());
      current = '';
      i += 1;
    } else {
      current += sql[i];
      i += 1;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements.filter(Boolean);
}

const SET_LOCAL = /^SET\s+LOCAL\s+(lock_timeout|statement_timeout)\s*(?:=|TO)\s*'?(\d+)\s*(us|ms|s|min|h|d)?'?$/i;

/** Violations of the top-level timeout form; empty when the migration complies. */
function timeoutLintViolations(sql: string): string[] {
  const seen = new Map<string, number>();
  const violations: string[] = [];
  for (const statement of topLevelStatements(sql)) {
    if (/^BEGIN$/i.test(statement)) continue;
    const set = SET_LOCAL.exec(statement);
    if (!set) break; // first real statement: both timeouts must already be in force
    if (Number(set[2]) === 0) violations.push(`${set[1]} = 0 disables the timeout`);
    seen.set(set[1].toLowerCase(), Number(set[2]));
  }
  for (const name of ['lock_timeout', 'statement_timeout']) {
    if (!seen.has(name)) violations.push(`missing top-level SET LOCAL ${name} before the first statement`);
  }
  return violations;
}

// The migrator runs every *.sql in the directory (migrator.ts discoverMigrations), so the lint selects the same
// files. A name without a numeric prefix has no number to exempt it and is linted.
const migrationFiles = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
const number = (file: string) => Number(file.split('_')[0]);
const isLinted = (file: string) => !(number(file) < FIRST_LINTED) && !grandfathered.has(file);

describe('migration timeout lint (HAP-659)', () => {
  describe('rule', () => {
    const top = "SET LOCAL lock_timeout = '3s';\nSET LOCAL statement_timeout = '10s';\n";

    it('accepts top-level SET LOCAL timeouts before the first statement, with comments and BEGIN around them', () => {
      expect(timeoutLintViolations(`-- header; with semicolon\nBEGIN;\n${top}/* x; */ DO $a$ BEGIN NULL; END $a$;`))
        .toEqual([]);
      expect(timeoutLintViolations("SET LOCAL statement_timeout TO 10000;\nSET LOCAL lock_timeout TO '3000ms';\nSELECT 1;"))
        .toEqual([]);
    });

    it.each(['500us', '3ms', '3s', '1min', '1h', '1d'])('accepts the %s unit form', value => {
      expect(timeoutLintViolations(`SET LOCAL lock_timeout = '${value}';\nSET LOCAL statement_timeout = '${value}';\nSELECT 1;`))
        .toEqual([]);
    });

    it('treats an off-pattern file name as linted, since the migrator runs it', () => {
      expect(isLinted('hotfix_acl.sql')).toBe(true);
      expect(isLinted('050_new.sql')).toBe(true);
      expect(isLinted('027_old.sql')).toBe(false);
      expect(isLinted('038_drift_impact_org_contract.sql')).toBe(false);
    });

    it('refuses set_config() inside DO, which does not bound the DO', () => {
      const sql = "DO $hp1$\nBEGIN\n  PERFORM set_config('lock_timeout', '5s', true);\n  PERFORM set_config('statement_timeout', '10s', true);\nEND\n$hp1$;";
      expect(timeoutLintViolations(sql)).toHaveLength(2);
    });

    it('refuses a SET LOCAL that sits inside the DO body, after the DO has started', () => {
      expect(timeoutLintViolations("DO $a$ BEGIN SET LOCAL lock_timeout = '3s'; SET LOCAL statement_timeout = '10s'; END $a$;"))
        .toHaveLength(2);
    });

    it('refuses timeouts that arrive only after a DDL statement', () => {
      expect(timeoutLintViolations(`ALTER TABLE t ADD COLUMN c int;\n${top}`)).toHaveLength(2);
    });

    it('refuses a missing statement_timeout, a missing lock_timeout and a zero value', () => {
      expect(timeoutLintViolations("SET LOCAL lock_timeout = '3s';\nSELECT 1;"))
        .toEqual(['missing top-level SET LOCAL statement_timeout before the first statement']);
      expect(timeoutLintViolations("SET LOCAL statement_timeout = '10s';\nSELECT 1;"))
        .toEqual(['missing top-level SET LOCAL lock_timeout before the first statement']);
      expect(timeoutLintViolations("SET LOCAL lock_timeout = 0;\nSET LOCAL statement_timeout = '10s';\nSELECT 1;"))
        .toEqual(['lock_timeout = 0 disables the timeout']);
    });

    it('ignores a timeout that only appears in a comment or a string literal', () => {
      expect(timeoutLintViolations("-- SET LOCAL lock_timeout = '3s';\nSELECT 'SET LOCAL statement_timeout = 1; ';")).toHaveLength(2);
    });
  });

  describe('migrations', () => {
    it.each(migrationFiles.filter(isLinted))(
      '%s uses top-level SET LOCAL lock_timeout and statement_timeout', file => {
        expect(timeoutLintViolations(readFileSync(join(dir, file), 'utf8'))).toEqual([]);
      });

    it('grandfathers only applied files that still violate the rule, and none after 038', () => {
      for (const file of grandfathered) {
        expect(migrationFiles).toContain(file);
        expect(number(file)).toBeLessThanOrEqual(38);
        expect(timeoutLintViolations(readFileSync(join(dir, file), 'utf8'))).not.toEqual([]);
      }
    });
  });
});
