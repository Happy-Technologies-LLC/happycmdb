#!/usr/bin/env node
// HAP-1252 S0: design-system adherence gate for web-ui, warn-first (decision N10).
//
//   node scripts/ds-adherence.mjs [--deny-warnings] [paths...]     (default path: src)
//
// Runs the two checks the design system ships for consuming apps:
//   1. oxlint with `@happy-technologies/design-system/adherence` (no-restricted-imports: DS
//      internals, lucide-react, react-icons). Only that rule is counted; oxlint's generic
//      correctness rules are not DS adherence.
//   2. `happy-ds-adherence` (raw hex colours, fonts the system does not ship, prop values outside a
//      component's union; 0.9.1 aliases are reported as non-failing `deprecated` notices).
// Warn-first: findings are printed and summarised (a GitHub `::warning` in Actions) but the exit
// code stays 0. `--deny-warnings` (switched on from S2) exits 1 on any finding. A tool that crashes
// or whose output cannot be read always exits 1, so an unreadable result is never mistaken for clean.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { designSystemDir, findBin } from './lib/find-bin.mjs';

const webUi = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const deny = args.includes('--deny-warnings');
const paths = args.filter((a) => a !== '--deny-warnings');
if (paths.length === 0) paths.push('src');

const fail = (msg) => {
  console.error(`ds-adherence: ${msg}`);
  process.exit(1);
};
const run = (bin, binArgs) =>
  spawnSync(bin, binArgs, { cwd: webUi, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// 1. oxlint restricted imports.
const oxlint = run(findBin('oxlint', webUi), [
  '--config',
  path.join(designSystemDir(webUi), 'adherence.oxlintrc.json'),
  '--format',
  'json',
  ...paths,
]);
if (oxlint.error || oxlint.status !== 0) fail(`oxlint failed (status ${oxlint.status}): ${oxlint.error ?? oxlint.stderr}`);
let diagnostics;
try {
  diagnostics = JSON.parse(oxlint.stdout);
} catch (e) {
  fail(`oxlint output is not JSON: ${e.message}`);
}
const imports = diagnostics.filter((d) => String(d.code).includes('no-restricted-imports'));

// 2. happy-ds-adherence. Exit 1 = findings; anything else, or exit 1 with nothing readable, is a crash.
const adherence = run(findBin('happy-ds-adherence', webUi), paths);
if (adherence.error || (adherence.status !== 0 && adherence.status !== 1)) {
  fail(`happy-ds-adherence failed (status ${adherence.status}): ${adherence.error ?? adherence.stderr}`);
}
const output = adherence.stdout + adherence.stderr;
const FINDING = /^(.+?):(\d+):(\d+)\s{2}(.*)$/;
const lines = output.split('\n').map((l) => FINDING.exec(l)).filter(Boolean);
const problems = lines.filter((m) => !m[4].startsWith('deprecated:'));
const notices = lines.filter((m) => m[4].startsWith('deprecated:'));
if (adherence.status === 1 && problems.length === 0 && notices.length === 0) {
  fail(`happy-ds-adherence exited 1 with no readable finding:\n${adherence.stdout}${adherence.stderr}`);
}

for (const d of imports) {
  const span = d.labels?.[0]?.span;
  console.log(`${path.relative(webUi, d.filename)}${span ? `@${span.offset}` : ''}  ${d.message} ${d.help ?? ''}`);
}
for (const m of lines) console.log(`${m[1]}:${m[2]}:${m[3]}  ${m[4]}`);

const total = imports.length + problems.length;
const summary =
  `${imports.length} restricted import(s), ${problems.length} adherence problem(s), ` +
  `${notices.length} deprecation notice(s)`;
if (total === 0) {
  console.log(`ds-adherence: clean (${summary})`);
} else if (deny) {
  console.error(`ds-adherence: FAIL --deny-warnings (${summary})`);
  process.exit(1);
} else {
  console.log(`ds-adherence: warn-first, not failing (${summary})`);
  if (process.env.GITHUB_ACTIONS) console.log(`::warning title=DS adherence (warn-first)::${summary}`);
}
