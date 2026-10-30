// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { validators } from '../../src/utils/validators';

const MARKER = 'S8MARKER';
const job = (config: Record<string, unknown>) => ({
  id: 'job-1', provider: 'ssh', method: 'agentless', config, status: 'pending', created_at: '2026-10-29T00:00:00Z',
});

it('validateDiscoveryJob rejects inline config.credentials without echoing the value', () => {
  expect(validators.validateDiscoveryJob(job({ targets: ['10.0.0.5'] })).valid).toBe(true);
  const result = validators.validateDiscoveryJob(job({ targets: ['10.0.0.5'], credentials: { password: MARKER } }));
  expect(result.valid).toBe(false);
  expect(result.error).toMatch(/config\.credentials/);
  expect(JSON.stringify(result)).not.toContain(MARKER);
});
