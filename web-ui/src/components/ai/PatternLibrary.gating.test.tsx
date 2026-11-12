// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithQueryClient } from '@/tests/utils/test-utils';
import * as useAIPatternsHook from '@/hooks/useAIPatterns';
import type { AIPattern } from '@/types/ai-patterns';
import { PatternLibrary } from './PatternLibrary';

const auth = vi.hoisted(() => ({ role: 'viewer' }));
vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));

const pattern = (id: string, status: AIPattern['status'], isActive = false) =>
  ({
    patternId: id, name: `${id} pattern`, category: 'web', detectionCode: '', discoveryCode: '', author: 'a',
    confidenceScore: 0.9, status, isActive, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    usageCount: 1, successCount: 1, failureCount: 0,
  }) as AIPattern;

beforeEach(() => {
  vi.spyOn(useAIPatternsHook, 'useAIPatterns').mockReturnValue({
    patterns: [pattern('review', 'review'), pattern('approved', 'approved'), pattern('live', 'active', true), pattern('draft', 'draft')],
    loading: false, error: null, loadPatterns: vi.fn(), getPattern: vi.fn(), deletePattern: vi.fn(),
    submitForReview: vi.fn(), approvePattern: vi.fn(), rejectPattern: vi.fn(), activatePattern: vi.fn(),
    deactivatePattern: vi.fn(), validatePattern: vi.fn(),
  } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const row = (id: string) => screen.getByText(`${id} pattern`).closest('tr') as HTMLElement;

// Server: approve and activate are admin-only; deactivate and delete need write. Every role may view details.
describe('PatternLibrary lifecycle actions by role', () => {
  it('a viewer gets view-details only', () => {
    auth.role = 'viewer';
    renderWithQueryClient(<PatternLibrary />);
    for (const title of ['Approve', 'Activate', 'Deactivate', 'Delete']) {
      expect(screen.queryByTitle(title)).toBeNull();
    }
    expect(within(row('review')).getByTitle('View Details')).toBeInTheDocument();
  });

  it('an operator can deactivate and delete but not approve or activate', () => {
    auth.role = 'operator';
    renderWithQueryClient(<PatternLibrary />);
    expect(within(row('live')).getByTitle('Deactivate')).toBeInTheDocument();
    expect(within(row('draft')).getByTitle('Delete')).toBeInTheDocument();
    expect(within(row('review')).queryByTitle('Approve')).toBeNull();
    expect(within(row('approved')).queryByTitle('Activate')).toBeNull();
  });

  it('an admin sees every action at its matching status', () => {
    auth.role = 'admin';
    renderWithQueryClient(<PatternLibrary />);
    expect(within(row('review')).getByTitle('Approve')).toBeInTheDocument();
    expect(within(row('approved')).getByTitle('Activate')).toBeInTheDocument();
    expect(within(row('live')).getByTitle('Deactivate')).toBeInTheDocument();
    expect(within(row('draft')).getByTitle('Delete')).toBeInTheDocument();
  });
});
