// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import express from 'express';
import request from 'supertest';

const secret = 'worker-credential-secret';
const queue = {
  getJobCounts: jest.fn(async () => { throw new Error(secret); }),
  isPaused: jest.fn(async () => false),
  getJobLogs: jest.fn(async () => ({ logs: [
    `Connection failed: ${secret}`, 'DEAD_LETTER:ERR_INTERNAL',
    `DEAD_LETTER:ERR_INTERNAL ${secret}`, 'DEAD_LETTER:ERR_NOT_FOUND',
  ], count: 4 })),
};
const manager = {
  getQueueStats: jest.fn(async () => { throw new Error(secret); }),
  getQueue: jest.fn(() => queue),
  getJob: jest.fn(async () => ({ id: 'legacy' })),
};
jest.mock('@cmdb/common', () => ({
  getQueueManager: () => manager,
  QUEUE_NAMES: { _DISCOVERY_NMAP: 'discovery-nmap' },
  logger: { info: jest.fn(), error: jest.fn() },
}));
jest.mock('@cmdb/discovery-engine', () => ({ getDiscoveryWorkerManager: () => ({}) }));
jest.mock('@cmdb/etl-processor', () => ({ getETLWorkerManager: () => ({}) }));

import { QueueController } from '../queue.controller';
const controller = new QueueController();
const app = express();
app.get('/stats', (req, res) => controller.getAllQueueStats(req, res));
app.get('/health', (req, res) => controller.getQueueHealth(req, res));
app.get('/logs/:jobId', (req, res) => controller.getJobLogs(
  { ...req, params: { queueName: 'discovery-nmap', jobId: req.params.jobId } }, res));
beforeEach(() => {
  manager.getQueue.mockImplementation(() => queue);
  manager.getQueueStats.mockRejectedValue(new Error(secret));
  manager.getJob.mockResolvedValue({ id: 'legacy' });
  queue.getJobCounts.mockRejectedValue(new Error(secret));
  queue.getJobLogs.mockResolvedValue({ logs: [
    `Connection failed: ${secret}`, 'DEAD_LETTER:ERR_INTERNAL',
    `DEAD_LETTER:ERR_INTERNAL ${secret}`, 'DEAD_LETTER:ERR_NOT_FOUND',
  ], count: 4 });
});

it('returns coded queue errors rather than exposing worker failure text in aggregate views', async () => {
  const stats = await request(app).get('/stats');
  const health = await request(app).get('/health');
  expect(stats.status).toBe(200);
  expect(stats.body.data.queues).toEqual([{ queueName: 'discovery-nmap', error: 'ERR_QUEUE_UNAVAILABLE' }]);
  expect(health.status).toBe(200);
  expect(health.body.data.queues).toEqual([{
    queueName: 'discovery-nmap', status: 'unhealthy', issues: ['ERR_QUEUE_UNAVAILABLE'],
  }]);
  expect(JSON.stringify([stats.body, health.body])).not.toContain(secret);
});

it('returns only recognized coded events from bounded legacy BullMQ logs', async () => {
  const response = await request(app).get('/logs/legacy');
  expect(response.status).toBe(200);
  expect(response.body.data).toEqual({
    queueName: 'discovery-nmap', jobId: 'legacy',
    logs: ['DEAD_LETTER:ERR_INTERNAL', 'DEAD_LETTER:ERR_NOT_FOUND'], count: 2,
  });
  expect(JSON.stringify(response.body)).not.toContain(secret);
  expect(queue.getJobLogs).toHaveBeenCalledWith('legacy', 0, 99);
});
