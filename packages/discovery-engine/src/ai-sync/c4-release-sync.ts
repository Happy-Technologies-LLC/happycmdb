// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1444 (AAI S2): one organization's sync of HappyLab C4 releases into agent-release and ai-model CIs (USES),
 * written only through AISyncWriter with that organization's own C4 principal. An approved release is `live`; only an
 * explicit `revoked` retires one (kept, never deleted). Any other status leaves a held CI as it is and creates none
 * (c4_status_refused); a held release C4 no longer serves is left as it is (c4_not_found). The cursor is the listing
 * envelope's `as_of` and advances only after every release was applied.
 */
import type { Queue } from 'bullmq';
import type { Pool } from 'pg';
import { logger } from '@cmdb/common';
import { AISyncCursors, AISyncWriter, UnifiedCredentialService, type Neo4jClient } from '@cmdb/database';
import { C4Client, C4Error, type C4Release } from './c4-client';

export const AI_SYNC_C4_QUEUE = 'ai-sync-c4-releases';
export const C4_FANOUT_JOB = 'c4-releases-fanout';
export const C4_TENANT_JOB = 'c4-releases';
const STREAM = 'c4_releases';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface C4SyncResult {
  success: boolean;
  created: number;
  updated: number;
  unchanged: number;
  retired: number;
  refused: number;
}

/** The fan-out: one tenant job per organization holding a C4 principal. Job data is the organization id only. */
export async function enqueueC4ReleaseSyncs(queue: Pick<Queue, 'add'>,
  credentials: Pick<UnifiedCredentialService, 'listC4PrincipalOrganizations'>): Promise<number> {
  const organizations = await credentials.listC4PrincipalOrganizations();
  for (const organizationId of organizations) {
    await queue.add(C4_TENANT_JOB, { organizationId },
      { jobId: `${C4_TENANT_JOB}:${organizationId}`, removeOnComplete: true, removeOnFail: true });
  }
  return organizations.length;
}

export async function syncC4Releases(organizationId: string, deps: { neo4j: Neo4jClient; pool: Pool; baseUrl: string }):
  Promise<C4SyncResult> {
  if (!UUID.test(organizationId)) throw new Error('syncC4Releases: invalid organization id');
  const cursors = new AISyncCursors(deps.pool);
  const result: C4SyncResult = { success: false, created: 0, updated: 0, unchanged: 0, retired: 0, refused: 0 };
  const principal = await new UnifiedCredentialService(deps.pool).resolveC4Principal(organizationId);
  if ('code' in principal) {
    await cursors.recordError(organizationId, STREAM, principal.code);
    logger.warn('[C4ReleaseSync] not synced', { organizationId, last_error_code: principal.code });
    return result;
  }
  const c4 = new C4Client(deps.baseUrl, principal.token);
  const writer = new AISyncWriter(deps.neo4j);
  let softError: 'c4_status_refused' | 'c4_not_found' | null = null;
  let asOf: string;
  try {
    const listed = await c4.listApproved();
    asOf = listed.asOf;
    const apply = async (release: C4Release) => {
      if (release.status !== 'approved' && release.status !== 'revoked') {
        result.refused++;
        softError ??= 'c4_status_refused';
        return;
      }
      await applyRelease(writer, organizationId, release, asOf, result);
    };
    const seen = new Set<string>();
    for (const release of listed.items) {
      seen.add(release.release_digest);
      await apply(release);
    }
    // A held release absent from the approved list was revoked, moved to another status, or is no longer served.
    for (const digest of await writer.heldKeys(organizationId, 'agent-release')) {
      if (seen.has(digest)) continue;
      try {
        await apply(await c4.getRelease(digest));
      } catch (error) {
        if (!(error instanceof C4Error && error.code === 'c4_not_found')) throw error;
        softError ??= 'c4_not_found';
      }
    }
  } catch (error) {
    if (!(error instanceof C4Error)) throw error;
    await cursors.recordError(organizationId, STREAM, error.code);
    logger.warn('[C4ReleaseSync] not synced', { organizationId, last_error_code: error.code, ...result });
    return result;
  }
  await cursors.advance(organizationId, STREAM, asOf, new Date(asOf), softError);
  result.success = true;
  logger.info('[C4ReleaseSync] synced', { organizationId, c4_as_of: asOf, cursor: asOf, ...result, last_error_code: softError });
  return result;
}

/** One approved or revoked release: its agent-release CI, each pinned ai-model CI and the USES edges. Never a delete. */
async function applyRelease(writer: AISyncWriter, organizationId: string, release: C4Release, asOf: string,
  result: C4SyncResult): Promise<void> {
  const revoked = release.status === 'revoked';
  const { ciId: releaseId, action } = await writer.upsert(organizationId, STREAM, {
    class: 'agent-release', name: release.name, lifecycle: revoked ? 'retired' : 'live',
    attributes: {
      release_digest: release.release_digest, version: release.version, release_status: release.status,
      signed_by: release.signed_by, signed_at: release.signed_at, config_digest: release.config_digest,
      instructions_digest: release.instructions_digest, skill_digests: release.skill_digests, c4_as_of: asOf,
    },
  });
  result[action]++;
  if (revoked && action !== 'unchanged') result.retired++;
  for (const pin of release.model_pins) {
    const model = await writer.upsert(organizationId, STREAM, {
      class: 'ai-model', name: `${pin.model_id} (${pin.profile})`,
      attributes: { model_id: pin.model_id, profile: pin.profile, c4_as_of: asOf },
      createOnly: { first_seen_release: release.release_digest },
    });
    result[model.action]++;
    await writer.link(organizationId, STREAM, releaseId, 'USES', model.ciId);
  }
}
