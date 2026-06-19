// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock API handlers for testing
 * Using simple vi.mock approach instead of MSW for simplicity
 */

export const mockApiHandlers = {
  // Auth handlers
  login: {
    success: {
      access_token: 'mock-token-12345',
      token_type: 'Bearer',
      expires_in: 3600,
    },
    error: {
      message: 'Invalid username or password',
      statusCode: 401,
    },
  },

  // User handlers
  getCurrentUser: {
    success: {
      id: 'user-1',
      username: 'admin',
      email: 'admin@happycmdb.com',
      role: 'admin',
      created_at: '2024-01-01T00:00:00Z',
    },
  },

  // CI handlers
  getCIs: {
    success: {
      data: [
        {
          id: 'ci-1',
          name: 'web-server-01',
          type: 'server',
          status: 'active',
          environment: 'production',
          description: 'Production web server',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
        },
        {
          id: 'ci-2',
          name: 'db-server-01',
          type: 'database',
          status: 'active',
          environment: 'production',
          description: 'Production database',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
        },
      ],
      total: 2,
      page: 1,
      limit: 10,
    },
    empty: {
      data: [],
      total: 0,
      page: 1,
      limit: 10,
    },
  },

  // Discovery handlers
  triggerDiscoveryJob: {
    success: {
      id: 'job-1',
      provider: 'aws',
      status: 'pending',
      created_at: '2024-01-01T00:00:00Z',
    },
  },
};
