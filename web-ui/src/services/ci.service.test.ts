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
import { edgeFixture, envelopeFixture, evidencePage, receiptFixture } from '../tests/fixtures/impactEvidence';

const analysis = { ci: { id: 'a' }, upstream: [], downstream: [], impact_score: 0, affected_environments: [] };

describe('ciService impact envelope', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the top-level basis, coverage and edges beside data', async () => {
    const envelope = envelopeFixture([edgeFixture('a', 'b', 'stale')], ['b']);
    request.get.mockResolvedValue({ data: { success: true, data: analysis, ...envelope } });

    const result = await ciService.getImpactEnvelope('a');

    expect(request.get).toHaveBeenCalledWith('/cis/a/impact');
    expect(result.data).toEqual(analysis);
    expect(result.envelope).toEqual(envelope);
  });

  it('returns a null envelope for a server that sends none, and getImpactAnalysis still yields data', async () => {
    request.get.mockResolvedValue({ data: { success: true, data: analysis } });

    expect((await ciService.getImpactEnvelope('a')).envelope).toBeNull();
    expect(await ciService.getImpactAnalysis('a')).toEqual(analysis);
  });
});

describe('ciService.getRelationshipEvidence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requests the exact edge with paging, as a side read, and merges pagination into the page', async () => {
    request.get.mockResolvedValue(evidencePage([receiptFixture(1)], { total: 41, offset: 20 }));

    const page = await ciService.getRelationshipEvidence('from-1', 'to-1', 'DEPENDS_ON', { limit: 20, offset: 20 });

    expect(request.get).toHaveBeenCalledWith('/relationships/evidence', {
      params: { from_id: 'from-1', to_id: 'to-1', type: 'DEPENDS_ON', limit: 20, offset: 20 },
      sideRead: true,
    });
    expect(page.receipts.map((r) => r.receipt_id)).toEqual(['receipt-1']);
    expect(page.pagination).toEqual({ total: 41, count: 1, offset: 20, limit: 20 });
  });
});
