// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * JWT Service
 * Handles JWT token generation and verification
 */

import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import type { ConfigSchema } from '@cmdb/common';
import { TokenPayload, UserRole } from './types';

export class TokenVerificationError extends Error {
  override readonly cause: unknown;

  constructor(readonly reason: 'expired' | 'invalid', cause: unknown) {
    super('Token verification failed');
    this.cause = cause;
  }
}

export class JWTService {
  private secret: string;
  private accessTokenExpiresIn: string;
  private refreshTokenExpiresIn: string;
  private issuer: string;
  private audience: string;

  constructor(config: ConfigSchema['auth']['jwt']) {
    this.secret = config.secret;
    this.accessTokenExpiresIn = String(config.accessTokenExpiresIn);
    this.refreshTokenExpiresIn = String(config.refreshTokenExpiresIn);
    this.issuer = config.issuer;
    this.audience = config.audience;
  }

  /**
   * Generate access token. `organizationId` becomes the `_organizationId`
   * tenant claim (omitted => no claim). AuthService.verifyToken replaces it
   * with the user's current organization on every request. `credentialEpoch`
   * becomes the `_cep` claim: the token is only accepted while it equals the
   * user's current credential generation (HP1-S6).
   */
  generateAccessToken(
    userId: string, username: string, role: UserRole, organizationId?: string, credentialEpoch = 0
  ): string {
    const payload: Omit<TokenPayload, 'iat' | 'exp' | 'iss' | 'aud'> = {
      _userId: userId,
      _username: username,
      _role: role,
      _type: 'access',
      _organizationId: organizationId,
      _cep: credentialEpoch,
    };

    return jwt.sign(payload, this.secret, {
      expiresIn: this.accessTokenExpiresIn as any,
      issuer: this.issuer,
      audience: this.audience,
    });
  }

  /**
   * Generate refresh token. It carries no tenant claim: refreshToken()
   * re-reads the organization from the user record. It carries the
   * credential generation like the access token, and `authTime` as the
   * `_authTime` claim (HAP-1285): the login time, now unless a refresh
   * passes the presented token's own.
   */
  generateRefreshToken(
    userId: string, username: string, role: UserRole, credentialEpoch = 0, authTime = Math.floor(Date.now() / 1000)
  ): string {
    const payload: Omit<TokenPayload, 'iat' | 'exp' | 'iss' | 'aud'> = {
      _userId: userId,
      _username: username,
      _role: role,
      _type: 'refresh',
      _cep: credentialEpoch,
      _authTime: authTime,
    };

    // A unique `jti`: two refresh tokens minted for one user in the same second would otherwise be byte-identical.
    return jwt.sign(payload, this.secret, {
      expiresIn: this.refreshTokenExpiresIn as any,
      issuer: this.issuer,
      audience: this.audience,
      jwtid: randomUUID(),
    });
  }

  /**
   * Verify and decode token
   */
  verifyToken(token: string): TokenPayload {
    try {
      const decoded = jwt.verify(token, this.secret, {
        issuer: this.issuer,
        audience: this.audience,
      }) as TokenPayload;

      return decoded;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new TokenVerificationError('expired', error);
      }
      if (error instanceof jwt.JsonWebTokenError) {
        throw new TokenVerificationError('invalid', error);
      }
      throw error;
    }
  }

  /**
   * Decode token without verification (use with caution)
   */
  decodeToken(token: string): TokenPayload | null {
    try {
      return jwt.decode(token) as TokenPayload;
    } catch {
      return null;
    }
  }

  /**
   * Get token expiration time in seconds
   */
  getTokenExpiresIn(type: 'access' | 'refresh'): number {
    const expiresIn = type === 'access' ? this.accessTokenExpiresIn : this.refreshTokenExpiresIn;

    // Parse time string (e.g., "15m", "7d")
    const match = expiresIn.match(/^(\d+)([smhd])$/);
    if (!match) {
      throw new Error(`Invalid expiration format: ${expiresIn}`);
    }

    const value = parseInt(match[1]!, 10);
    const unit = match[2]!;

    const multipliers: Record<string, number> = {
      s: 1,
      m: 60,
      h: 3600,
      d: 86400,
    };

    return value * (multipliers[unit] ?? 1);
  }
}
