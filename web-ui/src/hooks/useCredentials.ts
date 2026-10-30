// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * useCredentials Hook
 * Custom hook for managing discovery credentials
 */

import { useState, useEffect, useCallback } from 'react';
import { credentialService, type UnifiedCredentialSummary } from '../services/credential.service';
import { logClientError } from '../utils/logger';

export interface UseCredentialsReturn {
  credentials: UnifiedCredentialSummary[];
  loading: boolean;
  error: string | null;
  loadCredentials: () => Promise<void>;
}

export const useCredentials = (): UseCredentialsReturn => {
  const [credentials, setCredentials] = useState<UnifiedCredentialSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Load all credentials
   */
  const loadCredentials = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await credentialService.listCredentials();
      setCredentials(data.data || []);
    } catch (err: any) {
      const errorMsg = err.message || 'Failed to load credentials';
      setError(errorMsg);
      logClientError('Failed to load credentials:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Load credentials on mount
   */
  useEffect(() => {
    loadCredentials();
  }, [loadCredentials]);

  return {
    credentials,
    loading,
    error,
    loadCredentials,
  };
};

export default useCredentials;
