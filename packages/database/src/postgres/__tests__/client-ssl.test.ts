// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ConnectionOptions, PeerCertificate } from 'tls';

import { PostgresClient } from '../client';

jest.mock('@cmdb/common', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

// HAP-1380: the pool's TLS options come from POSTGRES_SSL_* and must never silently fall back to cleartext.
const VARS = ['NODE_ENV', 'POSTGRES_SSL_MODE', 'POSTGRES_SSL_ENABLED', 'POSTGRES_SSL_CA_FILE'] as const;
const saved = Object.fromEntries(VARS.map(name => [name, process.env[name]]));
const open = (host = 'db.internal') =>
  new PostgresClient({ _host: host, _port: 5432, _database: 'cmdb', _user: 'u', _password: 'p' });

beforeEach(() => VARS.forEach(name => delete process.env[name]));
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
});
