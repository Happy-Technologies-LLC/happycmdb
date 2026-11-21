// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ConnectionOptions, PeerCertificate } from 'tls';

import { logger } from '@cmdb/common';

import { PostgresClient } from '../client';

jest.mock('@cmdb/common', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

// HAP-1380: the pool's TLS options come from POSTGRES_SSL_* and must never silently fall back to cleartext.
const VARS = ['NODE_ENV', 'POSTGRES_SSL_MODE', 'POSTGRES_SSL_ENABLED', 'POSTGRES_SSL_CA_FILE'] as const;
const saved = Object.fromEntries(VARS.map(name => [name, process.env[name]]));
const open = (host = 'db.internal') =>
  new PostgresClient({ _host: host, _port: 5432, _database: 'cmdb', _user: 'u', _password: 'p' });

beforeEach(() => {
  VARS.forEach(name => delete process.env[name]);
  jest.clearAllMocks();
});
afterAll(() => VARS.forEach(name => (saved[name] === undefined ? delete process.env[name] : (process.env[name] = saved[name]))));

describe('PostgresClient TLS mode', () => {
  it('refuses an unsupported mode instead of connecting in cleartext', () => {
    process.env['POSTGRES_SSL_MODE'] = 'verify-ca';
    expect(() => open()).toThrow();
  });

  it('refuses an unset mode in production for a remote host, but honours an explicit disable', () => {
    process.env['NODE_ENV'] = 'production';
    expect(() => open()).toThrow();
    process.env['POSTGRES_SSL_MODE'] = 'disable';
    expect(open().pool.options.ssl).toBe(false);
  });

  it('pins verify-full to the configured CA file and to the configured host, IP literals included', () => {
    const caFile = join(mkdtempSync(join(tmpdir(), 'hap1380-')), 'ca.crt');
    writeFileSync(caFile, 'test-ca-pem');
    process.env['POSTGRES_SSL_MODE'] = 'verify-full';
    process.env['POSTGRES_SSL_CA_FILE'] = caFile;
    const ssl = open('10.0.0.5').pool.options.ssl as ConnectionOptions;
    expect(ssl).toMatchObject({ rejectUnauthorized: true, ca: 'test-ca-pem' });
    const localhostCert = { subject: { CN: 'localhost' }, subjectaltname: 'DNS:localhost' } as unknown as PeerCertificate;
    expect(ssl.checkServerIdentity?.('localhost', localhostCert)).toBeDefined();
  });

  it('refuses verify-full with an empty CA file instead of falling back to the public trust store', () => {
    const caFile = join(mkdtempSync(join(tmpdir(), 'hap1380-')), 'ca.crt');
    writeFileSync(caFile, ' \n');
    process.env['POSTGRES_SSL_MODE'] = 'verify-full';
    process.env['POSTGRES_SSL_CA_FILE'] = caFile;
    expect(() => open()).toThrow();
  });

  it('refuses verify-full when POSTGRES_SSL_CA_FILE is missing instead of falling back to the public trust store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hap1380-'));
    try {
      process.env['POSTGRES_SSL_MODE'] = 'verify-full';
      process.env['POSTGRES_SSL_CA_FILE'] = join(dir, 'missing-ca.crt');
      expect(() => open()).toThrow('POSTGRES_SSL_CA_FILE cannot be read (ENOENT)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses verify-full with POSTGRES_SSL_CA_FILE set but empty, naming the variable', () => {
    process.env['POSTGRES_SSL_MODE'] = 'verify-full';
    process.env['POSTGRES_SSL_CA_FILE'] = '';
    expect(() => open()).toThrow('POSTGRES_SSL_CA_FILE is set but empty');
  });

  it.each(['require', 'prefer', 'disable', 'off', 'false'])('refuses POSTGRES_SSL_CA_FILE under POSTGRES_SSL_MODE=%s: the CA would be silently unused', (mode) => {
    process.env['POSTGRES_SSL_MODE'] = mode;
    process.env['POSTGRES_SSL_CA_FILE'] = '/certs/ca.crt';
    expect(() => open()).toThrow(/^POSTGRES_SSL_CA_FILE is set but the PostgreSQL TLS mode is not verify-full/);
  });

  it('refuses POSTGRES_SSL_CA_FILE when the mode is unset or comes from POSTGRES_SSL_ENABLED=on', () => {
    process.env['POSTGRES_SSL_CA_FILE'] = '/certs/ca.crt';
    expect(() => open()).toThrow('POSTGRES_SSL_CA_FILE is set but the PostgreSQL TLS mode is not verify-full');
    process.env['POSTGRES_SSL_ENABLED'] = 'on';
    expect(() => open()).toThrow('POSTGRES_SSL_CA_FILE is set but the PostgreSQL TLS mode is not verify-full');
  });

  it('does not refuse an empty POSTGRES_SSL_CA_FILE under a mode that ignores it', () => {
    process.env['POSTGRES_SSL_MODE'] = 'require';
    process.env['POSTGRES_SSL_CA_FILE'] = '';
    expect(open().pool.options.ssl).toEqual({ rejectUnauthorized: false });
  });

  it.each([' ', '\t\n'])('treats the whitespace-only POSTGRES_SSL_CA_FILE %j like an empty one', (value) => {
    process.env['POSTGRES_SSL_MODE'] = 'verify-full';
    process.env['POSTGRES_SSL_CA_FILE'] = value;
    expect(() => open()).toThrow('POSTGRES_SSL_CA_FILE is set but empty');
  });

  it('names only the variable and the error code when the CA file cannot be read, never the path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hap1380-secret-dir-'));
    try {
      process.env['POSTGRES_SSL_MODE'] = 'verify-full';
      // A directory: readFileSync fails with EISDIR, a different code than a missing file.
      process.env['POSTGRES_SSL_CA_FILE'] = dir;
      let message = '';
      try { open(); } catch (error) { message = (error as Error).message; }
      expect(message).toBe('POSTGRES_SSL_CA_FILE cannot be read (EISDIR)');
      expect(message).not.toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Cleartext by default outside production stays (operator decision pending), but it is an error-level event that
  // says whether the host is local, without logging the host.
  it.each([['localhost', 'local'], ['10.1.2.3', 'non-local'], ['db.secret.example', 'non-local']])(
    'logs an unset mode outside production at error level with the host kind for %s, not the host', (host, hostKind) => {
      process.env['NODE_ENV'] = 'development';
      expect(open(host).pool.options.ssl).toBe(false);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
      const logged = JSON.stringify((logger.error as jest.Mock).mock.calls);
      expect(logged).toContain(hostKind === 'local' ? '"hostKind":"local"' : '"hostKind":"non-local"');
      expect(logged).not.toContain(host);
    });

  it('does not read an empty ambient CA file variable when an explicit CA bundle is given', () => {
    process.env['POSTGRES_SSL_CA_FILE'] = '';
    const ssl = new PostgresClient({
      _host: 'db.internal', _port: 5432, _database: 'cmdb', _user: 'u', _password: 'p', ssl: 'verify-full', sslCa: 'explicit-ca-pem',
    }).pool.options.ssl as ConnectionOptions;
    expect(ssl).toMatchObject({ rejectUnauthorized: true, ca: 'explicit-ca-pem' });
  });

  it('verifies against an explicit CA bundle with rejectUnauthorized, ahead of an ambient CA file', () => {
    process.env['POSTGRES_SSL_CA_FILE'] = '/nonexistent/ambient-ca.pem';
    const ssl = new PostgresClient({
      _host: 'db.internal', _port: 5432, _database: 'cmdb', _user: 'u', _password: 'p', ssl: 'verify-full', sslCa: 'explicit-ca-pem',
    }).pool.options.ssl as ConnectionOptions;
    expect(ssl).toMatchObject({ rejectUnauthorized: true, ca: 'explicit-ca-pem' });
  });

  it('refuses an empty explicit CA bundle instead of falling back to the public trust store', () => {
    expect(() => new PostgresClient({
      _host: 'db.internal', _port: 5432, _database: 'cmdb', _user: 'u', _password: 'p', ssl: 'verify-full', sslCa: ' \n',
    })).toThrow();
  });

  // A CA bundle is trust the caller pinned; a mode that ignores it must fail, not connect unverified.
  it.each(['require', 'prefer', 'disable', false, true] as const)('refuses an explicit CA bundle with ssl %p', (ssl) => {
    expect(() => new PostgresClient({
      _host: 'db.internal', _port: 5432, _database: 'cmdb', _user: 'u', _password: 'p', ssl, sslCa: 'explicit-ca-pem',
    })).toThrow('sslCa needs ssl: verify-full');
  });

  it('refuses an explicit CA bundle when the mode is unset or comes from POSTGRES_SSL_MODE=require', () => {
    const config = { _host: 'db.internal', _port: 5432, _database: 'cmdb', _user: 'u', _password: 'p', sslCa: 'explicit-ca-pem' };
    expect(() => new PostgresClient(config)).toThrow('sslCa needs ssl: verify-full');
    process.env['POSTGRES_SSL_MODE'] = 'require';
    expect(() => new PostgresClient(config)).toThrow('sslCa needs ssl: verify-full');
  });

  it('still accepts an explicit CA bundle when verify-full comes from POSTGRES_SSL_MODE', () => {
    process.env['POSTGRES_SSL_MODE'] = 'verify-full';
    const ssl = new PostgresClient({ _host: 'db.internal', _port: 5432, _database: 'cmdb', _user: 'u', _password: 'p', sslCa: 'explicit-ca-pem' })
      .pool.options.ssl as ConnectionOptions;
    expect(ssl).toMatchObject({ rejectUnauthorized: true, ca: 'explicit-ca-pem' });
  });
});
