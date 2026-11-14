// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from 'vitest';
import { AxiosError, type AxiosAdapter } from 'axios';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { apiClient } from '@/services/api';
import { ForbiddenHost } from '@/components/layout/ForbiddenHost';
import { HealthMetrics } from './HealthMetrics';

const original = apiClient.defaults.adapter;
afterEach(() => {
  apiClient.defaults.adapter = original;
  cleanup();
});

describe('HealthMetrics when the server refuses the health read to everyone (403)', () => {
  it('reports the failure in its own panel and leaves the page-level access-denied banner down', async () => {
    const adapter: AxiosAdapter = (config) =>
      Promise.reject(
        new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', config, {}, {
          status: 403,
          statusText: 'Forbidden',
          data: { success: false, error: 'Forbidden' },
          headers: {},
          config,
        }),
      );
    apiClient.defaults.adapter = adapter;

    render(
      <BrowserRouter>
        <ForbiddenHost />
        <HealthMetrics />
      </BrowserRouter>,
    );
    await act(async () => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'server-001' } });
    });

    expect(await screen.findByText('Failed to load data')).toBeInTheDocument();
    expect(screen.queryByText('Access denied.')).toBeNull();
  });
});
