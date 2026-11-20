// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The operator-CLI child harness itself: its deadline kills a hung child.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runOperatorCli } from '../run-operator-cli';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runOperatorCli deadline', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-operator-cli-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('kills a child that never exits and rejects with the script, the deadline and the stderr so far', async () => {
    const pidFile = join(dir, 'pid');
    const script = join(dir, 'hang.js');
    writeFileSync(script, `
      require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      process.stderr.write('hang-stderr-marker\\n');
      setInterval(() => {}, 1000);
    `);

    const error = await runOperatorCli(script, [], {}, 1500).then(
      () => new Error('resolved'),
      (e: Error) => e,
    );

    expect(error.message).toContain(script);
    expect(error.message).toContain('did not exit within 1500 ms');
    expect(error.message).toContain('hang-stderr-marker');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    for (let i = 0; i < 50 && isAlive(pid); i++) await new Promise(r => setTimeout(r, 20));
    expect(isAlive(pid)).toBe(false);
  });
});
