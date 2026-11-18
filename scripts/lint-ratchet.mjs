#!/usr/bin/env node
// HAP-1951: repo-wide `npm run lint` as a ratchet.
//
// Why not `eslint .`: the root config is type-aware, and one program over the whole repo ran out of heap
// (core dump after ~20 min). Here each backend package is linted on its own, against its own tsconfig, in a child
// process that exits (and frees its program) before the next one starts. The file list is the tsconfig's own, so
// test files that the build excludes are not linted (they cannot be: they are outside the project). web-ui has its
// own non-type-aware config and its own CI job (`npm run lint --workspace=web-ui`).
//
// Ratchet: the existing findings are recorded per file and rule in `.eslint-baseline.json`. The run fails when a
// (file, rule) pair has more findings than the baseline allows, which includes any finding in a file or rule that
// is not in it. Fixing findings never fails; run `npm run lint:baseline` to write the lower counts down.
//
// Usage: node scripts/lint-ratchet.mjs [--update] [--package <dir-name>]...
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(root, '.eslint-baseline.json');
const require = createRequire(import.meta.url);
const PARSE_ERROR = '(parse error)';

function listPackages() {
  const dir = path.join(root, 'packages');
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(dir, e.name, 'tsconfig.json')))
    .map((e) => e.name)
    .sort();
}

// Worker: lint one package, print its { file: { rule: count } } map as the last stdout line.
async function lintPackage(name) {
  const ts = require('typescript');
  const { ESLint } = require('eslint');
  const pkgDir = dir(name);
  const tsconfigPath = path.join(pkgDir, 'tsconfig.json');
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, pkgDir);
  const files = parsed.fileNames.filter(
    (f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts') && f.startsWith(pkgDir + path.sep) && !f.includes(`${path.sep}node_modules${path.sep}`)
  );
  const eslint = new ESLint({
    cwd: root,
    overrideConfig: { parserOptions: { project: tsconfigPath, tsconfigRootDir: root } },
  });
  const counts = {};
  for (const result of await eslint.lintFiles(files)) {
    const rel = path.relative(root, result.filePath).split(path.sep).join('/');
    for (const m of result.messages) {
      const rule = m.ruleId ?? PARSE_ERROR;
      counts[rel] ??= {};
      counts[rel][rule] = (counts[rel][rule] ?? 0) + 1;
    }
  }
  process.stdout.write(`\n${JSON.stringify({ files: files.length, counts })}\n`);
}

function dir(name) {
  return path.join(root, 'packages', name);
}

function runWorker(name) {
  const heap = process.env.LINT_HEAP_MB ?? '6144';
  const started = Date.now();
  const res = spawnSync(
    process.execPath,
    [`--max-old-space-size=${heap}`, fileURLToPath(import.meta.url), '--worker', name],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }
  );
  if (res.status !== 0) {
    throw new Error(`eslint worker for packages/${name} failed (exit ${res.status}, signal ${res.signal ?? 'none'})`);
  }
  const lastLine = res.stdout.trim().split('\n').pop();
  const out = JSON.parse(lastLine);
  console.log(`  packages/${name}: ${out.files} files, ${Date.now() - started} ms`);
  return out.counts;
}

function total(counts) {
  let n = 0;
  for (const rules of Object.values(counts)) {
    for (const c of Object.values(rules)) {
      n += c;
    }
  }
  return n;
}

function sortedBaseline(counts) {
  const out = {};
  for (const file of Object.keys(counts).sort()) {
    out[file] = Object.fromEntries(Object.entries(counts[file]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--worker') {
    await lintPackage(argv[1]);
    return;
  }
  const update = argv.includes('--update');
  const only = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--package') {
      only.push(argv[++i]);
    }
  }
  const all = listPackages();
  const names = only.length > 0 ? only : all;
  for (const n of names) {
    if (!all.includes(n)) {
      throw new Error(`unknown package "${n}"; known: ${all.join(', ')}`);
    }
  }
  if (update && only.length > 0) {
    throw new Error('--update rewrites the whole baseline; do not combine it with --package');
  }

  console.log(`eslint ratchet: ${names.length} packages`);
  const current = {};
  for (const n of names) {
    Object.assign(current, runWorker(n));
  }

  if (update) {
    writeFileSync(baselinePath, `${JSON.stringify(sortedBaseline(current), null, 1)}\n`);
    console.log(`wrote ${path.relative(root, baselinePath)}: ${total(current)} findings in ${Object.keys(current).length} files`);
    return;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const scoped = (file) => only.length === 0 || only.some((n) => file.startsWith(`packages/${n}/`));
  const regressions = [];
  let improved = 0;
  for (const file of Object.keys(current)) {
    for (const [rule, n] of Object.entries(current[file])) {
      const allowed = baseline[file]?.[rule] ?? 0;
      if (n > allowed) {
        regressions.push(`${file}: ${rule} ${allowed} -> ${n}`);
      }
    }
  }
  for (const file of Object.keys(baseline).filter(scoped)) {
    for (const [rule, allowed] of Object.entries(baseline[file])) {
      improved += Math.max(0, allowed - (current[file]?.[rule] ?? 0));
    }
  }
  const now = total(current);
  if (regressions.length > 0) {
    console.error(`\neslint ratchet FAILED: ${regressions.length} (file, rule) pairs above the baseline`);
    for (const r of regressions) {
      console.error(`  ${r}`);
    }
    console.error('\nFix the new findings. The baseline only ever goes down; never raise it to make this pass.');
    console.error('Re-run one package with: node scripts/lint-ratchet.mjs --package <name>, or see the rule at the file.');
    process.exit(1);
  }
  console.log(`eslint ratchet ok: ${now} findings, none above the baseline`);
  if (improved > 0) {
    console.log(`${improved} findings are below the baseline; run "npm run lint:baseline" to lock the lower counts in.`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
