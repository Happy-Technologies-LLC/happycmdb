// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the shared EventProducer (getEventProducer singleton).
 *
 * HAP-836: with no KAFKA_BROKERS the producer is disabled at source — no Kafka
 * client, no network, publishes resolve — while a configured broker keeps
 * surfacing connect/send failures exactly as before.
 */

import type { getEventProducer as GetEventProducer } from '../../src/kafka/event-producer';
import { EventType, BaseEvent, CIDiscoveredEvent } from '../../src/types/events';

jest.mock('kafkajs');

jest.mock('@cmdb/common', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

type Logger = Record<'info' | 'warn' | 'error' | 'debug', jest.Mock>;

interface LoadedProducerModule {
  getEventProducer: typeof GetEventProducer;
  Kafka: jest.Mock;
  logger: Logger;
}

/** Fresh module registry per test so the producer singleton never leaks between cases. */
function load(): LoadedProducerModule {
  let loaded!: LoadedProducerModule;
  jest.isolateModules(() => {
    loaded = {
      getEventProducer: require('../../src/kafka/event-producer').getEventProducer,
      Kafka: require('kafkajs').Kafka,
      logger: require('@cmdb/common').logger,
    };
  });
  return loaded;
}

const payload: Omit<CIDiscoveredEvent, keyof BaseEvent> = {
  ci_id: 'ci-1',
  organization_id: 'org-a',
  ci_incarnation_id: 'inc-1',
  ci_name: 'host-1',
  ci_type: 'server',
  source_system: 'test',
  confidence_score: 1,
  identifiers: {},
};
const event: CIDiscoveredEvent = {
  event_id: 'evt-1',
  event_type: EventType.CI_DISCOVERED,
  timestamp: new Date(0),
  source: 'test',
  ...payload,
};

const originalBrokers = process.env['KAFKA_BROKERS'];

function setBrokers(value: string | undefined): void {
  if (value === undefined) {
    delete process.env['KAFKA_BROKERS'];
  } else {
    process.env['KAFKA_BROKERS'] = value;
  }
}

afterEach(() => setBrokers(originalBrokers));

describe.each([
  ['absent', undefined],
  ['empty', ''],
  ['whitespace-only', ' \t '],
])('getEventProducer with KAFKA_BROKERS %s', (_label, brokers) => {
  it('is disabled at source: no Kafka client, publishes resolve, one disabled log', async () => {
    setBrokers(brokers);
    const { getEventProducer, Kafka, logger } = load();

    const producer = getEventProducer();
    expect(Kafka).not.toHaveBeenCalled();

    await expect(producer.connect()).resolves.toBeUndefined();
    await expect(producer.emit<CIDiscoveredEvent>(EventType.CI_DISCOVERED, 'test', payload)).resolves.toEqual([]);
    await expect(producer.emit<CIDiscoveredEvent>(EventType.CI_DISCOVERED, 'test', payload)).resolves.toEqual([]);
    await expect(producer.publishEvent(event)).resolves.toEqual([]);
    await expect(producer.publishBatch([event, event])).resolves.toEqual([]);
    await expect(producer.disconnect()).resolves.toBeUndefined();
    expect(getEventProducer()).toBe(producer);
    expect(Kafka).not.toHaveBeenCalled();

    const logged = [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls];
    expect(logged).toHaveLength(1);
    expect(logged[0][0]).toMatch(/disabled/i);
  });
});

describe('getEventProducer with KAFKA_BROKERS configured', () => {
  it('builds the client from the configured brokers and still surfaces connect and send failures', async () => {
    setBrokers('broker-a:9092,broker-b:9092');
    const { getEventProducer, Kafka, logger } = load();
    const connectError = new Error('connect ECONNREFUSED');
    const sendError = new Error('send failed');
    const kafkaProducer = {
      connect: jest.fn().mockRejectedValueOnce(connectError).mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockRejectedValue(sendError),
    };
    Kafka.mockImplementation(() => ({ producer: jest.fn(() => kafkaProducer) }));

    const producer = getEventProducer();
    expect(Kafka).toHaveBeenCalledTimes(1);
    expect(Kafka).toHaveBeenCalledWith(expect.objectContaining({ brokers: ['broker-a:9092', 'broker-b:9092'] }));

    await expect(producer.emit<CIDiscoveredEvent>(EventType.CI_DISCOVERED, 'test', payload)).rejects.toBe(connectError);
    expect(logger.error).toHaveBeenCalledWith('Failed to connect Kafka producer', { error: connectError });

    await expect(producer.publishEvent(event)).rejects.toBe(sendError);
    await expect(producer.publishBatch([event])).rejects.toBe(sendError);
    expect(logger.error).toHaveBeenCalledWith('Failed to publish event batch', { error: sendError });
    expect(kafkaProducer.connect).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(/disabled/i));
  });
});
