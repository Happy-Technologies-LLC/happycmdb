// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1234: only the shared clients talk to the API. A file's own axios or fetch call skips their Bearer interceptor,
// so a real server answers 401 (the Agent views showed 0 rows on staging).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
const SRC = path.resolve(__dirname, '..');
// Each sets Authorization from localStorage auth_token and sends a 401 to /login.
const SHARED = ['lib/api-client.ts', 'services/api.ts', 'services/ci.service.ts', 'services/credential.service.ts'];
// Existing offenders not fixed yet, one commented entry per file. Empty at 878f62d once the Agent views moved to
// apiClient: the other candidates only call react-query refetch() or import axios types.
const OFFENDERS: string[] = [];
// A value binding from 'axios': default, namespace or named. `import type` and all-`type` specifier lists stay allowed.
const valueImport = { test: (t: string) => [...t.matchAll(/\bimport\s+(?!type\s)([^'";]*?)\s*from\s*['"]axios['"]/g)].some(([, clause]) => !/^\{(\s*type\s+[\w$]+(\s+as\s+[\w$]+)?\s*,?)*\s*\}$/.test(clause)) };
const RULES = [
  valueImport,
  /\b(require|import)\s*\(\s*['"]axios['"]\s*\)/, // require('axios') or a dynamic import('axios')
  /\baxios\s*(\.\s*(get|post|put|patch|delete|request|create)\s*)?\(/, // a direct axios call
  /^(?=[\s\S]*(\/api\/v1|API_BASE_URL))[\s\S]*(?<![\w$])fetch\s*\(/, // fetch, window./globalThis./self.fetch, in a file that builds API URLs
];
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const sources = walk(SRC).map((f) => path.relative(SRC, f)).filter((f) => /\.tsx?$/.test(f) && !/\.(test|spec)\.tsx?$|(^|\/)(__tests__|tests|mocks)\//.test(f));
it('no web-ui/src file calls the API through its own axios or fetch outside the shared clients (HAP-1234)', () => {
  const found = sources.filter((f) => RULES.some((r) => r.test(readFileSync(path.join(SRC, f), 'utf8'))));
  expect(SHARED.every((f) => found.includes(f))).toBe(true);
  expect(found.filter((f) => !SHARED.includes(f) && !OFFENDERS.includes(f))).toEqual([]);
});
