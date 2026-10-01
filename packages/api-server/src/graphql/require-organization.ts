// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { GraphQLError } from 'graphql';
import type { TokenPayload } from '../auth/types';
import { organizationClaim } from '../middleware/auth.middleware';

/**
 * GraphQL counterpart of AuthMiddleware.requireOrganization(): returns the
 * caller's tenant from the authenticated identity, never from arguments.
 * Throws UNAUTHENTICATED without an identity and FORBIDDEN without a
 * well-formed (UUID) `_organizationId` claim. Call it before any data access.
 */
export function requireGraphQLOrganization(context: { user?: TokenPayload }): string {
  if (!context.user) {
    throw new GraphQLError('Authentication required', {
      extensions: { code: 'UNAUTHENTICATED', http: { status: 401 } },
    });
  }

  const organizationId = organizationClaim(context.user);
  if (organizationId === null) {
    throw new GraphQLError('Organization claim required', {
      extensions: { code: 'FORBIDDEN', http: { status: 403 } },
    });
  }

  return organizationId;
}
