// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type { Request, Response } from 'express';
import { GraphQLError } from 'graphql';

// No platform-admin identity exists until HP1-S6/P-6. Never infer it from
// tenant roles, API keys, request headers, or organization claims.
export const PLATFORM_ADMIN_UNAVAILABLE = 'Platform administrator access unavailable';

export function denyPlatformAdminRest(_req: Request, res: Response): void {
  res.status(403).json({ success: false, error: PLATFORM_ADMIN_UNAVAILABLE });
}

export function denyPlatformAdminGraphQL(): never {
  throw new GraphQLError(PLATFORM_ADMIN_UNAVAILABLE, { extensions: { code: 'FORBIDDEN' } });
}
