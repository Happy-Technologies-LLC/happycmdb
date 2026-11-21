// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * TLS settings shared by the operator tools (rotate-user-password, identity-window, backfill, and the loopback test of
 * migrate-legacy-discovery-definitions). Every tool reads its own `CMDB_<TOOL>_*` variables only.
 *
 * Off loopback, an unset TLS setting is refused: it would otherwise mean plaintext (or, for Postgres, an unchecked
 * certificate) to a remote host. Plaintext to a remote host needs an explicit opt-out and logs a warning.
 * Messages carry variable names only, never a value: a URI or file path can be sensitive.
 */

import { readFileSync } from 'fs';
import { isIP } from 'net';

import { logger } from '@cmdb/common';

/** Loopback (127.0.0.0/8, ::1, localhost) or a Unix socket directory: the only hosts that may leave TLS unset. */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('/') || (isIP(host) === 4 && host.startsWith('127.'));
}

export interface OperatorPostgresTls {
  ssl: 'require' | 'verify-full' | false;
  /** Contents of `CMDB_<TOOL>_POSTGRES_SSL_CA_FILE`, present only with `ssl: 'verify-full'`. */
  sslCa?: string;
}

/**
 * `<prefix>_POSTGRES_SSL`: `require`, `verify-full` or `disable`; `<prefix>_POSTGRES_SSL_CA_FILE` (verify-full only)
 * is read here, and a missing, unreadable or empty file refuses to start.
 */
export function resolveOperatorPostgresTls(env: NodeJS.ProcessEnv, prefix: string, host: string): OperatorPostgresTls {
  const sslVariable = `${prefix}_POSTGRES_SSL`;
  const caVariable = `${sslVariable}_CA_FILE`;
  const setting = env[sslVariable];
  if (setting !== undefined && setting !== 'require' && setting !== 'verify-full' && setting !== 'disable') {
    throw new Error(`${sslVariable} must be require, verify-full or disable when set`);
  }
  const loopback = isLoopbackHost(host);
  if (setting === undefined && !loopback) {
    throw new Error(
      `${sslVariable} must be set for a non-loopback host: verify-full (recommended), require, or disable to opt out of TLS`
    );
  }
  const caFile = env[caVariable];
  if (caFile !== undefined) {
    if (setting !== 'verify-full') {
      throw new Error(`${caVariable} needs ${sslVariable}=verify-full`);
    }
    let ca: string;
    try {
      ca = caFile === '' ? '' : readFileSync(caFile, 'utf8');
    } catch {
      throw new Error(`${caVariable} cannot be read`);
    }
    // An empty `ca` makes Node fall back to the public trust store; refuse instead of silently widening trust.
    if (ca.trim() === '') {
      throw new Error(`${caVariable} is empty or not a readable CA bundle`);
    }
    return { ssl: 'verify-full', sslCa: ca };
  }
  if (setting === 'disable' && !loopback) {
    logger.warn(`${sslVariable}=disable: the PostgreSQL connection to a non-loopback host is NOT encrypted`);
  }
  if (setting === 'require' && !loopback) {
    logger.warn(`${sslVariable}=require: the PostgreSQL connection to a non-loopback host does NOT verify the server certificate`);
  }
  return { ssl: setting === 'require' || setting === 'verify-full' ? setting : false };
}

/** Host of an already validated plain `bolt://` or `neo4j://` URI (see `assertPlainNeo4jUri`): no userinfo, path or scheme options. */
function neo4jUriHost(uri: string): string {
  const authority = uri.slice(uri.indexOf('://') + 3);
  return authority.startsWith('[') ? authority.slice(1, authority.indexOf(']')) : authority.replace(/:\d+$/, '');
}

/**
 * `<prefix>_NEO4J_ENCRYPTED`: `true` or `false`. `uri` MUST already have passed `assertPlainNeo4jUri`.
 * Only a direct `bolt://` URI to a loopback host may leave it unset: with the `neo4j://` routing scheme the driver dials
 * the hosts the server's routing table advertises, so `neo4j://localhost` (an SSH tunnel, say) can still send
 * credentials in plaintext to a remote host.
 */
export function resolveOperatorNeo4jEncrypted(env: NodeJS.ProcessEnv, prefix: string, uri: string): boolean {
  const variable = `${prefix}_NEO4J_ENCRYPTED`;
  const setting = env[variable];
  if (setting !== undefined && setting !== 'true' && setting !== 'false') {
    throw new Error(`${variable} must be true or false when set`);
  }
  const directLoopback = uri.startsWith('bolt://') && isLoopbackHost(neo4jUriHost(uri));
  if (setting === undefined && !directLoopback) {
    throw new Error(`${variable} must be set for a non-loopback host or a neo4j:// routing URI: true (recommended), or false to opt out of TLS`);
  }
  if (setting === 'false' && !directLoopback) {
    logger.warn(`${variable}=false: the Neo4j connection to a non-loopback host is NOT encrypted`);
  }
  return setting === 'true';
}

/**
 * The API server's own TLS toggles that `PostgresClient` / `Neo4jClient` read from `process.env`. Every operator tool
 * (rotation, identity window, backfill, seed) defines its connections only through its own `CMDB_*` variables, so it
 * drops all of these before any client exists. A new ambient client variable MUST be added here, once.
 *
 * `NODE_EXTRA_CA_CERTS` is deliberately not in this list: it is a process-level Node setting that only adds trust to
 * the public store, and it is the supported way to trust a private Postgres CA under `verify-full`. Do not add it.
 */
export const API_SERVER_CLIENT_ENV_NAMES: readonly string[] = [
  'POSTGRES_SSL_MODE',
  'POSTGRES_SSL_ENABLED',
  'POSTGRES_SSL_CA_FILE',
  'NEO4J_SSL_ENABLED',
  'NEO4J_ENCRYPTION',
  'NEO4J_ENCRYPTED',
  'NEO4J_SSL_TRUST_STRATEGY',
];

/** Drops the API server's own TLS toggles so only the tool's CMDB_* variables define connections. */
export function isolateOperatorEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of API_SERVER_CLIENT_ENV_NAMES) {
    delete env[name];
  }
}
