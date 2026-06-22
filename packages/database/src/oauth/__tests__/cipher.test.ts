// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { resetEncryptionService } from '@cmdb/common';

import { CmdbSecretCipher } from '../cipher';

const KEY = 'unit-test-encryption-key-with-32+-characters';

describe('CmdbSecretCipher', () => {
  beforeAll(() => {
    process.env['CREDENTIAL_ENCRYPTION_KEY'] = KEY;
    resetEncryptionService();
  });

  afterAll(() => {
    delete process.env['CREDENTIAL_ENCRYPTION_KEY'];
    resetEncryptionService();
  });

  it('round-trips a secret and never leaks plaintext into the ciphertext', () => {
    const cipher = new CmdbSecretCipher();
    const plaintext = JSON.stringify({ accessToken: 'sn-access-123', refreshToken: 'sn-refresh-456' });

    const ciphertext = cipher.encrypt(plaintext);

    expect(ciphertext).not.toContain('sn-access-123');
    expect(ciphertext).not.toContain('sn-refresh-456');
    expect(cipher.decrypt(ciphertext)).toBe(plaintext);
  });

  it('produces distinct ciphertext per call (random IV) but decrypts identically', () => {
    const cipher = new CmdbSecretCipher();

    const first = cipher.encrypt('same-secret');
    const second = cipher.encrypt('same-secret');

    expect(first).not.toBe(second);
    expect(cipher.decrypt(first)).toBe('same-secret');
    expect(cipher.decrypt(second)).toBe('same-secret');
  });

  it('rejects ciphertext that is not a valid envelope', () => {
    const cipher = new CmdbSecretCipher();
    const garbage = Buffer.from('not-a-valid-envelope', 'utf8').toString('base64');

    expect(() => cipher.decrypt(garbage)).toThrow();
  });
});
