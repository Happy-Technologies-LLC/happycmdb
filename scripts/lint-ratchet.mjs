#!/usr/bin/env node
// HAP-1951: repo-wide `npm run lint` as a ratchet.
//
// Why not `eslint .`: the root config is type-aware, and one program over the whole repo ran out of heap
// (core dump after ~20 min). Here each backend package is linted on its own, against its own tsconfig, in a child
// process that exits (and frees its program) before the next one starts. The file list is the tsconfig's own, so
// test files that the build excludes are not linted (they cannot be: they are outside the project). web-ui has its
// own non-type-aware config and its own CI job (`npm run lint --workspace=web-ui`).
//
// Deterministic program: the type-aware rules resolve `@cmdb/*` imports through the library packages' build output
// (project references and `node_modules/@cmdb/*` -> `dist/index.d.ts`). Without it those imports are `any` and the
// findings depend on whether someone ran a build. So before linting, the script runs `tsc -b` on every package the
// linted ones reference, directly or not (incremental; a no-op when `dist/` is current). The result is the same on
// a fresh `npm ci` clone and on a fully built tree.
//
// Ratchet: the existing findings are recorded per file and rule in `.eslint-baseline.json`. The run fails when a
// (file, rule) pair has more findings than the baseline allows, which includes any finding in a file or rule that
// is not in it. Fixing findings never fails. `--update` (npm run lint:baseline) writes min(baseline, current) per
// pair, so it only ever lowers counts; `--update --allow-raise` writes the current counts as they are (for a
// renamed or moved file, reviewed like any other raise).
//
// Usage: node scripts/lint-ratchet.mjs [--update [--allow-raise]] [--package <dir-name>]...
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(root, '.eslint-baseline.json');
const require = createRequire(import.meta.url);
const { PARSE_ERROR, compareCounts, nextBaseline, total } = require('./lint-ratchet-compare.cjs');

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

// The sibling packages `name` depends on: its tsconfig `references`, its package.json `@cmdb/*` dependencies and the
// `@cmdb/*` packages its non-test sources import. The last two are needed because the references are incomplete
// (e.g. api-server imports @cmdb/identity-resolution without declaring or referencing it), and a missing edge
// would let `tsc -b` build a package before the one it imports.
function siblingDeps(name, all) {
  const ts = require('typescript');
  const pkgDir = dir(name);
  const deps = new Set();
  const add = (dep) => {
    if (dep !== name && all.includes(dep)) {
      deps.add(dep);
    }
  };
  const read = ts.readConfigFile(path.join(pkgDir, 'tsconfig.json'), ts.sys.readFile);
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  }
  for (const ref of read.config.references ?? []) {
    const target = path.resolve(pkgDir, ref.path);
    add(path.basename(target.endsWith('.json') ? path.dirname(target) : target));
  }
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (existsSync(pkgJsonPath)) {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    for (const group of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
      for (const key of Object.keys(group ?? {})) {
        if (key.startsWith('@cmdb/')) {
          add(key.slice('@cmdb/'.length));
        }
      }
    }
  }
  const srcDir = path.join(pkgDir, 'src');
  if (existsSync(srcDir)) {
    for (const rel of readdirSync(srcDir, { recursive: true })) {
      if (!/\.tsx?$/.test(rel) || /(^|[\\/])__tests__[\\/]|\.(test|spec)\.tsx?$/.test(rel)) {
        continue;
      }
      const text = readFileSync(path.join(srcDir, rel), 'utf8');
      for (const m of text.matchAll(/from\s+['"]@cmdb\/([a-z0-9-]+)(?:\/[^'"]*)?['"]|require\(\s*['"]@cmdb\/([a-z0-9-]+)/g)) {
        add(m[1] ?? m[2]);
      }
    }
  }
  return [...deps].sort();
}

// The packages to build before linting `names`: everything they depend on, transitively, in dependency order.
function buildOrder(names, all) {
  const order = [];
  const state = new Map(); // name -> 'visiting' | 'done'
  const visit = (name, chain) => {
    if (state.get(name) === 'done') {
      return;
    }
    if (state.get(name) === 'visiting') {
      throw new Error(`dependency cycle between sibling packages: ${[...chain, name].join(' -> ')}`);
    }
    state.set(name, 'visiting');
    for (const dep of siblingDeps(name, all)) {
      visit(dep, [...chain, name]);
    }
    state.set(name, 'done');
    order.push(name);
  };
  const roots = new Set(names.flatMap((n) => siblingDeps(n, all)));
  for (const r of [...roots].sort()) {
    visit(r, []);
  }
  return order;
}

// `tsc -b` the packages the linted ones depend on so every worker lints against the same declarations whether or
// not a build ran before (incremental: a no-op when `dist/` is current). Fail closed: a program that cannot be built
// would be linted against a partial `dist/`.
function buildDependencies(names, all) {
  const order = buildOrder(names, all);
  if (order.length === 0) {
    return;
  }
  const heap = process.env.LINT_HEAP_MB ?? '6144';
  const started = Date.now();
  const res = spawnSync(
    process.execPath,
    [`--max-old-space-size=${heap}`, require.resolve('typescript/bin/tsc'), '-b', ...order.map(dir)],
    { cwd: root, stdio: 'inherit' }
  );
  if (res.status !== 0) {
    throw new Error(`tsc -b of ${order.length} dependency packages failed (exit ${res.status}, signal ${res.signal ?? 'none'})`);
  }
  console.log(`  tsc -b ${order.length} dependency packages (${order.join(', ')}): ${Date.now() - started} ms`);
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
  const allowRaise = argv.includes('--allow-raise');
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
  if (allowRaise && !update) {
    throw new Error('--allow-raise only applies to --update');
  }

  buildDependencies(names, all);
  console.log(`eslint ratchet: ${names.length} packages`);
  const current = {};
  for (const n of names) {
    Object.assign(current, runWorker(n));
  }

  if (update) {
    const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
    const { next, refused } = nextBaseline(baseline, current, allowRaise);
    writeFileSync(baselinePath, `${JSON.stringify(sortedBaseline(next), null, 1)}\n`);
    console.log(`wrote ${path.relative(root, baselinePath)}: ${total(next)} findings in ${Object.keys(next).length} files`);
    if (refused.length > 0) {
      console.error(`\n${refused.length} (file, rule) pairs are above the baseline and were NOT raised (pass --allow-raise for a rename or move):`);
      for (const r of refused) {
        console.error(`  ${r.file}: ${r.rule} ${r.allowed} -> ${r.found}`);
      }
    }
    return;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const { regressions, improved } = compareCounts(baseline, current, only);
  const now = total(current);
  if (regressions.length > 0) {
    console.error(`\neslint ratchet FAILED: ${regressions.length} (file, rule) pairs above the baseline`);
    for (const r of regressions) {
      console.error(`  ${r.file}: ${r.rule} ${r.allowed} -> ${r.found}`);
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
