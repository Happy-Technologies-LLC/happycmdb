// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from 'vitest';
import axios, { AxiosError, type AxiosAdapter, type AxiosInstance } from 'axios';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { attachSession } from '@/lib/session';
import { ForbiddenHost } from './ForbiddenHost';

/** An axios instance with the app's session interceptors whose server answers every call with this 403. */
function clientRefusing(data: unknown): AxiosInstance {
  const adapter: AxiosAdapter = (config) =>
    Promise.reject(
      new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', config, {}, {
        status: 403,
        statusText: 'Forbidden',
        data,
        headers: {},
        config,
      }),
    );
  const client = axios.create({ adapter });
  attachSession(client);
  return client;
}

let go: (to: string) => void = () => undefined;
function Nav() {
  go = useNavigate();
  return null;
}
const mount = () =>
  render(
    <MemoryRouter>
      <Nav />
      <ForbiddenHost />
      <Toaster />
    </MemoryRouter>,
  );

afterEach(cleanup);

describe('a 403 from the server', () => {
  it('a refused read shows the server reason as a banner above the page, and a route change clears it', async () => {
    mount();
    const client = clientRefusing({ _error: 'Forbidden', _message: "Permission 'admin' required" });
    await act(async () => {
      await client.get('/audit').catch(() => undefined);
    });
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Access denied.');
    expect(banner).toHaveTextContent("Permission 'admin' required");

    act(() => go('/elsewhere'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a refused write shows the server reason in a toast and leaves the page free of the banner', async () => {
    mount();
    const client = clientRefusing({ success: false, error: 'Forbidden', message: 'Platform administrator required' });
    let rejected = false;
    await act(async () => {
      await client.post('/jobs/discovery/aws', {}).catch(() => {
        rejected = true;
      });
    });
    expect(rejected).toBe(true); // the caller still sees the failure
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(await screen.findByText('Platform administrator required')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a refused side read shows neither a banner nor a toast, however often it is polled, and the caller still sees the failure', async () => {
    mount();
    const client = clientRefusing({ success: false, error: 'Forbidden', message: 'Platform administrator required' });
    let rejections = 0;
    await act(async () => {
      for (let i = 0; i < 3; i += 1) {
        await client.get('/jobs/discovery', { sideRead: true }).catch(() => {
          rejections += 1;
        });
      }
    });
    expect(rejections).toBe(3);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Platform administrator required')).toBeNull();
    expect(screen.queryByText('Not permitted')).toBeNull();
  });

  it('a side read does not hide a refused primary read: the same page still gets its banner', async () => {
    mount();
    const client = clientRefusing({ success: false, error: 'Forbidden', message: 'Platform administrator required' });
    await act(async () => {
      await client.get('/jobs/discovery', { sideRead: true }).catch(() => undefined);
      await client.get('/audit').catch(() => undefined);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Platform administrator required');
  });

  it('falls back to "Forbidden" when the body carries no reason', async () => {
    mount();
    const client = clientRefusing('');
    await act(async () => {
      await client.get('/anything').catch(() => undefined);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Forbidden');
  });
});
