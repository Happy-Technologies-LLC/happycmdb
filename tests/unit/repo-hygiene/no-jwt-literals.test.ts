/**
 * Repo-hygiene guard: no tracked file may carry a full signed JWT.
 *
 * Captured request logs (e.g. axios error dumps in validation notes) embed
 * live-looking bearer tokens that secret scanners flag. Placeholders and
 * truncated examples (`eyJhbGciOi...`) are fine; only a complete
 * header.payload.signature triple fails. Hits are reported as path:line so the
 * token value never reaches test output or CI logs.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../../..');
const FULL_JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function readText(path: string): string | undefined {
  let buf: Buffer;
  try {
    buf = readFileSync(resolve(REPO_ROOT, path));
  } catch {
    return undefined; // tracked but deleted/unreadable in this checkout
  }
  // Same heuristic as git: a NUL byte in the first 8000 bytes means binary.
  return buf.subarray(0, 8000).includes(0) ? undefined : buf.toString('utf8');
}

describe('repo hygiene', () => {
  it('has no full three-part JWT literal in any tracked file', () => {
    const hits: string[] = [];
    for (const path of trackedFiles()) {
      const text = readText(path);
      if (text === undefined) continue;
      text.split('\n').forEach((line, i) => {
        if (FULL_JWT.test(line)) hits.push(`${path}:${i + 1}`);
      });
    }

    expect(hits).toEqual([]);
  });
});
