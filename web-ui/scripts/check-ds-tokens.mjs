#!/usr/bin/env node
// HAP-1252 S0: token check (decision N10). Every `--hh-*` custom property that web-ui source reads
// must be declared by the installed design system (`src/**/*.css`) or by web-ui itself. A token
// the design system renamed or dropped (1.1.0 -> a later release) would otherwise fall back to
// nothing at runtime: `var(--hh-gone)` is silently invalid, not a build error. Hard gate: exits 1.
//
//   node scripts/check-ds-tokens.mjs [srcDir]     (default: src)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { designSystemDir } from './lib/find-bin.mjs';

const SOURCE = /\.(css|tsx?|jsx?)$/;
const TEST = /\.(test|spec)\.[jt]sx?$/;
// `--hh-` + at least one name char. A match followed by `-` or `$` is a template prefix
// (`--hh-status-${tone}`) and cannot be checked statically.
const TOKEN = /--hh-[a-z0-9]+(?:-[a-z0-9]+)*(?![-$a-z0-9])/g;
const DECLARATION = /(--hh-[a-z0-9]+(?:-[a-z0-9]+)*)\s*:/g;

function* files(dir, pattern) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* files(full, pattern);
    else if (pattern.test(entry)) yield full;
  }
}

/** @returns {{ declared: Set<string>, missing: Map<string, string[]> }} missing: token -> files reading it */
export function checkTokens(srcDir, dsDir) {
  const declared = new Set();
  for (const f of files(path.join(dsDir, 'src'), /\.css$/)) {
    for (const m of readFileSync(f, 'utf8').matchAll(DECLARATION)) declared.add(m[1]);
  }
  const used = new Map();
  for (const f of files(srcDir, SOURCE)) {
    if (TEST.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(DECLARATION)) declared.add(m[1]);
    for (const m of text.matchAll(TOKEN)) {
      if (!used.has(m[0])) used.set(m[0], new Set());
      used.get(m[0]).add(f);
    }
  }
  const missing = new Map();
  for (const [token, where] of used) if (!declared.has(token)) missing.set(token, [...where].sort());
  return { declared, missing, usedCount: used.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const webUi = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const srcDir = path.resolve(webUi, process.argv[2] ?? 'src');
  const dsDir = designSystemDir(webUi);
  const { missing, usedCount } = checkTokens(srcDir, dsDir);
  if (usedCount === 0) {
    console.error(`ds-tokens: no --hh-* token reference found under ${srcDir}; refusing to pass on an empty scan`);
    process.exit(1);
  }
  if (missing.size > 0) {
    console.error('ds-tokens: --hh-* tokens read by web-ui but declared by neither the design system nor web-ui:');
    for (const [token, where] of missing) {
      console.error(`  ${token}  (${where.map((f) => path.relative(webUi, f)).join(', ')})`);
    }
    process.exit(1);
  }
  console.log(`ds-tokens ok: ${usedCount} distinct --hh-* tokens read, all declared`);
}
