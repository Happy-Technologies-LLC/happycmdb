// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { isReadMethod, onForbidden } from '@/lib/forbidden';

/**
 * The AI hooks (useAIPatterns, useDiscoverySessions) keep a read failure as a message string, which loses the
 * status. The 403 itself is reported by lib/session.ts to lib/forbidden.ts (and shown by ForbiddenHost), so a view
 * learns "the server refused my read" from the same event ForbiddenHost uses, and shows its own plain
 * not-permitted state instead of a blank or a spinner. A refused side read or write is not a refusal of the view.
 *
 * The refusal is page-wide and sticky: any refused primary read on this page marks every AI view that is mounted. That
 * attribution is right only while every AI read shares one gate (ai-pattern.routes.ts `requireOrganization`); a future
 * per-route gate must match the event to the view's own path before reusing this.
 */
export function useReadRefusal(): string | null {
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(
    () =>
      onForbidden((event) => {
        if (isReadMethod(event.method) && !event.sideRead && event.pathname === window.location.pathname) {
          setRefusal(event.reason);
        }
      }),
    [],
  );
  return refusal;
}

/**
 * The `error` for estate/SurfaceState's QueryState: a refused read as the 403 it was (QueryState words it as
 * "No access", with the server's reason), any other failure as an Error carrying the hook's message.
 */
export function readFailure(message: string | null, refusal: string | null): unknown {
  if (refusal !== null) return { response: { status: 403, data: { message: refusal } } };
  return new Error(message ?? 'Request failed');
}
