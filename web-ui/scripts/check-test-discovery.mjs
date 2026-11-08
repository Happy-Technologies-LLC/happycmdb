#!/usr/bin/env node
// Fail closed: every git-tracked web-ui test file must be discovered by vitest.
// A test outside the vitest `include` glob, with an unlisted extension, or hidden by
// an `exclude` would otherwise never run in CI. An empty discovery also fails.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webUi = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: webUi, encoding: 'utf8' }).trim();
const rel = (p) => path.relative(root, p).split(path.sep).join('/');

const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/;
const tracked = execFileSync('git', ['ls-files', '-z', '--', webUi], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter((f) => TEST_NAME.test(f));

const vitestBin = createRequire(path.join(webUi, 'package.json')).resolve('vitest/vitest.mjs');
const out = execFileSync(process.execPath, [vitestBin, 'list', '--filesOnly', '--json'], {
  cwd: webUi,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'inherit'],
});
const discovered = new Set(JSON.parse(out.slice(out.indexOf('['))).map((e) => rel(e.file)));

const missing = tracked.filter((f) => !discovered.has(f));
if (discovered.size === 0 || tracked.length === 0) {
  console.error(`web-ui test discovery is empty (tracked=${tracked.length}, discovered=${discovered.size})`);
  process.exit(1);
}
if (missing.length > 0) {
  console.error('web-ui test files not discovered by vitest (they would never run in CI):');
  for (const f of missing) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`web-ui test discovery ok: ${tracked.length} tracked test files, all discovered`);
