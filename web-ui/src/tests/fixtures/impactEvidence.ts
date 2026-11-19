// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type {
  CI,
  EdgeCurrentness,
  ImpactEdge,
  ImpactEnvelope,
  RelationshipReceipt,
} from '../../services/ci.service';

export const ciFixture = (id: string, name: string): CI => ({
  id,
  name,
  type: 'server',
  status: 'active',
  environment: 'production',
  attributes: {},
  tags: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
});

export const edgeFixture = (
  from: string,
  to: string,
  currentness: EdgeCurrentness,
  overrides: Partial<ImpactEdge['evidence']> = {},
  type = 'DEPENDS_ON'
): ImpactEdge => ({
  from,
  to,
  type,
  currentness,
  evidence: {
    classes: ['declared'],
    support: { supports: 1, contradicts: 0 },
    receipt_count: 1,
    receipts_truncated: false,
    last_supported_at: '2026-05-01T10:00:00Z',
    receipts_href: `/api/v1/relationships/evidence?from_id=${from}&to_id=${to}&type=${type}`,
    ...overrides,
  },
});

export const envelopeFixture = (
  edges: ImpactEdge[],
  unreported: string[] = [],
  inScope = 5
): ImpactEnvelope => ({
  basis: 'declared_graph_reachability',
  runtime_blast_radius: 'not_established',
  coverage: {
    ci_nodes_in_scope: inScope,
    unreported_ci_ids: unreported,
    runtime_observed_receipts_in_scope: false,
    note: 'Reachability over declared DEPENDS_ON edges; no runtime observation is in scope.',
  },
  edges,
});

export const receiptFixture = (n: number, overrides: Partial<RelationshipReceipt> = {}): RelationshipReceipt => ({
  receipt_id: `receipt-${n}`,
  evidence_class: 'declared',
  polarity: 'supports',
  source_name: `source-${n}`,
  source_id: null,
  source_version: '1.2.0',
  method: 'api',
  rationale_code: null,
  observed_at: '2026-05-01T10:00:00Z',
  observer: `observer-${n}`,
  observer_type: 'user',
  correlation_id: null,
  ...overrides,
});

export const evidencePage = (
  receipts: RelationshipReceipt[],
  pagination: { total: number; offset: number; limit?: number }
) => ({
  data: {
    success: true,
    data: { from_id: 'x', to_id: 'y', type: 'DEPENDS_ON', receipts },
    pagination: { limit: 20, ...pagination, count: receipts.length },
  },
});
