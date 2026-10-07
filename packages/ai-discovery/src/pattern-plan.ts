// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Stored plan JSON replaces executable pattern code. Legacy JavaScript is never evaluated. */
export const UNSUPPORTED_PATTERN_PLAN = 'UNSUPPORTED_PATTERN_PLAN';

export interface DetectionPlan {
  kind: 'detection-v1';
  ports: number[];
  headers: string[];
  endpoints: string[];
  serviceNames: string[];
}

export interface DiscoveryPlan {
  kind: 'discovery-v1';
  name: string;
  category: string;
  serviceType: string;
  endpoints: string[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 64 && value.every(item =>
    typeof item === 'string' && item.length <= 256 && !/[\u0000-\u001f\u007f]/.test(item));
const endpoints = (value: unknown): value is string[] =>
  strings(value) && value.every(item => /^\/(?!\/)[a-zA-Z0-9/_-]*$/.test(item) &&
    !item.split('/').some(segment => ['..', '__proto__', 'constructor', 'prototype'].includes(segment)));
const fields = (value: Record<string, unknown>, expected: string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));

export function parseDetectionPlan(code: string): DetectionPlan {
  let value: unknown;
  try { value = JSON.parse(code); } catch { throw new Error(UNSUPPORTED_PATTERN_PLAN); }
  if (!record(value) || !fields(value, ['kind', 'ports', 'headers', 'endpoints', 'serviceNames']) ||
    value['kind'] !== 'detection-v1' || !Array.isArray(value['ports']) || value['ports'].length > 64 ||
    !value['ports'].every(port => Number.isInteger(port) && port >= 1 && port <= 65535) ||
    !strings(value['headers']) || !endpoints(value['endpoints']) || !strings(value['serviceNames'])) {
    throw new Error(UNSUPPORTED_PATTERN_PLAN);
  }
  return value as unknown as DetectionPlan;
}

export function parseDiscoveryPlan(code: string): DiscoveryPlan {
  let value: unknown;
  try { value = JSON.parse(code); } catch { throw new Error(UNSUPPORTED_PATTERN_PLAN); }
  if (!record(value) || !fields(value, ['kind', 'name', 'category', 'serviceType', 'endpoints']) ||
    value['kind'] !== 'discovery-v1' || !['name', 'category', 'serviceType'].every(key =>
      typeof value[key] === 'string' && (value[key] as string).length > 0 &&
      (value[key] as string).length <= 256 && !/[\u0000-\u001f\u007f]/.test(value[key] as string)) ||
    !endpoints(value['endpoints'])) {
    throw new Error(UNSUPPORTED_PATTERN_PLAN);
  }
  return value as unknown as DiscoveryPlan;
}

export function detectWithPlan(plan: DetectionPlan, scanResult: any): {
  matches: boolean; confidence: number; indicators: string[];
} {
  let confidence = 0;
  const indicators: string[] = [];
  const services = Array.isArray(scanResult?.services) ? scanResult.services : [];
  if (plan.ports.length && services.some((service: any) => plan.ports.includes(service?.port))) {
    confidence += 0.3;
    indicators.push('standard-port');
  }
  const headers = scanResult?.http?.headers;
  if (headers && typeof headers === 'object') {
    for (const header of plan.headers) {
      const key = header.split(':')[0];
      if (Object.hasOwn(headers, key) || Object.hasOwn(headers, key.toLowerCase())) {
        confidence += 0.4;
        indicators.push(`${key}-header`);
      }
    }
  }
  const discoveredEndpoints = scanResult?.http?.endpoints;
  if (Array.isArray(discoveredEndpoints) && plan.endpoints.some(endpoint => discoveredEndpoints.includes(endpoint))) {
    confidence += 0.5;
    indicators.push('known-endpoint');
  }
  const serviceName = typeof services[0]?.service === 'string' ? services[0].service.toLowerCase() : '';
  for (const name of plan.serviceNames) {
    if (serviceName.includes(name.toLowerCase())) {
      confidence += 0.3;
      indicators.push(`${name}-service`);
    }
  }
  return { matches: confidence >= 0.5, confidence: Math.min(confidence, 1), indicators };
}
