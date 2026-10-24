// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-836: the exported health router reads KAFKA_BROKERS through the producer's own parser.
import express from 'express';
import request from 'supertest';
import { Kafka } from 'kafkajs';

jest.mock('kafkajs');
jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => ({ getSession: () => ({ run: async () => ({ records: [] }), close: async () => undefined }) }),
  getPostgresClient: () => ({ query: async () => ({ rows: [{ health: 1 }] }) }),
  getRedisClient: () => ({ set: async () => 'OK', get: async () => 'test' }),
}));

import { healthRoutes } from '../health.routes';

const app = express().use('/health', healthRoutes);
const originalBrokers = process.env['KAFKA_BROKERS'];
const setBrokers = (value: string | undefined) => {
  if (value === undefined) delete process.env['KAFKA_BROKERS'];
  else process.env['KAFKA_BROKERS'] = value;
};
const kafkaHealth = async (brokers: string | undefined) => {
  setBrokers(brokers);
  const res = await request(app).get('/health');
  expect(Kafka).not.toHaveBeenCalled();
  return { status: res.body._status, kafka: res.body._services._kafka };
};
afterEach(() => setBrokers(originalBrokers));

test.each([['absent', undefined], ['empty', ''], ['whitespace-only', ' \t ']])('KAFKA_BROKERS %s reports Kafka not configured, health degraded', async (_label, brokers) => {
  expect(await kafkaHealth(brokers)).toEqual({ status: 'degraded', kafka: { _status: 'unhealthy', _error: 'Kafka brokers not configured' } });
});

test.each([['broker-a:9092,broker-b:9092'], [','], [' broker-a:9092 ']])('configured KAFKA_BROKERS %p keeps Kafka healthy', async (brokers) => {
  expect(await kafkaHealth(brokers)).toEqual({ status: 'ok', kafka: { _status: 'healthy' } });
});
