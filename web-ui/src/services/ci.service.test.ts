// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { request, apiClient } = vi.hoisted(() => {
  const request = { get: vi.fn() };
  const apiClient = { ...request, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } };
  return { request, apiClient };
});

vi.mock('axios', () => ({ default: { create: vi.fn(() => apiClient) } }));

import { ciService } from './ci.service';
import { edgeFixture, envelopeFixture } from '../tests/fixtures/impactEvidence';

const analysis = { ci: { id: 'a' }, upstream: [], downstream: [], impact_score: 0, affected_environments: [] };

describe('ciService.getImpactEnvelope normalization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a null envelope for a server that sends none, and getImpactAnalysis still yields data', async () => {
    request.get.mockResolvedValue({ data: { success: true, data: analysis } });

    expect((await ciService.getImpactEnvelope('a')).envelope).toBeNull();
    expect(await ciService.getImpactAnalysis('a')).toEqual(analysis);
  });

  it.each([
    ['null', null],
    ['an object', { 0: 'b' }],
    ['a string', 'b'],
    ['absent', undefined],
  ])('normalizes unreported_ci_ids sent as %s to an empty list', async (_label, value) => {
    const envelope = envelopeFixture([edgeFixture('a', 'b', 'stale')]);
    const coverage = { ...envelope.coverage, unreported_ci_ids: value };
    request.get.mockResolvedValue({ data: { success: true, data: analysis, ...envelope, coverage } });

    const result = await ciService.getImpactEnvelope('a');

    expect(result.envelope?.coverage.unreported_ci_ids).toEqual([]);
    expect(result.envelope?.coverage.ci_nodes_in_scope).toBe(envelope.coverage.ci_nodes_in_scope);
    expect(result.envelope?.edges).toEqual(envelope.edges);
  });

  it.each([
    ['null', null],
    ['an object', { from: 'a' }],
    ['absent', undefined],
  ])('normalizes edges sent as %s to an empty list, keeping the unreported ids', async (_label, value) => {
    const envelope = envelopeFixture([], ['b']);
    request.get.mockResolvedValue({ data: { success: true, data: analysis, ...envelope, edges: value } });

    const result = await ciService.getImpactEnvelope('a');

    expect(result.envelope?.edges).toEqual([]);
    expect(result.envelope?.coverage.unreported_ci_ids).toEqual(['b']);
  });

  it('defaults a missing runtime_blast_radius to not_established', async () => {
    const { runtime_blast_radius: _omit, ...rest } = envelopeFixture([]);
    request.get.mockResolvedValue({ data: { success: true, data: analysis, ...rest } });

    expect((await ciService.getImpactEnvelope('a')).envelope?.runtime_blast_radius).toBe('not_established');
  });
});
