// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs an operator CLI (a `require.main === module` script) as a real child process: TypeScript sources via
 * ts-source-register.cjs, the Neo4j driver replaced by stub-neo4j-driver.cjs. The child environment is exactly `env`
 * plus PATH, so the ambient variables a test passes are the only ones the CLI can see.
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

/** The six API-server TLS toggles (`API_SERVER_CLIENT_ENV_NAMES`), malformed: any of them read ambiently refuses to start. */
export const MALFORMED_AMBIENT_TLS_ENV = {
  NEO4J_ENCRYPTED: 'bogus', NEO4J_SSL_ENABLED: 'bogus', NEO4J_ENCRYPTION: 'bogus', NEO4J_SSL_TRUST_STRATEGY: 'bogus',
  POSTGRES_SSL_MODE: 'bogus', POSTGRES_SSL_ENABLED: 'bogus',
};

/** Ambient toggles that would turn TLS on and trust every certificate if the CLI read them. */
export const PERMISSIVE_AMBIENT_TLS_ENV = {
  NEO4J_ENCRYPTED: 'true', NEO4J_SSL_TRUST_STRATEGY: 'TRUST_ALL_CERTIFICATES',
};

export function runOperatorCli(script: string, argv: readonly string[], env: Record<string, string>): Promise<CliRun> {
  const { promise, resolve, reject } = Promise.withResolvers<CliRun>();
  const child = spawn(process.execPath, ['-r', REGISTER, '-r', DRIVER_STUB, script, ...argv], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  child.on('error', reject);
  child.on('close', code => {
    const driverConfigs = stderr.split('\n').flatMap(line => {
      const match = CONFIG_LINE.exec(line);
      return match !== null ? [(JSON.parse(match[1]!) as { config: Record<string, unknown> }).config] : [];
    });
    resolve({ code, stdout, stderr, driverConfigs });
  });
  return promise;
}
