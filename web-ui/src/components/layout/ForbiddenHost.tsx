// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { Banner } from '@happy-technologies/design-system';
import { isReadMethod, onForbidden, type ForbiddenEvent } from '@/lib/forbidden';

/**
 * N8 a, F10: shows the server's 403 reason as the server wrote it. A refused write is a toast (the user stays where
 * they are); a refused primary read is a banner above the page until the pathname changes (a 403 that arrives after the user has left the page it was requested on is dropped). A refused side read
 * (`sideRead` on the request) shows nothing here: it does not refuse the page, and the caller that asked reports
 * its own failure (polling would otherwise repeat a toast every interval).
 */
export function ForbiddenHost() {
  const { pathname } = useLocation();
  const [denied, setDenied] = useState<ForbiddenEvent | null>(null);

  useEffect(
    () =>
      onForbidden((event) => {
        if (isReadMethod(event.method)) {
          // A refusal of page A's read that lands after navigating to page B is not B's refusal.
          if (!event.sideRead && event.pathname === window.location.pathname) setDenied(event);
        }
        else toast.error('Not permitted', { description: event.reason });
      }),
    [],
  );
  useEffect(() => setDenied(null), [pathname]);

  if (!denied) return null;
  return (
    <Banner tone="danger" icon="lock-key" className="mb-5">
      <strong className="font-semibold">Access denied.</strong> {denied.reason}
    </Banner>
  );
}
