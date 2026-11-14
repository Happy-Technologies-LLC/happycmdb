// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1252 S1 (N8 a): surfaces the server's own 403 reason. The server answers a refused request with
 * `{_error, _message}` (requirePermission / requireRole / requireOrganization / requireJwtSession) or
 * `{success:false, error, message}` (requirePlatformAdmin); the web UI shows that text verbatim instead of deciding
 * who may do what. lib/session.ts reports every 403 here; the shell (components/layout/ForbiddenHost.tsx) shows it.
 */

declare module 'axios' {
  interface AxiosRequestConfig {
    /**
     * Marks a GET as a side read: data the page can do without (a recent-jobs widget, a badge). The server may refuse
     * it on its own rules, and that must not read as a refusal of the whole page. A refused side read is not shown
     * by the shell (components/layout/ForbiddenHost.tsx); the caller shows its own failure, if it has one.
     */
    sideRead?: boolean;
  }
}

export interface ForbiddenEvent {
  /** The server's reason, e.g. "Permission 'write' required"; "Forbidden" when the body carried none. */
  reason: string;
  method: string;
  /** The request was marked `sideRead` (AxiosRequestConfig). */
  sideRead: boolean;
  /** `window.location.pathname` when the request was sent; the shell drops a refusal that lands on another page. */
  pathname: string;
}

const FALLBACK = 'Forbidden';

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/** The reason text of a 403 response body. */
export function forbiddenReason(body: unknown): string {
  if (!body || typeof body !== 'object') return FALLBACK;
  const { _message, message, _error, error } = body as Record<string, unknown>;
  return text(_message) ?? text(message) ?? text(_error) ?? text(error) ?? FALLBACK;
}

/** Reads, not writes: a refused primary GET blocks what the page shows, a refused write only the action. */
export const isReadMethod = (method: string): boolean => /^(get|head|options)$/i.test(method);

type Listener = (event: ForbiddenEvent) => void;
const listeners = new Set<Listener>();

/** Subscribes to reported 403s; returns the unsubscribe. */
export function onForbidden(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function reportForbidden(event: ForbiddenEvent): void {
  listeners.forEach((listener) => listener(event));
}
