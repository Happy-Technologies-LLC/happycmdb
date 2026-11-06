// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1444 (AAI S2): read-only client of HappyLab's release registry (Suite Contracts v2 C4) for one organization's
 * bearer principal. It parses only the fields the sync stores (brief §4); every other field of a record is dropped
 * here. Failures are fixed codes: a raw axios error carries the Authorization header, so none is rethrown or logged.
 */
import axios, { type AxiosInstance } from 'axios';

export type C4ErrorCode = 'c4_unavailable' | 'c4_unauthenticated' | 'c4_not_found' | 'c4_invalid_response' | 'c4_snapshot_changed';

export class C4Error extends Error {
  constructor(readonly code: C4ErrorCode) {
    super(code);
    this.name = 'C4Error';
  }
}

/** The stored subset of a C4 `A` record; `status` is any C4 status string (the sync applies its allowlist). */
export interface C4Release {
  release_digest: string;
  name: string;
  version: string | number;
  status: string;
  signed_by: string | null;
  signed_at: string | null;
  config_digest: string;
  instructions_digest: string;
  skill_digests: string[];
  model_pins: { model_id: string; profile: string }[];
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PAGE_LIMIT = 100;
/** A bound on one snapshot's list pages (100 items each), so a looping cursor cannot run a sync forever. */
const MAX_PAGES = 200;

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function parseRelease(raw: unknown): C4Release {
  const r = (raw ?? {}) as Record<string, unknown>;
  const skills = r['skills'];
  const pins = r['model_pins'];
  const nullableText = (value: unknown) => value === null || text(value, 256);
  if (typeof raw !== 'object' || raw === null || !DIGEST.test(String(r['release_digest'])) || !text(r['name'], 500)
    || !(text(r['version'], 128) || Number.isSafeInteger(r['version'])) || !/^[a-z_]{1,32}$/.test(String(r['status']))
    || !nullableText(r['signed_by']) || !nullableText(r['signed_at'])
    || !DIGEST.test(String(r['config_digest'])) || !DIGEST.test(String(r['instructions_digest']))
    || !Array.isArray(skills) || skills.length > 256 || !skills.every(s => DIGEST.test(String(s?.digest)))
    || !Array.isArray(pins) || pins.length > 64 || !pins.every(p => text(p?.model_id, 256) && text(p?.profile, 128))) {
    throw new C4Error('c4_invalid_response');
  }
  return {
    release_digest: r['release_digest'] as string, name: r['name'] as string, version: r['version'] as string | number,
    status: r['status'] as string, signed_by: r['signed_by'] as string | null, signed_at: r['signed_at'] as string | null,
    config_digest: r['config_digest'] as string, instructions_digest: r['instructions_digest'] as string,
    skill_digests: skills.map(s => s.digest as string),
    model_pins: pins.map(p => ({ model_id: p.model_id as string, profile: p.profile as string })),
  };
}

export class C4Client {
  private readonly http: AxiosInstance;

  constructor(baseUrl: string, token: string, timeoutMs = 15_000) {
    this.http = axios.create({ baseURL: baseUrl, timeout: timeoutMs, maxRedirects: 0, validateStatus: () => true,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  }

  private async get(path: string, params?: Record<string, string | number>): Promise<{ status: number; data: unknown }> {
    try {
      const { status, data } = await this.http.get(path, { params });
      if (status === 401 || status === 403) throw new C4Error('c4_unauthenticated');
      return { status, data };
    } catch (error) {
      if (error instanceof C4Error) throw error;
      throw new C4Error('c4_unavailable'); // the axios error (with its request headers) is dropped here
    }
  }

  /** Every approved release of one C4 snapshot: all pages must report the same `as_of`. */
  async listApproved(): Promise<{ asOf: string; items: C4Release[] }> {
    const items: C4Release[] = [];
    let asOf: string | undefined;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { status, data } = await this.get('/v1/releases',
        { status: 'approved', limit: PAGE_LIMIT, ...(cursor === null ? {} : { cursor }) });
      const body = (data ?? {}) as Record<string, unknown>;
      const next = body['next_cursor'];
      if (status !== 200 || !Array.isArray(body['items']) || !(next === null || text(next, 1024))
        || !text(body['as_of'], 64) || !Number.isFinite(Date.parse(body['as_of']))) {
        throw new C4Error(status >= 500 ? 'c4_unavailable' : 'c4_invalid_response');
      }
      if (asOf !== undefined && body['as_of'] !== asOf) throw new C4Error('c4_snapshot_changed');
      asOf = body['as_of'] as string;
      items.push(...body['items'].map(parseRelease));
      if (next === null) return { asOf, items };
      cursor = next as string;
    }
    throw new C4Error('c4_invalid_response');
  }

  /** One release by digest, whatever its status; `c4_not_found` when C4 does not serve it. */
  async getRelease(digest: string): Promise<C4Release> {
    if (!DIGEST.test(digest)) throw new C4Error('c4_invalid_response');
    const { status, data } = await this.get(`/v1/releases/${encodeURIComponent(digest)}`);
    if (status === 404) throw new C4Error('c4_not_found');
    if (status !== 200) throw new C4Error(status >= 500 ? 'c4_unavailable' : 'c4_invalid_response');
    const release = parseRelease(data);
    if (release.release_digest !== digest) throw new C4Error('c4_invalid_response');
    return release;
  }
}
