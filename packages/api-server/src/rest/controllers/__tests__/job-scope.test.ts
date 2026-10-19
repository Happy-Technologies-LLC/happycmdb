// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type { Job } from 'bullmq';
import { publicJob } from '../job-scope';

it('never exposes old discovery credentials, worker output, or failure text through the job API', async () => {
  const job = {
    id: 'old-job', name: 'discover',
    data: { password: 'secret-marker', sshKey: 'secret-marker' },
    returnvalue: { discovered: 2, credentials: 'secret-marker' },
    failedReason: 'secret-marker',
    attemptsMade: 1, opts: { attempts: 2 }, timestamp: 1,
    getState: async () => 'failed',
  } as unknown as Job;
  const exposed = await publicJob(job, 'discovery-ssh');
  expect(exposed).toMatchObject({ data: { _legacy: true }, returnvalue: { discovered: 2 },
    failedReason: 'ERR_DISCOVERY_FAILED' });
  expect(JSON.stringify(exposed)).not.toContain('secret-marker');

  job.data = { _runId: '11111111-1111-4111-8111-111111111111' };
  job.returnvalue = { discovered: 2, failed: 0 };
  expect(await publicJob(job, 'discovery-ssh')).toMatchObject({
    data: { _runId: '11111111-1111-4111-8111-111111111111' }, returnvalue: { discovered: 2, failed: 0 },
  });
  job.data = { _runId: 'marker-secret' };
  expect(await publicJob(job, 'discovery-ssh')).toMatchObject({ data: { _legacy: true } });
  job.data = { ciIds: ['marker-secret'] };
  job.returnvalue = { _conflictsDetected: 1, _conflicts: [{ name: 'marker-secret' }] };
  expect(await publicJob(job, 'etl-reconciliation')).toMatchObject({
    data: { _legacy: true }, returnvalue: { _conflictsDetected: 1 },
    failedReason: 'ERR_JOB_FAILED',
  });
  expect(JSON.stringify(await publicJob(job, 'etl-reconciliation'))).not.toContain('marker-secret');
});
