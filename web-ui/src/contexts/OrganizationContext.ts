// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext } from 'react';

/**
 * The signed-in user's organization id, published by AuthProvider. It lives apart from AuthContext so query keys can
 * read it without requiring the whole auth context: outside an AuthProvider, or while signed out, it is null.
 */
export const OrganizationContext = createContext<string | null>(null);

export const useOrganizationId = (): string | null => useContext(OrganizationContext);
