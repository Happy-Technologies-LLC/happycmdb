// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * v16 §15 N-21: `seed-data.ts` and `deploy.sh --seed` exit non-zero outside
 * NODE_ENV=development (they write a known admin credential).
 *
 * deploy.sh runs from an empty scratch directory (no .env) with a PATH that
 * holds only failing `docker`/`docker-compose` stubs, so a regression past
 * the refusal fails on its first external command instead of deploying.
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { spawnSync } from 'child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = join(__dirname, '../../../../..');
const savedNodeEnv = process.env['NODE_ENV'];

afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = savedNodeEnv;
  jest.restoreAllMocks();
});

describe('seed-data.ts refuses outside development', () => {
  it.each([['production'], ['test'], [undefined]])('NODE_ENV=%s → exit 1 before any connection', nodeEnv => {
    if (nodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = nodeEnv;
    const exit = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`);
    });
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => jest.isolateModules(() => {
      require(join(ROOT, 'infrastructure/scripts/seed-data.ts'));
    })).toThrow('process.exit(1)');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('ERROR: seed-data.ts only runs with NODE_ENV=development');
  });
});

describe('deploy.sh --seed refuses outside development', () => {
  it.each([['production'], [undefined]])('NODE_ENV=%s → exit 1 before any docker command', nodeEnv => {
    const scratch = mkdtempSync(join(tmpdir(), 'cmdb-deploy-seed-'));
    try {
      const bin = join(scratch, 'bin');
      mkdirSync(bin);
      for (const tool of ['docker', 'docker-compose']) {
        writeFileSync(join(bin, tool), '#!/bin/sh\necho "stub $0 must not run" >&2\nexit 99\n');
        chmodSync(join(bin, tool), 0o755);
      }
      copyFileSync(join(ROOT, 'deploy.sh'), join(scratch, 'deploy.sh'));
      const env: NodeJS.ProcessEnv = { PATH: bin, HOME: scratch };
      if (nodeEnv !== undefined) env['NODE_ENV'] = nodeEnv;

      const result = spawnSync('/bin/bash', ['deploy.sh', '--seed'], { cwd: scratch, env, encoding: 'utf8' });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain('--seed requires NODE_ENV=development');
      expect(result.stderr).not.toContain('must not run');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
