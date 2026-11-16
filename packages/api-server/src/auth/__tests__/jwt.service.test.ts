// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import * as jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { JWTService } from '../jwt.service';

describe('JWTService refresh tokens (HAP-1297)', () => {
  const secret = randomBytes(32).toString('hex');
  const service = new JWTService({
    secret, accessTokenExpiresIn: '15m', refreshTokenExpiresIn: '7d', issuer: 'cmdb-test', audience: 'cmdb-test-api',
  } as never);

  afterEach(() => jest.restoreAllMocks());

  it('two refresh tokens for one user in the same second differ, each with its own jti', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const first = service.generateRefreshToken('user-1', 'alice', 'operator', 3, 1_700_000_000);
    const second = service.generateRefreshToken('user-1', 'alice', 'operator', 3, 1_700_000_000);

    expect(first).not.toBe(second);
    const [a, b] = [service.verifyToken(first), service.verifyToken(second)];
    expect(typeof a.jti).toBe('string');
    expect(a.jti).not.toBe(b.jti);
    const { jti: _a, ...claimsA } = a;
    const { jti: _b, ...claimsB } = b;
    expect(claimsA).toEqual(claimsB);
    expect(claimsA).toEqual({
      _userId: 'user-1', _username: 'alice', _role: 'operator', _type: 'refresh', _cep: 3, _authTime: 1_700_000_000,
      iat: 1_700_000_000, exp: 1_700_000_000 + 7 * 86400, iss: 'cmdb-test', aud: 'cmdb-test-api',
    });
  });

  it('access tokens are unchanged: no jti', () => {
    expect(jwt.decode(service.generateAccessToken('user-1', 'alice', 'operator', undefined, 0, 1_700_000_000))).not.toHaveProperty('jti');
  });
});

describe('JWTService login time (HAP-2077)', () => {
  const secret = randomBytes(32).toString('hex');
  const service = new JWTService({
    secret, accessTokenExpiresIn: '15m', refreshTokenExpiresIn: '7d', issuer: 'cmdb-test', audience: 'cmdb-test-api',
  } as never);

  afterEach(() => jest.restoreAllMocks());

  it('both generators embed exactly the login time passed, not the issue time', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const olderLogin = 1_699_000_000;

    const access = service.verifyToken(service.generateAccessToken('u1', 'alice', 'operator', 'org-1', 4, olderLogin));
    const refresh = service.verifyToken(service.generateRefreshToken('u1', 'alice', 'operator', 4, olderLogin));

    for (const claims of [access, refresh]) {
      expect(claims._authTime).toBe(olderLogin);
      expect(claims.iat).toBe(1_700_000_000);
      expect(claims._authTime).not.toBe(claims.iat);
      expect(claims._cep).toBe(4);
    }
    expect(access._organizationId).toBe('org-1');
  });
});
