// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for MetricsAggregator: self-feedback and timer lifecycle
 */

import { MetricsAggregator } from '../../src/processors/metrics-aggregator';
import { EventType } from '../../src/types/events';

jest.mock('@cmdb/database', () => ({
  getPostgresClient: jest.fn(),
  getRedisClient: jest.fn(),
}));

jest.mock('@cmdb/common', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../src/kafka/event-consumer', () => ({
  createEventConsumer: jest.fn(),
}));

jest.mock('../../src/kafka/event-producer', () => ({
  getEventProducer: jest.fn(),
}));

import { getPostgresClient, getRedisClient } from '@cmdb/database';
import { createEventConsumer } from '../../src/kafka/event-consumer';
import { getEventProducer } from '../../src/kafka/event-producer';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

describe('MetricsAggregator', () => {
  let aggregator: MetricsAggregator;
  let postgres: { query: jest.Mock };
  let redisConn: Record<string, jest.Mock>;
  let redis: { getConnection: jest.Mock; set: jest.Mock; get: jest.Mock };
  let producer: { connect: jest.Mock; disconnect: jest.Mock; emit: jest.Mock };
  let consumer: Record<string, jest.Mock>;
  let handlers: Map<string, (event: any) => Promise<void>>;

  beforeEach(() => {
    jest.useFakeTimers();

    postgres = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    redisConn = {
      incrby: jest.fn().mockResolvedValue(1),
      zadd: jest.fn().mockResolvedValue(1),
      zremrangebyscore: jest.fn().mockResolvedValue(0),
      expire: jest.fn().mockResolvedValue(1),
    };
    redis = {
      getConnection: jest.fn().mockReturnValue(redisConn),
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
    };
    producer = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn().mockResolvedValue(undefined),
    };
    handlers = new Map();
    consumer = {
      connect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockResolvedValue(undefined),
      on: jest.fn((type: string, handler: (event: any) => Promise<void>) => {
        handlers.set(type, handler);
      }),
      run: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    (getPostgresClient as jest.Mock).mockReturnValue(postgres);
    (getRedisClient as jest.Mock).mockReturnValue(redis);
    (getEventProducer as jest.Mock).mockReturnValue(producer);
    (createEventConsumer as jest.Mock).mockReturnValue(consumer);

    aggregator = new MetricsAggregator();
  });

  afterEach(async () => {
    // Never leak live intervals into the next test.
    await aggregator.stop();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('aggregates on the minute tick without emitting any connector.* event', async () => {
    const aggregate = jest.spyOn(aggregator as any, 'aggregateMetrics');
    await aggregator.start();

    await jest.advanceTimersByTimeAsync(MINUTE_MS);

    expect(aggregate).toHaveBeenCalledWith('minute');
    const emittedTypes = producer.emit.mock.calls.map((call) => String(call[0]));
    expect(emittedTypes.filter((type) => type.startsWith('connector.'))).toEqual([]);
  });

  describe('connector run handlers', () => {
    beforeEach(async () => {
      await aggregator.start();
    });

    it('ignores a completed event without connector_name', async () => {
      const handler = handlers.get(EventType.CONNECTOR_RUN_COMPLETED)!;

      await expect(
        handler({
          event_type: EventType.CONNECTOR_RUN_COMPLETED,
          window: 'minute',
          window_start: new Date(),
          metrics_count: 3,
        })
      ).resolves.toBeUndefined();

      expect(redisConn.incrby).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
      expect(postgres.query).not.toHaveBeenCalled();
    });

    it('ignores a completed event with a non-finite metric', async () => {
      const handler = handlers.get(EventType.CONNECTOR_RUN_COMPLETED)!;

      await handler({
        event_type: EventType.CONNECTOR_RUN_COMPLETED,
        connector_name: 'github',
        duration_ms: undefined,
        records_extracted: 5,
      });

      expect(redisConn.incrby).not.toHaveBeenCalled();
    });

    it('still records a well-formed completed event', async () => {
      const handler = handlers.get(EventType.CONNECTOR_RUN_COMPLETED)!;

      await handler({
        event_type: EventType.CONNECTOR_RUN_COMPLETED,
        connector_name: 'github',
        duration_ms: 1200,
        records_extracted: 42,
      });

      const keys = redisConn.incrby.mock.calls.map((call) => call[0]);
      expect(keys).toEqual([
        'metrics:counter:connector_runs_total',
        'metrics:counter:connector_runs_success:github',
      ]);
      expect(redis.set).toHaveBeenCalledWith('metrics:gauge:connector_duration:github', '1200');
      expect(redis.set).toHaveBeenCalledWith(
        'metrics:gauge:connector_records_extracted:github',
        '42'
      );
    });

    it('ignores a failed event without connector_name and still records a well-formed one', async () => {
      const handler = handlers.get(EventType.CONNECTOR_RUN_FAILED)!;

      await handler({ event_type: EventType.CONNECTOR_RUN_FAILED, error_message: 'boom' });
      expect(redisConn.incrby).not.toHaveBeenCalled();

      await handler({
        event_type: EventType.CONNECTOR_RUN_FAILED,
        connector_name: 'github',
        error_message: 'boom',
      });
      const keys = redisConn.incrby.mock.calls.map((call) => call[0]);
      expect(keys).toContain('metrics:counter:connector_runs_failed:github');
      expect(keys.filter((key: string) => key.includes('undefined'))).toEqual([]);
    });
  });

  it('stops all periodic aggregation after stop()', async () => {
    await aggregator.start();
    await aggregator.stop();
    postgres.query.mockClear();

    await jest.advanceTimersByTimeAsync(DAY_MS);

    expect(postgres.query).not.toHaveBeenCalled();
  });

  it('keeps exactly three live timers across repeated start()', async () => {
    await aggregator.start();
    await aggregator.start();

    expect(jest.getTimerCount()).toBe(3);
  });
});
