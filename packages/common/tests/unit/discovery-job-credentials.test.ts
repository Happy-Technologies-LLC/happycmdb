// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { inspect } from 'util';
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

// L1: every shape is refused, not only objects (kills a `Joi.string()` relaxation).
const NUMBER = Number(`${MARKER.length}774`);
it.each([
  ['a string', MARKER], ['a number', NUMBER], ['null', null], ['an empty object', {}], ['an array', [MARKER]],
])('validateDiscoveryJob rejects config.credentials as %s without echoing it', (_shape, credentials) => {
  const result = validators.validateDiscoveryJob(job({ targets: ['10.0.0.5'], credentials }));
  expect(result.valid).toBe(false);
  expect(result.error).toMatch(/config\.credentials/);
  for (const text of [result.error, JSON.stringify(result.details), inspect(result, { depth: null })]) {
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain(String(NUMBER));
  }
});
