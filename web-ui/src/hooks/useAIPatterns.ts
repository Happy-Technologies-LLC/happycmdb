// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback, useRef } from 'react';
import { aiPatternService, AIPattern, PatternFilters, PatternValidationResult } from '../services/ai-pattern.service';
import { useToast } from '../contexts/ToastContext';
import { useWebSocket } from './useWebSocket';

function isErrorWithResponseMessage(err: unknown): err is { response?: { data?: { message?: string } } } {
  return typeof err === 'object' && err !== null && 'response' in err;
}

function extractErrorMessage(err: unknown, fallback: string): string {
  const responseMessage = isErrorWithResponseMessage(err) ? err.response?.data?.message : undefined;
  const genericMessage = err instanceof Error ? err.message : undefined;
  return responseMessage || genericMessage || fallback;
}

export interface UseAIPatternsReturn {
  patterns: AIPattern[];
  loading: boolean;
  error: string | null;
  loadPatterns: (filters?: PatternFilters) => Promise<void>;
  getPattern: (patternId: string) => Promise<AIPattern | null>;
  deletePattern: (patternId: string) => Promise<boolean>;
  submitForReview: (patternId: string, notes?: string) => Promise<boolean>;
  approvePattern: (patternId: string, notes?: string) => Promise<boolean>;
  rejectPattern: (patternId: string, reason: string) => Promise<boolean>;
  activatePattern: (patternId: string) => Promise<boolean>;
  deactivatePattern: (patternId: string, reason?: string) => Promise<boolean>;
  validatePattern: (patternId: string) => Promise<PatternValidationResult | null>;
}

export const useAIPatterns = (): UseAIPatternsReturn => {
  const [patterns, setPatterns] = useState<AIPattern[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToast();
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadPatterns = useCallback(async (filters?: PatternFilters) => {
    setLoading(true);
    setError(null);
    try {
      const data = await aiPatternService.listPatterns(filters);
      if (mountedRef.current) {
        setPatterns(data);
      }
    } catch (err: unknown) {
      const errorMsg = extractErrorMessage(err, 'Failed to load patterns');
      if (mountedRef.current) {
        setError(errorMsg);
      }
      showToast(errorMsg, 'error');
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [showToast]);

  const getPattern = useCallback(async (patternId: string): Promise<AIPattern | null> => {
    try {
      const pattern = await aiPatternService.getPattern(patternId);
      return pattern;
    } catch (err: unknown) {
      const errorMsg = extractErrorMessage(err, 'Failed to load pattern');
      showToast(errorMsg, 'error');
      return null;
    }
  }, [showToast]);

  const deletePattern = useCallback(async (patternId: string): Promise<boolean> => {
    try {
      await aiPatternService.deletePattern(patternId);
      showToast('Pattern deleted successfully', 'success');
      // Refresh list
      await loadPatterns();
      return true;
    } catch (err: unknown) {
      const errorMsg = extractErrorMessage(err, 'Failed to delete pattern');
      showToast(errorMsg, 'error');
      return false;
    }
  }, [showToast, loadPatterns]);

  const submitForReview = useCallback(async (patternId: string, notes?: string): Promise<boolean> => {
    try {
      const result = await aiPatternService.submitForReview(patternId, notes);
      if (result.success) {
        showToast('Pattern submitted for review', 'success');
        await loadPatterns();
        return true;
      } else {
        showToast(result.error || 'Failed to submit pattern', 'error');
        return false;
      }
    } catch (err: unknown) {
      const errorMsg = extractErrorMessage(err, 'Failed to submit pattern');
      showToast(errorMsg, 'error');
      return false;
    }
  }, [showToast, loadPatterns]);

  const approvePattern = useCallback(async (patternId: string, notes?: string): Promise<boolean> => {
    try {
      const result = await aiPatternService.approvePattern(patternId, notes);
      if (result.success) {
        showToast('Pattern approved', 'success');
        await loadPatterns();
        return true;
      } else {
        showToast(result.error || 'Failed to approve pattern', 'error');
        return false;
      }
    } catch (err: unknown) {
      const errorMsg = extractErrorMessage(err, 'Failed to approve pattern');
      showToast(errorMsg, 'error');
      return false;
    }
  }, [showToast, loadPatterns]);

  const rejectPattern = useCallback(async (patternId: string, reason: string): Promise<boolean> => {
    try {
      const result = await aiPatternService.rejectPattern(patternId, reason);
      if (result.success) {
        showToast('Pattern rejected', 'success');
        await loadPatterns();
        return true;
      } else {
        showToast(result.error || 'Failed to reject pattern', 'error');
        return false;
      }
    } catch (err: unknown) {
      const errorMsg = extractErrorMessage(err, 'Failed to reject pattern');
      showToast(errorMsg, 'error');
      return false;
    }
  }, [showToast, loadPatterns]);

  const activatePattern = useCallback(async (patternId: string): Promise<boolean> => {
    try {
      const result = await aiPatternService.activatePattern(patternId);
      if (result.success) {
        showToast('Pattern activated', 'success');
        await loadPatterns();
        return true;
      } else {
        showToast(result.error || 'Failed to activate pattern', 'error');
        return false;
      }
    } catch (err: unknown) {
      const errorMsg = extractErrorMessage(err, 'Failed to activate pattern');
      showToast(errorMsg, 'error');
      return false;
    }
  }, [showToast, loadPatterns]);

  const deactivatePattern = useCallback(async (patternId: string, reason?: string): Promise<boolean> => {
    try {
      const result = await aiPatternService.deactivatePattern(patternId, reason);
      if (result.success) {
        showToast('Pattern deactivated', 'success');
        await loadPatterns();
        return true;
      } else {
        showToast(result.error || 'Failed to deactivate pattern', 'error');
        return false;
      }
    } catch (err: unknown) {
      const errorMsg = extractErrorMessage(err, 'Failed to deactivate pattern');
      showToast(errorMsg, 'error');
      return false;
    }
  }, [showToast, loadPatterns]);

  const validatePattern = useCallback(async (patternId: string): Promise<PatternValidationResult | null> => {
    try {
      const result = await aiPatternService.validatePattern(patternId);
      if (result.isValid) {
        showToast('Pattern validation passed', 'success');
      } else {
        showToast(`Pattern validation failed: ${result.errors.join(', ')}`, 'error');
      }
      return result;
    } catch (err: unknown) {
      const errorMsg = extractErrorMessage(err, 'Failed to validate pattern');
      showToast(errorMsg, 'error');
      return null;
    }
  }, [showToast]);

  // Load patterns on mount
  useEffect(() => {
    loadPatterns();
  }, [loadPatterns]);

  // WebSocket real-time updates
  useWebSocket({
    onMessage: (message) => {
      if (message.type === 'pattern_update' ||
          message.type === 'pattern_approved' ||
          message.type === 'pattern_learned') {
        // Refresh patterns when updates are received
        loadPatterns();

        // Show notification for new patterns
        if (message.type === 'pattern_learned') {
          showToast('New pattern learned from AI discovery', 'info');
        } else if (message.type === 'pattern_approved') {
          showToast(`Pattern approved by ${message.data.approver}`, 'success');
        }
      }
    },
  });

  return {
    patterns,
    loading,
    error,
    loadPatterns,
    getPattern,
    deletePattern,
    submitForReview,
    approvePattern,
    rejectPattern,
    activatePattern,
    deactivatePattern,
    validatePattern,
  };
};
