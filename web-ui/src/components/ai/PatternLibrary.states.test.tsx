// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AIPattern } from '@/services/ai-pattern.service';
import { EMPTY_VALUE } from '@/lib/dashboardValue';
import { PatternLibrary } from './PatternLibrary';

const hook = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/hooks/useAIPatterns', () => ({ useAIPatterns: () => hook.value }));
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => true }));

const pattern = (overrides: Partial<AIPattern> = {}): AIPattern => ({
  patternId: 'pat-1',
  name: 'Nginx Reverse Proxy',
  category: 'web',
  detectionCode: '',
  discoveryCode: '',
  author: 'compiler',
  confidenceScore: 0.9,
  status: 'draft',
  isActive: false,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  usageCount: 10,
  successCount: 8,
  failureCount: 2,
  avgExecutionTimeMs: 120,
  ...overrides,
});

const loadPatterns = vi.fn();
const state = (overrides: Record<string, unknown> = {}) => {
  hook.value = { patterns: [pattern()], loading: false, error: null, loadPatterns, ...overrides };
};

beforeEach(() => {
  loadPatterns.mockReset();
  state();
});
afterEach(cleanup);

describe('PatternLibrary states', () => {
  it('says what is loading while the patterns load, and shows no table', () => {
    state({ loading: true, patterns: [] });
    render(<PatternLibrary />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading patterns');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the empty message with its filters named for a screen reader when there are no patterns', () => {
    state({ patterns: [] });
    render(<PatternLibrary />);
    expect(screen.getByRole('textbox', { name: 'Search patterns' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Filter by status' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Filter by category' })).toBeInTheDocument();
    expect(screen.getByText('No patterns found')).toBeInTheDocument();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  it('shows a failed load with its reason and a retry that reloads, not an empty table', async () => {
    state({ patterns: [], error: 'Failed to load patterns: upstream down' });
    const user = userEvent.setup();
    render(<PatternLibrary />);
    expect(screen.getByText('Could not load patterns')).toBeInTheDocument();
    expect(screen.getByText('Failed to load patterns: upstream down')).toBeInTheDocument();
    expect(screen.queryByText('No patterns found')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(loadPatterns).toHaveBeenCalledTimes(1);
  });
});

describe('PatternLibrary figures', () => {
  const rowOf = () => screen.getByText('Nginx Reverse Proxy').closest('tr') as HTMLElement;

  it('reads a pattern with no timing as unavailable, not 0ms, and a real 0ms as 0ms', () => {
    state({ patterns: [pattern({ avgExecutionTimeMs: undefined })] });
    render(<PatternLibrary />);
    expect(within(rowOf()).queryByText('0ms')).toBeNull();
    expect(within(rowOf()).getByText(EMPTY_VALUE)).toBeInTheDocument();

    cleanup();
    state({ patterns: [pattern({ avgExecutionTimeMs: 0 })] });
    render(<PatternLibrary />);
    expect(within(rowOf()).getByText('0ms')).toBeInTheDocument();
    expect(within(rowOf()).queryByText(EMPTY_VALUE)).toBeNull();
  });

  it('reads a never-used pattern success rate as unavailable, not 0%', () => {
    state({ patterns: [pattern({ usageCount: 0, successCount: 0, failureCount: 0, avgExecutionTimeMs: 50 })] });
    render(<PatternLibrary />);
    expect(within(rowOf()).queryByText('0%')).toBeNull();
    expect(within(rowOf()).getByText(EMPTY_VALUE)).toBeInTheDocument();
  });
});
