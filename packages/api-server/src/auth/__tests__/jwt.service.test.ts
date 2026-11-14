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
    expect(jwt.decode(service.generateAccessToken('user-1', 'alice', 'operator'))).not.toHaveProperty('jti');
  });
});
