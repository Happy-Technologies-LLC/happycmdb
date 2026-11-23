// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs an operator CLI (a `require.main === module` script) as a real child process: TypeScript sources via
 * ts-source-register.cjs, the Neo4j driver replaced by stub-neo4j-driver.cjs. The child environment is exactly `env`
 * plus PATH and a refused Redis endpoint, so the ambient variables a test passes are the only ones the CLI can see.
 */

import { spawn } from 'child_process';
import { join } from 'path';

const REGISTER = join(__dirname, 'ts-source-register.cjs');
const DRIVER_STUB = join(__dirname, 'stub-neo4j-driver.cjs');
const CONFIG_LINE = /^neo4j-driver-config (.*)$/;

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The config of every `neo4j.driver(...)` call, in order. */
  driverConfigs: Array<Record<string, unknown>>;
}

/**
 * Every API-server TLS toggle, malformed: any of them read ambiently refuses to start. The seven names are spelled out
 * on purpose, not derived from the guard list under test: a name dropped from the guard leaves its bogus value visible
 * to the CLI, so the child-process tests fail end to end.
 */
export const MALFORMED_AMBIENT_TLS_ENV: Record<string, string> = {
  POSTGRES_SSL_MODE: 'bogus',
  POSTGRES_SSL_ENABLED: 'bogus',
  POSTGRES_SSL_CA_FILE: 'bogus',
  NEO4J_SSL_ENABLED: 'bogus',
  NEO4J_ENCRYPTION: 'bogus',
  NEO4J_ENCRYPTED: 'bogus',
  NEO4J_SSL_TRUST_STRATEGY: 'bogus',
};

/** Ambient toggles that would turn TLS on and trust every certificate if the CLI read them. */
export const PERMISSIVE_AMBIENT_TLS_ENV = {
  NEO4J_ENCRYPTED: 'true', NEO4J_SSL_TRUST_STRATEGY: 'TRUST_ALL_CERTIFICATES',
};

/** Below the 10 s jest timeout of every caller, so a hung child is killed and reported before jest gives up. */
const DEFAULT_DEADLINE_MS = 8000;

/**
 * `REDIS_HOST`/`REDIS_PORT` point at a port nothing listens on: if a CLI ever loaded the `@cmdb/database` barrel, its
 * import-time IORedis connection would be refused instead of reaching a real Redis on localhost:6379. A test can override.
 */
const STRAY_REDIS_ENV = { REDIS_HOST: '127.0.0.1', REDIS_PORT: '1' };

/** Rejects, after SIGKILL of the child, once `deadlineMs` elapse; the message carries the stderr collected so far. */
export function runOperatorCli(
  script: string, argv: readonly string[], env: Record<string, string>, deadlineMs: number = DEFAULT_DEADLINE_MS,
): Promise<CliRun> {
  const { promise, resolve, reject } = Promise.withResolvers<CliRun>();
  const child = spawn(process.execPath, ['-r', REGISTER, '-r', DRIVER_STUB, script, ...argv], {
    env: { PATH: process.env['PATH'] ?? '', ...STRAY_REDIS_ENV, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const started = Date.now();
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error(`${script} did not exit within ${deadlineMs} ms (killed after ${Date.now() - started} ms); stderr so far:\n${stderr}`));
  }, deadlineMs);
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  child.on('error', error => {
    clearTimeout(timer);
    reject(error);
  });
  child.on('close', code => {
    clearTimeout(timer);
    const driverConfigs = stderr.split('\n').flatMap(line => {
      const match = CONFIG_LINE.exec(line);
      return match !== null ? [(JSON.parse(match[1]!) as { config: Record<string, unknown> }).config] : [];
    });
    resolve({ code, stdout, stderr, driverConfigs });
  });
  return promise;
}
