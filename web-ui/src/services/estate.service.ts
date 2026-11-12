// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1252 S2 (HAP-1916): the reads behind the estate hub that have no service yet. The CI list and the dashboard
 * counts come from services/ci.service.ts. Both reads here are side reads (lib/forbidden.ts): the hub is usable
 * without them, so a 403 on one is shown on its own surface and does not refuse the page.
 */

import { apiClient } from './api';
import { OPEN_INCIDENT_STATUSES, type IncidentRow, type RelationshipRow } from '../lib/estate';

/** The route's cap is 1000; the hub keeps at most SAMPLE_NODE_CAP CIs, so a few hundred edges are plenty. */
export const RELATIONSHIP_LIMIT = 400;

export interface RelationshipPage {
  rows: RelationshipRow[];
  /** Every relationship of the organization, not only the page. */
  total: number;
}

export async function getRelationshipSample(): Promise<RelationshipPage> {
  const { data } = await apiClient.get<{ data: RelationshipRow[]; pagination: { total: number } }>(
    '/relationships',
    {
      params: { limit: RELATIONSHIP_LIMIT },
      sideRead: true,
    }
  );
  return { rows: data.data, total: data.pagination.total };
}

export interface OpenIncidents {
  rows: IncidentRow[];
  /** Every open incident of the organization, not only the rows fetched. */
  total: number;
}

/** Open incidents, newest first within each status. The list route takes one status per request. */
export async function getOpenIncidents(): Promise<OpenIncidents> {
  const pages = await Promise.all(
    OPEN_INCIDENT_STATUSES.map((status) =>
      apiClient.get<{ data: IncidentRow[]; pagination: { total: number } }>('/itil/incidents', {
        params: { status, limit: 20 },
        sideRead: true,
      })
    )
  );
  return {
    rows: pages.flatMap((p) => p.data.data),
    total: pages.reduce((sum, p) => sum + p.data.pagination.total, 0),
  };
}
