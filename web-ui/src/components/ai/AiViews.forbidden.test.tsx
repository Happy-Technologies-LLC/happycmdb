// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// The AI pattern views read /ai/patterns, /ai/sessions and /ai/analytics/cost. When the server refuses one (403) the
// shell shows its banner (ForbiddenHost) and the view must say, in its own place, that it is not permitted: not a
// spinner, not an empty table, not zeros.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { act, cleanup, render, screen } from '@testing-library/react';
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
  // A request issued on another page whose refusal lands after the user has come back to this one.
  if (url === '/ai/elsewhere') window.history.pushState({}, '', '/');
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
const { apiClient } = await import('@/lib/api-client');
const { aiPatternService } = await import('@/services/ai-pattern.service');
const { onForbidden } = await import('@/lib/forbidden');

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
afterEach(() => {
  cleanup();
  window.history.pushState({}, '', '/');
});

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

// A 403 only blocks the view when it refuses the view's own read. The server answers 403 to every pattern write
// (denyGlobalPatternWrite), so a refused click must leave the library on screen.
describe('AI pattern views when the server refuses something that is not the view\'s own read', () => {
  const refusals = () => {
    const seen: Array<{ method: string; sideRead: boolean; pathname: string }> = [];
    const off = onForbidden(({ method, sideRead, pathname }) => seen.push({ method, sideRead, pathname }));
    return { seen, off };
  };

  const libraryStaysUp = async () => {
    expect(await screen.findByText('No patterns found')).toBeInTheDocument();
    expect(screen.queryByText('No access to patterns')).toBeNull();
  };

  it('a refused write (delete) does not replace the library with "No access"', async () => {
    refused = ['/ai/patterns/pattern-1'];
    const { seen, off } = refusals();
    mount(<PatternLibrary />);
    await libraryStaysUp();

    await act(async () => {
      await expect(aiPatternService.deletePattern('pattern-1')).rejects.toBeDefined();
    });
    off();
    expect(seen).toEqual([{ method: 'DELETE', sideRead: false, pathname: '/' }]);
    await libraryStaysUp();
  });

  it('a refused side read does not replace the library with "No access"', async () => {
    refused = ['/ai/side'];
    const { seen, off } = refusals();
    mount(<PatternLibrary />);
    await libraryStaysUp();

    await act(async () => {
      await expect(apiClient.get('/ai/side', { sideRead: true })).rejects.toBeDefined();
    });
    off();
    expect(seen).toEqual([{ method: 'GET', sideRead: true, pathname: '/' }]);
    await libraryStaysUp();
  });

  it('a read refused for a request issued on another page does not replace the library with "No access"', async () => {
    refused = ['/ai/elsewhere'];
    const { seen, off } = refusals();
    mount(<PatternLibrary />);
    await libraryStaysUp();

    window.history.pushState({}, '', '/elsewhere');
    await act(async () => {
      await expect(apiClient.get('/ai/elsewhere')).rejects.toBeDefined();
    });
    off();
    expect(seen).toEqual([{ method: 'GET', sideRead: false, pathname: '/elsewhere' }]);
    expect(window.location.pathname).toBe('/');
    await libraryStaysUp();
  });
});
