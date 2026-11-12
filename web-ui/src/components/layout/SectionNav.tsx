// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useLocation, useNavigate } from 'react-router-dom';
import { Tabs } from '@happy-technologies/design-system';
import { matchNav } from './navigation';

/**
 * The other screens of the current rail section, above the page. The rail is an icon rail with no sub-menus, so a
 * section with more than one screen lists them here (a select below `sm`). Nothing renders for an unknown route or a
 * single-screen section.
 */
export function SectionNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const match = matchNav(pathname);
  if (!match || match.section.items.length < 2) return null;
  return (
    <Tabs
      aria-label={`${match.section.label} screens`}
      collapseTo="select"
      collapseLabel={`${match.section.label} screens`}
      className="mb-5"
      value={match.item.path}
      onChange={(path) => navigate(path)}
      options={match.section.items.map((item) => ({ value: item.path, label: item.label }))}
    />
  );
}
