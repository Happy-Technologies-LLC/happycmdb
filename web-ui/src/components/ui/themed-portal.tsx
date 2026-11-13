// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import * as React from 'react';
import { usePortalContainer } from '@/contexts/ThemeContext';

/**
 * A Radix `Portal` that mounts into the ThemeProvider's themed container instead of document.body, so dialogs,
 * menus, selects and sheets render in the active theme. Outside a ThemeProvider it falls back to Radix's default.
 */
export function themedPortal<P extends { container?: Element | DocumentFragment | null }>(
  Portal: React.ComponentType<P>,
) {
  function ThemedPortal(props: P) {
    const container = usePortalContainer();
    return <Portal container={container} {...props} />;
  }
  ThemedPortal.displayName = `Themed${Portal.displayName ?? 'Portal'}`;
  return ThemedPortal;
}
