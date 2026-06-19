// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import Header from '../common/Header';
import Sidebar from '../common/Sidebar';

interface MainLayoutProps {
  children: React.ReactNode;
}

const MainLayout: React.FC<MainLayoutProps> = ({ children }) => {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-warm font-body text-ink">
      {/* Permanent sidebar (desktop) */}
      <Sidebar variant="permanent" />

      {/* Temporary sidebar (mobile drawer) */}
      <Sidebar variant="temporary" open={mobileOpen} onClose={() => setMobileOpen(false)} />

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <Header onMenuClick={() => setMobileOpen(true)} />
        <main className="flex-1 overflow-y-auto px-5 py-7 md:px-8">{children}</main>
      </div>
    </div>
  );
};

export default MainLayout;
