// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HappyCMDB Event Streaming Package
 *
 * Kafka-based event streaming for HappyCMDB v3.0
 *
 * @module @cmdb/event-streaming
 * @version 3.0.0
 */

// Event types
export * from './events';

// Producers
export * from './producers';

// Consumers
export * from './consumers';

// Configuration
export * from './config/kafka-config';
export * from './config/topics';

// Utilities
export * from './utils/kafka-client';
export * from './utils/serialization';
export * from './utils/logger';

// Re-export commonly used types
export { Kafka, Producer, Consumer, Admin } from 'kafkajs';
