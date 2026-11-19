// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// The AI pattern views read /ai/patterns, /ai/sessions and /ai/analytics/cost. When the server refuses one (403) the
// shell shows its banner (ForbiddenHost) and the view must say, in its own place, that it is not permitted: not a
// spinner, not an empty table, not zeros.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: { role: 'viewer' } }) }));
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => ({}) }));

let refused: string[] = [];

// Plays the server: the real api client, with its real attachSession interceptors, talks to this adapter.
const { default: axios } = await import('axios');
axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  const url = String(config.url);
  const reply = (status: number, data: unknown) => {
    const response = { data, status, statusText: '', headers: {}, config, request: {} };
    if (status < 400) return response;
    throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, {}, response);
  };
  if (refused.some((prefix) => url.startsWith(prefix))) {
    return reply(403, { _error: 'Forbidden', _message: "Permission 'read' required" });
  }
  return reply(200, { success: true, data: [] });
};
const { PatternLibrary } = await import('./PatternLibrary');
const { DiscoverySessionsView } = await import('./DiscoverySessionsView');
const { CostAnalyticsDashboard } = await import('./CostAnalyticsDashboard');
const { PatternLearningOverview } = await import('./PatternLearningOverview');
const { ForbiddenHost } = await import('@/components/layout/ForbiddenHost');
const { ToastProvider } = await import('@/contexts/ToastContext');

const mount = (view: React.ReactElement) =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <ForbiddenHost />
        {view}
      </ToastProvider>
    </MemoryRouter>,
  );

beforeEach(() => {
  refused = [];
});
afterEach(cleanup);

describe('AI pattern views when the server refuses the read', () => {
  it('PatternLibrary says it is not permitted, with the server reason, and shows no table or retry', async () => {
    refused = ['/ai/patterns'];
    mount(<PatternLibrary />);
    expect(await screen.findByText('No access to patterns')).toBeInTheDocument();
    expect(screen.getAllByText("Permission 'read' required").length).toBeGreaterThan(0);
    expect(screen.queryByText('No patterns found')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('DiscoverySessionsView says it is not permitted, with the server reason, and shows no table', async () => {
    refused = ['/ai/sessions'];
    mount(<DiscoverySessionsView />);
    expect(await screen.findByText('No access to discovery sessions')).toBeInTheDocument();
    expect(screen.queryByText('No discovery sessions found')).toBeNull();
  });

  it('CostAnalyticsDashboard says it is not permitted instead of "No cost data available"', async () => {
    refused = ['/ai/analytics/cost'];
    mount(<CostAnalyticsDashboard />);
    expect(await screen.findByText('No access to cost analytics')).toBeInTheDocument();
    expect(screen.queryByText('No cost data available')).toBeNull();
  });

  it('PatternLearningOverview says it is not permitted instead of drawing empty charts', async () => {
    refused = ['/ai/patterns'];
    mount(<PatternLearningOverview />);
    expect(await screen.findByText('No access to pattern learning overview')).toBeInTheDocument();
    expect(screen.queryByText('Total Patterns')).toBeNull();
  });
});
