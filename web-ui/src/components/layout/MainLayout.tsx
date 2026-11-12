// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AppShell } from '@happy-technologies/design-system';
import ErrorBoundary from '../common/ErrorBoundary';
import LoadingSpinner from '../common/LoadingSpinner';
import { AppRail } from './AppRail';
import { AppTopbar } from './AppTopbar';
import { SectionNav } from './SectionNav';

/** The signed-in frame (N1): DS rail, topbar and the routed screen. Mounted once as the layout route in App.tsx. */
export default function MainLayout() {
  const { pathname } = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => setNavOpen(false), [pathname]);

  return (
    <AppShell
      padded
      sidebar={<AppRail />}
      topbar={<AppTopbar navOpen={navOpen} onToggleNav={() => setNavOpen((open) => !open)} />}
      mobileSidebarOpen={navOpen}
      onMobileSidebarClose={() => setNavOpen(false)}
    >
      <SectionNav />
      {/* Keyed by route: a crashed screen resets on navigation and the shell stays up. */}
      <ErrorBoundary key={pathname}>
        <Suspense fallback={<LoadingSpinner fullScreen={false} />}>
          <Outlet />
        </Suspense>
      </ErrorBoundary>
    </AppShell>
  );
}
