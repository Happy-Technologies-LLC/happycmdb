// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { apiClient } from '../../services/api';
import { ForbiddenHost } from '../layout/ForbiddenHost';
import { DatabaseSettings } from './DatabaseSettings';

// The real client with its session interceptors; only the network is replaced, so a 403 is reported to the shell
// exactly as in the app.
type Answer = { status: number; data: unknown } | { never: true };
let answers: Answer[] = [];
let requested: string[] = [];

const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  requested.push(`${config.method?.toUpperCase()} ${config.url}`);
  const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
  if ('never' in answer) return new Promise(() => undefined);
  const response = { status: answer.status, statusText: '', data: answer.data, headers: {}, config };
  if (answer.status >= 400) {
    throw new AxiosError(`Request failed with status code ${answer.status}`, 'ERR_BAD_REQUEST', config, {}, response);
  }
  return response;
};

const POSTGRES = {
  name: 'PostgreSQL',
  type: 'postgresql',
  status: 'connected',
  details: { host: 'db.internal', port: 5432, database: 'cmdb_datamart', version: '15.4' },
};

const mount = () =>
  render(
    <BrowserRouter>
      <ForbiddenHost />
      <DatabaseSettings />
    </BrowserRouter>,
  );

beforeEach(() => {
  answers = [];
  requested = [];
  window.history.replaceState({}, '', '/');
  apiClient.defaults.adapter = adapter;
});
afterEach(() => {
  cleanup();
});

describe('DatabaseSettings states', () => {
  it('shows a loading status while the read is in flight, and no rows or empty message', async () => {
    answers = [{ never: true }];
    mount();
    expect(await screen.findByRole('status')).toHaveTextContent('Loading database status');
    expect(screen.queryByText('No database status available.')).toBeNull();
    expect(screen.queryByText(/could not load/i)).toBeNull();
  });

  it('renders each store with its status and only the details the server sent', async () => {
    answers = [{ status: 200, data: { databases: [POSTGRES, { name: 'Redis', type: 'redis', status: 'error', details: {} }] } }];
    mount();
    expect(await screen.findByText('PostgreSQL')).toBeInTheDocument();
    expect(screen.getByText('CONNECTED')).toBeInTheDocument();
    expect(screen.getByText('ERROR')).toBeInTheDocument();
    expect(screen.getByText('db.internal')).toBeInTheDocument();
    expect(screen.getByText('5432')).toBeInTheDocument();
    expect(screen.getByText('15.4')).toBeInTheDocument();
    // Redis sent no details: no label and no value is invented for it (one Host label, from PostgreSQL).
    expect(screen.getAllByText('Host')).toHaveLength(1);
    expect(screen.queryByText('URI')).toBeNull();
    expect(requested).toEqual(['GET /settings/database']);
  });

  it('shows the empty message, not a blank panel or a fabricated row, when the server reports no stores', async () => {
    answers = [{ status: 200, data: { databases: [] } }];
    mount();
    expect(await screen.findByText('No database status available.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('leaves a missing port out instead of showing it as 0', async () => {
    const { port: _port, ...details } = POSTGRES.details;
    answers = [{ status: 200, data: { databases: [{ ...POSTGRES, details }] } }];
    mount();
    expect(await screen.findByText('db.internal')).toBeInTheDocument();
    expect(screen.queryByText('Port')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('shows the server message for a failed read with a retry that reads again', async () => {
    const user = userEvent.setup();
    answers = [
      { status: 500, data: { message: 'Metadata store unreachable' } },
      { status: 200, data: { databases: [POSTGRES] } },
    ];
    mount();
    expect(await screen.findByText('Could not load database status')).toBeInTheDocument();
    expect(screen.getByText('Metadata store unreachable')).toBeInTheDocument();
    expect(screen.queryByText('No database status available.')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('PostgreSQL')).toBeInTheDocument();
    expect(screen.queryByText('Could not load database status')).toBeNull();
    expect(requested).toEqual(['GET /settings/database', 'GET /settings/database']);
  });

  it('on a 403 the shell shows the server reason and the panel says it is not permitted, with no spinner', async () => {
    answers = [{ status: 403, data: { _error: 'Forbidden', _message: "Role 'admin' required" } }];
    window.history.replaceState({}, '', '/settings');
    mount();

    expect(await screen.findByText('No access to database status')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText(/Role 'admin' required/).length).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole('alert')).toHaveTextContent('Access denied.');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
