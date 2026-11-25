// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// The hosted `Staging Migration Contract` job (deploy/test-staging-migrations.sh) once failed on main with exit 255 and no output
// at all (run 45482752034): the compose dry-run plan is captured into a variable, so under `set -e` a failing compose ended the
// script silently. A failing dry-run must now name its status and print compose's own output. The `docker` here is a stub on PATH
// that answers the service listings the script reads and fails the dry-run the way an unreachable registry does.
import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const script = join(__dirname, '../../../../../../deploy/test-staging-migrations.sh');

describe('deploy/test-staging-migrations.sh compose dry-run failure', () => {
  let bin: string;
  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), 'fake-docker-'));
    const docker = join(bin, 'docker');
    writeFileSync(docker, `#!/usr/bin/env bash
args="$*"
case "$args" in
  *--dry-run*) echo 'fake-registry: manifest unknown' >&2; exit 255 ;;
  *--profile*config*--services*) printf '%s\\n' api-server app-login migrator postgres ;;
  *config*--services*) printf '%s\\n' api-server postgres ;;
  *) exit 99 ;;
esac
`);
    chmodSync(docker, 0o755);
  });
  afterAll(() => rmSync(bin, { recursive: true, force: true }));

  it('exits non-zero and reports the dry-run status and compose output instead of failing silently', () => {
    const run = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('exit status 255');
    expect(run.stderr).toContain('fake-registry: manifest unknown');
  });
});
