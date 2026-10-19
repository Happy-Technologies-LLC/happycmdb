// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import type { Job } from 'bullmq';
import type { Neo4jClient } from '@cmdb/database';

/** Inject one scoped storage read failure into the registered ETL worker. */
export function installETLReadFault(graph: Neo4jClient, job: Job): {
  injected: () => boolean; restore: () => void;
} {
  const since = job.data.incrementalSince;
  const getSession = graph.getSession.bind(graph);
  const sessionFaults: jest.SpyInstance[] = [];
  let injected = false;
  const fault = jest.spyOn(graph, 'getSession').mockImplementation(database => {
    const session = getSession(database);
    const run = session.run.bind(session);
    sessionFaults.push(jest.spyOn(session, 'run').mockImplementation((query, params, config) => {
      const syncRead = job.queueName === 'etl-sync' &&
        typeof query === 'string' && query.startsWith('MATCH (ci:CI)') &&
        !!params && typeof params === 'object' && 'since' in params && params.since === since;
      const refreshRead = job.queueName === 'etl-full-refresh' &&
        typeof query === 'string' && query.includes('ORDER BY ci.created_at');
      if (!injected && (syncRead || refreshRead)) {
        injected = true;
        return Promise.reject(new Error('n18-injected-storage-fault'));
      }
      return run(query, params, config);
    }));
    return session;
  });
  return {
    injected: () => injected,
    restore: () => {
      fault.mockRestore();
      for (const spy of sessionFaults.reverse()) spy.mockRestore();
    },
  };
}
