// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { Button, ErrorBoundary as DsErrorBoundary, FullPageState } from '@happy-technologies/design-system';
import { logClientError } from '@/utils/logger';

/** F10: render errors below it show the DS crash state with Retry and Reload; the error is logged. */
export default function ErrorBoundary({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <DsErrorBoundary
      onError={(error) => logClientError('Render error', error)}
      fallback={(error, reset) => (
        <FullPageState
          tone="danger"
          icon="warning-circle"
          title="Something went wrong"
          message={error.message || 'An unexpected error occurred.'}
          className={className}
          action={
            <>
              <Button variant="secondary" icon="arrows-clockwise" onClick={reset}>
                Try again
              </Button>
              <Button onClick={() => window.location.reload()}>Reload page</Button>
            </>
          }
        />
      )}
    >
      {children}
    </DsErrorBoundary>
  );
}
