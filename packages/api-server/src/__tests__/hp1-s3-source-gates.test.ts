// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/** v16 §10.4 gates 5–6: inspect deployable sources, including committed JavaScript. */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';

const ROOT = join(__dirname, '../../../..');
const EXTENSION = /\.(ts|[cm]?js|sql)$/;
const SKIP = /(^|\/)(node_modules|dist|coverage|__tests__|fixtures)(\/|$)|\.(test|spec|d)\.ts$|\.map$/;

function walk(directory: string, sources: Map<string, string>): void {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const path = relative(ROOT, full).replaceAll('\\', '/');
    if (SKIP.test(path)) continue;
    if (statSync(full).isDirectory()) walk(full, sources);
    else if (EXTENSION.test(entry)) sources.set(path, readFileSync(full, 'utf8'));
  }
}

function inventory(): Map<string, string> {
  const sources = new Map<string, string>();
  const packages = join(ROOT, 'packages');
  for (const name of readdirSync(packages)) {
    const source = join(packages, name, 'src');
    if (statSync(join(packages, name)).isDirectory()) {
      if (existsSync(source)) walk(source, sources);
    }
  }
  walk(join(ROOT, 'infrastructure', 'scripts'), sources);
  walk(join(ROOT, 'scripts'), sources);
  return sources;
}

function violations(sources: Map<string, string>): string[] {
  const failures: string[] = [];
  for (const [file, text] of sources) {
    if (/\.(ts|[cm]?js)$/.test(file) && /['"`]x-actor['"`]/i.test(text)) failures.push(`${file}: unverified actor header`);
    if (/\.sql$/.test(file) &&
      /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\b[^;]*\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:public\.)?log_ci_change\s*\(/gi.test(text)) {
      failures.push(`${file}: unchained CI audit trigger`);
    }
    if (!/\.(ts|[cm]?js)$/.test(file)) continue;
    for (const match of text.matchAll(/INSERT\s+INTO\s+(?:public\.)?audit_log\s*\(([^)]*)\)/gi)) {
      if (!/\borganization_id\b/i.test(match[1]!) || !/\bactor\b/i.test(match[1]!)) {
        failures.push(`${file}: unbound audit insert`);
      }
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
      /\.(?:[cm]?js)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    const isNamed = (node: ts.Expression, name: string) =>
      ts.isPropertyAccessExpression(node) ? node.name.text === name :
        ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === name;
    const payloadAliases = new Set<string>();
    const collectAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        ((ts.isPropertyAccessExpression(node.initializer) && node.initializer.name.text === 'data' &&
          ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'job') ||
          (ts.isIdentifier(node.initializer) && payloadAliases.has(node.initializer.text)))) {
        payloadAliases.add(node.name.text);
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(source);
    const containsUnsafeJob = (node: ts.Node): boolean => {
      if (ts.isIdentifier(node) && payloadAliases.has(node.text)) return true;
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'data' &&
        ts.isIdentifier(node.expression) && node.expression.text === 'job') return true;
      if (ts.isSpreadAssignment(node) && ts.isIdentifier(node.expression) && node.expression.text === 'job') return true;
      return ts.forEachChild(node, containsUnsafeJob) ?? false;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'logAudit') {
        const body = node.body?.getText(source) ?? '';
        if (node.parameters.length !== 2 || !/!organizationId\b/.test(body) || !/entry\[['"]actor['"]\]/.test(body)) {
          failures.push(`${file}: audit method lacks mandatory org/actor guard`);
        }
      }
      if (ts.isCallExpression(node) && isNamed(node.expression, 'logAudit') && node.arguments.length !== 2) {
        failures.push(`${file}: audit call without organization`);
      }
      if (file.includes('/src/rest/') || file.includes('/src/graphql/')) {
        if (ts.isCallExpression(node) && ['json', 'send', 'stringify'].some(name => isNamed(node.expression, name)) &&
          node.arguments.some(containsUnsafeJob)) {
          failures.push(`${file}: raw job payload serialization`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return failures.sort();
}

const audited = inventory();
it('deployable TS and committed JS contain no unbound audit or discovery output path', () => {
  expect(violations(audited)).toEqual([]);
});

const injected: Array<[string, string]> = [
  ['packages/api-server/src/rest/controllers/jobs.controller.ts', "const B = req.headers['x-actor'];"],
  ['scripts/bad-cjs-script.cjs', "const actor = request.headers['x-actor'];"],
  ['packages/database/src/postgres/audit.service.js', "await this.logAudit({ actor: 'request' });"],
  ['packages/database/src/postgres/audit.service.ts', "const Q = 'INSERT INTO audit_log (actor, action) VALUES ($1, $2)';"],
  ['packages/database/src/postgres/migrations/099_bad_audit.sql',
    'CREATE TRIGGER bad AFTER UPDATE ON cis FOR EACH ROW EXECUTE FUNCTION log_ci_change();'],
  ['packages/api-server/src/rest/controllers/jobs.controller.ts', 'res.json({ data: job.data });'],
  ['packages/api-server/src/rest/controllers/jobs.controller.ts', 'const payload = job.data; res.json({ data: payload });'],
];
it.each(injected)('refuses an injected gate bypass in %s', (path, addition) => {
  const original = audited.get(path) ?? '';
  const changed = new Map([[path, `${original}\n${addition}\n`]]);
  expect(violations(changed)).not.toEqual([]);
});
