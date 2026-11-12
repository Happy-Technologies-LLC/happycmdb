// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from './ThemeContext';

type Listener = (event: { matches: boolean }) => void;

/** An OS preference the test can flip; matchMedia in setupTests is a static stub. */
function stubSystemScheme(initial: 'light' | 'dark') {
  let matches = initial === 'dark';
  const listeners = new Set<Listener>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => ({
      get matches() {
        return matches;
      },
      addEventListener: (_: string, fn: Listener) => listeners.add(fn),
      removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
    })),
  );
  return (next: 'light' | 'dark') => {
    matches = next === 'dark';
    act(() => listeners.forEach((fn) => fn({ matches })));
  };
}

function Probe() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button type="button" onClick={toggleTheme}>
      theme:{theme}
    </button>
  );
}

const themed = () => document.querySelector('.hh-theme');

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('ThemeProvider', () => {
  it('first load follows prefers-color-scheme: dark', () => {
    stubSystemScheme('dark');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(themed()).toHaveAttribute('data-theme', 'dark');
    expect(screen.getByRole('button')).toHaveTextContent('theme:dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('first load follows prefers-color-scheme: light', () => {
    stubSystemScheme('light');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(themed()).toHaveAttribute('data-theme', 'light');
  });

  it('a stored choice beats the OS preference', () => {
    stubSystemScheme('dark');
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(themed()).toHaveAttribute('data-theme', 'light');
  });

  it('ignores a stored value that is not a theme', () => {
    stubSystemScheme('dark');
    localStorage.setItem(THEME_STORAGE_KEY, 'solarized');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(themed()).toHaveAttribute('data-theme', 'dark');
  });

  it('persists a toggle and restores it on the next load', async () => {
    stubSystemScheme('light');
    const user = userEvent.setup();
    const first = render(<ThemeProvider><Probe /></ThemeProvider>);
    await user.click(screen.getByRole('button'));
    expect(themed()).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    first.unmount();

    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(themed()).toHaveAttribute('data-theme', 'dark');
  });

  it('follows an OS change until the user has chosen, then stops following', async () => {
    const setSystem = stubSystemScheme('light');
    const user = userEvent.setup();
    render(<ThemeProvider><Probe /></ThemeProvider>);

    setSystem('dark');
    expect(themed()).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    await user.click(screen.getByRole('button')); // choose light explicitly
    expect(themed()).toHaveAttribute('data-theme', 'light');
    setSystem('light');
    setSystem('dark');
    expect(themed()).toHaveAttribute('data-theme', 'light');
  });
});
