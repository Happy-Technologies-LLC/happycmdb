// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useLocation, useNavigate } from 'react-router-dom';
import { Button, EmptyState } from '@happy-technologies/design-system';

/** UX5: an unknown address says so instead of silently redirecting to the dashboard. */
export default function NotFound() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return (
    <EmptyState
      icon="compass"
      title="Page not found"
      description={`There is no screen at ${pathname}.`}
      action={
        <Button variant="secondary" icon="squares-four" onClick={() => navigate('/')}>
          Back to dashboard
        </Button>
      }
    />
  );
}
