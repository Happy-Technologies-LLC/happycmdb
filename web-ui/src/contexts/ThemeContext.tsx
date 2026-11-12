// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1252 S1 (N6): light/dark on the design-system tokens.
 *
 * The first load follows `prefers-color-scheme` and keeps following it while the user has not chosen; an explicit
 * choice (the account menu's switch) is stored in localStorage and wins from then on. Only this non-sensitive
 * preference is persisted; the session itself stays memory-only (HAP-1210).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { HappyTheme } from '@happy-technologies/design-system';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'hh-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

const isTheme = (value: unknown): value is Theme => value === 'light' || value === 'dark';

function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : null;
  } catch {
    return null; // storage blocked: the preference lasts for this page load only
  }
}

const systemQuery = (): MediaQueryList | null =>
  typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [chosen, setChosen] = useState<Theme | null>(readStoredTheme);
  const [system, setSystem] = useState<Theme>(() => (systemQuery()?.matches ? 'dark' : 'light'));

  useEffect(() => {
    const query = systemQuery();
    if (!query) return;
    const onChange = (event: MediaQueryListEvent) => setSystem(event.matches ? 'dark' : 'light');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const theme = chosen ?? system;

  // Native controls, scrollbars and overscroll outside the .hh-theme wrapper follow the theme too.
  useEffect(() => {
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setChosen(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // not persisted; still applied
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, toggleTheme: () => setTheme(theme === 'dark' ? 'light' : 'dark') }),
    [theme, setTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      <HappyTheme theme={theme} className="min-h-screen bg-[var(--hh-bg-page)]">
        {children}
      </HappyTheme>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
}
