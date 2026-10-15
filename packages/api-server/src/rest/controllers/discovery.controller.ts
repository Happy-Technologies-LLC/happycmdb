// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { queueManager, QUEUE_NAMES } from '@cmdb/database';
import { logger } from '@cmdb/common';

function discoveryQueues(): string[] {
  return [
    QUEUE_NAMES._DISCOVERY_NMAP,
    QUEUE_NAMES._DISCOVERY_SSH,
    'discovery-active-directory',
    'discovery-snmp',
  ];
}
const NOT_FOUND = { success: false, error: 'Not Found', message: 'Discovery job not found' };

// Never spread BullMQ job.data, returnvalue, progress objects, or worker failure text.
interface PublicJobSource {
  id?: string;
  data: { organizationId?: unknown; provider?: unknown };
  returnvalue?: unknown;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  attemptsMade: number;
  progress: unknown;
}
interface PublicDiscoveryJob {
  id?: string;
  status: string;
  provider?: 'nmap' | 'ssh' | 'active-directory' | 'snmp';
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  attemptsMade: number;
  progress?: number | { completed?: number; total?: number; percentage?: number };
  summary?: { discoveredCIs: number };
  failureCode?: string;
}
function publicJob(job: PublicJobSource, status: string): PublicDiscoveryJob {
  const progress = job.progress;
  const counters = progress && typeof progress === 'object' && !Array.isArray(progress)
    ? progress as Record<string, unknown> : null;
  const result = job.returnvalue && typeof job.returnvalue === 'object' && !Array.isArray(job.returnvalue)
    ? job.returnvalue as Record<string, unknown> : null;
  const provider = job.data?.provider;
  return {
    id: job.id,
    status,
    provider: provider === 'nmap' || provider === 'ssh' || provider === 'active-directory' || provider === 'snmp'
      ? provider : undefined,
    timestamp: job.timestamp,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
    attemptsMade: job.attemptsMade,
    progress: typeof progress === 'number' && Number.isFinite(progress) ? progress :
      counters ? {
        completed: typeof counters.completed === 'number' ? counters.completed : undefined,
        total: typeof counters.total === 'number' ? counters.total : undefined,
        percentage: typeof counters.percentage === 'number' ? counters.percentage : undefined,
      } : undefined,
    ...(status === 'completed' && typeof result?.discovered === 'number' &&
      Number.isFinite(result.discovered) && result.discovered >= 0
      ? { summary: { discoveredCIs: result.discovered } } : {}),
    ...(status === 'failed' ? { failureCode: 'DISCOVERY_JOB_FAILED' } : {}),
  };
}

export class DiscoveryController {
  private async findJob(id: string) {
    for (const queueName of discoveryQueues()) {
      const job = await queueManager.getQueue(queueName).getJob(id);
      if (job) return job;
    }
    return null;
  }


  async getJobStatus(req: Request, res: Response): Promise<void> {
    try {
      const job = await this.findJob(req.params.id!);
      if (!job) { res.status(404).json(NOT_FOUND); return; }
      res.json({ success: true, data: publicJob(job, await job.getState()) });
    } catch {
      logger.error('Error getting discovery job status');
      res.status(500).json({ success: false, error: 'Failed to retrieve discovery job' });
    }
  }

  async listJobs(req: Request, res: Response): Promise<void> {
    try {
      const { status, provider, limit = 100, offset = 0 } = req.query;
      const limitNum = Number(limit);
      const offsetNum = Number(offset);
      // Each queue/state read covers only the requested window. Offset is a
      // BullMQ queue-state position, not an exact tenant-wide rank.
      const lastIndex = offsetNum + limitNum - 1;
      const allJobs: PublicDiscoveryJob[] = [];
      for (const queueName of discoveryQueues()) {
        const queue = queueManager.getQueue(queueName);
        const jobs = await Promise.all([
          !status || status === 'pending' ? queue.getWaiting(offsetNum, lastIndex) : [],
          !status || status === 'running' ? queue.getActive(offsetNum, lastIndex) : [],
          !status || status === 'completed' ? queue.getCompleted(offsetNum, lastIndex) : [],
          !status || status === 'failed' ? queue.getFailed(offsetNum, lastIndex) : [],
        ]);
        for (const job of jobs.flat()) {
          if (provider && job.data?.provider !== provider) continue;
          allJobs.push(publicJob(job, await job.getState()));
        }
      }
      allJobs.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
      // A limit applies to each queue/state window, not to the merged result:
      // slicing here would permanently discard jobs from later states.
      res.json({ success: true, data: allJobs, pagination: { count: allJobs.length, offset: offsetNum, limit: limitNum, truncated: true } });
    } catch {
      logger.error('Error listing discovery jobs');
      res.status(500).json({ success: false, error: 'Failed to list discovery jobs' });
    }
  }

  async cancelJob(req: Request, res: Response): Promise<void> {
    try {
      const job = await this.findJob(req.params.id!);
      if (!job) { res.status(404).json(NOT_FOUND); return; }
      const state = await job.getState();
      if (state === 'completed' || state === 'failed') {
        res.status(400).json({ success: false, error: 'Cannot cancel finished discovery job' });
        return;
      }
      await job.remove();
      res.json({ success: true, message: 'Discovery job cancelled successfully', data: { id: job.id, previousState: state } });
    } catch {
      logger.error('Error cancelling discovery job');
      res.status(500).json({ success: false, error: 'Failed to cancel discovery job' });
    }
  }
}
