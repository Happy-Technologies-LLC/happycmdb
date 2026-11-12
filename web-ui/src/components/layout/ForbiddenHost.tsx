// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { Banner } from '@happy-technologies/design-system';
import { isReadMethod, onForbidden, type ForbiddenEvent } from '@/lib/forbidden';

/**
 * N8 a, F10: shows the server's 403 reason as the server wrote it. A refused write is a toast (the user stays where
 * they are); a refused read is a banner above the page until the route changes.
 */
export function ForbiddenHost() {
  const { pathname } = useLocation();
  const [denied, setDenied] = useState<ForbiddenEvent | null>(null);

  useEffect(
    () =>
      onForbidden((event) => {
        if (isReadMethod(event.method)) setDenied(event);
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
