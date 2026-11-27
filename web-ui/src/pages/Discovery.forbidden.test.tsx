// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1252 S1b (review B1): GET /jobs/discovery needs platform admin (jobs.routes.ts), so every other user gets a 403
// on the Discovery landing tab. The page is theirs to use: the shell must not report it as refused.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Toaster } from 'sonner';

// An org admin: signed in, but not a platform administrator.
vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: { role: 'admin' } }) }));

let requests: string[] = [];
let refusePrimary: string | null = null;
let holdDefinitions: Promise<void> | null = null;
let definitionsFail = false;
let definitionsRows: unknown[] = [];

// Plays the server: the real services/api client, with its real attachSession interceptors, talks to this adapter.
const { default: axios } = await import('axios');
axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  const url = String(config.url);
  requests.push(`${config.method} ${url}`);
  const reply = (status: number, data: unknown) => {
    const response = { data, status, statusText: '', headers: {}, config, request: {} };
    if (status < 400) return response;
    throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, {}, response);
  };
  if (url.startsWith('/jobs/discovery')) {
    return reply(403, { success: false, error: 'Forbidden', message: 'Platform administrator required' });
  }
  if (refusePrimary && url.startsWith(refusePrimary)) {
    return reply(403, { _error: 'Forbidden', _message: "Permission 'admin' required" });
  }
  if (url.startsWith('/discovery/definitions')) {
    await holdDefinitions;
    if (definitionsFail) return reply(500, {});
    return reply(200, { success: true, data: definitionsRows });
  }
  return reply(200, { success: true, data: [] });
};
const { Discovery } = await import('./Discovery');
const { ForbiddenHost } = await import('../components/layout/ForbiddenHost');
const { ToastProvider } = await import('../contexts/ToastContext');

const mount = (path = '/discovery') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <ForbiddenHost />
        <Discovery />
        <Toaster />
      </ToastProvider>
    </MemoryRouter>,
  );

beforeEach(() => {
  requests = [];
  refusePrimary = null;
  holdDefinitions = null;
  definitionsFail = false;
  definitionsRows = [];
});
afterEach(cleanup);

describe('Discovery page for a user who is not a platform administrator', () => {
  it('shows no "Access denied" banner on the landing tab or after switching tabs, though /jobs/discovery answers 403', async () => {
    const user = userEvent.setup();
    mount();

    await waitFor(() => expect(requests.some((r) => r.startsWith('get /jobs/discovery'))).toBe(true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByRole('alert')).toBeNull();

    await user.click(screen.getByRole('tab', { name: 'Jobs' }));
    await waitFor(() => expect(requests.filter((r) => r.startsWith('get /jobs/discovery')).length).toBeGreaterThan(1));
    await user.click(screen.getByRole('tab', { name: 'Definitions' }));
    await user.click(screen.getByRole('tab', { name: 'Dashboard' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('still banners a refused primary read on the same page', async () => {
    refusePrimary = '/discovery/definitions';
    const { apiClient } = await import('../services/api');
    mount();
    await act(async () => {
      await apiClient.get('/discovery/definitions').catch(() => undefined);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent("Permission 'admin' required");
  });
});

describe('Discovery definitions tab read states', () => {
  it('a pending first read is "loading", then "no definitions" once it settles empty', async () => {
    let release: () => void = () => undefined;
    holdDefinitions = new Promise<void>((resolve) => {
      release = resolve;
    });
    mount('/discovery?tab=definitions');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByText('No discovery definitions')).toBeNull();
    expect(screen.queryByText(/of 0 definitions/)).toBeNull();
    await act(async () => release());
    expect(await screen.findByText('No discovery definitions')).toBeInTheDocument();
  });

  it('a failed read shows a retryable error, never "no definitions", and retry loads the rows', async () => {
    definitionsFail = true;
    const user = userEvent.setup();
    mount('/discovery?tab=definitions');
    expect(await screen.findByText('Could not load discovery definitions')).toBeInTheDocument();
    expect(screen.queryByText('No discovery definitions')).toBeNull();

    definitionsFail = false;
    definitionsRows = [{ id: 'd1', name: 'lan sweep', provider: 'nmap', is_active: true, schedule: null }];
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('lan sweep')).toBeInTheDocument();
    expect(screen.queryByText('Could not load discovery definitions')).toBeNull();
  });

  it('a refused read says "not permitted" with the server reason, not a generic failure', async () => {
    refusePrimary = '/discovery/definitions';
    mount('/discovery?tab=definitions');
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getAllByText("Permission 'admin' required").length).toBeGreaterThan(1);
    expect(screen.queryByText('Could not load discovery definitions')).toBeNull();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });
});
