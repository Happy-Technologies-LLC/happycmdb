// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies ServiceNowConnector selects the right axios auth strategy:
 * - oauth2 connection (auth_type + access_token) -> Bearer header, no basic auth
 * - default connection (username/password) -> HTTP basic auth, unchanged
 */
import axios from 'axios';

import ServiceNowConnector from '../../src/index';

jest.mock('axios');

const mockedCreate = axios.create as jest.Mock;

describe('ServiceNowConnector auth selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCreate.mockReturnValue({
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
    });
  });

  it('uses a Bearer Authorization header for an oauth2 connection', () => {
    new ServiceNowConnector({
      name: 'sn-oauth',
      type: 'servicenow',
      enabled: true,
      connection: {
        instance_url: 'https://dev12345.service-now.com',
        auth_type: 'oauth2',
        access_token: 'resolved-bearer-token',
      },
    });

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    const options = mockedCreate.mock.calls[0][0] as {
      auth?: unknown;
      headers: Record<string, string>;
    };
    expect(options.headers['Authorization']).toBe('Bearer resolved-bearer-token');
    expect(options.auth).toBeUndefined();
  });

  it('uses HTTP basic auth for a username/password connection (unchanged)', () => {
    new ServiceNowConnector({
      name: 'sn-basic',
      type: 'servicenow',
      enabled: true,
      connection: {
        instance_url: 'https://dev12345.service-now.com',
        username: 'svc_user',
        password: 'svc_pass',
      },
    });

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    const options = mockedCreate.mock.calls[0][0] as {
      auth?: { username: string; password: string };
      headers: Record<string, string>;
    };
    expect(options.auth).toEqual({ username: 'svc_user', password: 'svc_pass' });
    expect(options.headers['Authorization']).toBeUndefined();
  });

  it('falls back to basic auth when access_token is empty', () => {
    new ServiceNowConnector({
      name: 'sn-empty-token',
      type: 'servicenow',
      enabled: true,
      connection: {
        instance_url: 'https://dev12345.service-now.com',
        auth_type: 'oauth2',
        access_token: '',
        username: 'svc_user',
        password: 'svc_pass',
      },
    });

    const options = mockedCreate.mock.calls[0][0] as {
      auth?: { username: string; password: string };
    };
    expect(options.auth).toEqual({ username: 'svc_user', password: 'svc_pass' });
  });
});
