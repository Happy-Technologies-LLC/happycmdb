// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ThemeProvider, useTheme, type Theme } from '@/contexts/ThemeContext';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from './alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './dropdown-menu';
import { FormDialog, FormDialogContent, FormDialogDescription, FormDialogTitle } from './form-dialog';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Select, SelectContent, SelectItem, SelectTrigger } from './select';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './sheet';

// Radix Select positions and scrolls with browser APIs jsdom lacks.
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const ID = 'portalled';

const CASES: Array<[string, () => ReactNode]> = [
  [
    'Dialog',
    () => (
      <Dialog open>
        <DialogContent data-testid={ID}>
          <DialogTitle>t</DialogTitle>
          <DialogDescription>d</DialogDescription>
        </DialogContent>
      </Dialog>
    ),
  ],
  [
    'AlertDialog',
    () => (
      <AlertDialog open>
        <AlertDialogContent data-testid={ID}>
          <AlertDialogTitle>t</AlertDialogTitle>
          <AlertDialogDescription>d</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>
    ),
  ],
  [
    'FormDialog',
    () => (
      <FormDialog open>
        <FormDialogContent data-testid={ID}>
          <FormDialogTitle>t</FormDialogTitle>
          <FormDialogDescription>d</FormDialogDescription>
        </FormDialogContent>
      </FormDialog>
    ),
  ],
  [
    'Sheet',
    () => (
      <Sheet open>
        <SheetContent data-testid={ID}>
          <SheetTitle>t</SheetTitle>
          <SheetDescription>d</SheetDescription>
        </SheetContent>
      </Sheet>
    ),
  ],
  [
    'Popover',
    () => (
      <Popover open>
        <PopoverTrigger>open</PopoverTrigger>
        <PopoverContent data-testid={ID}>body</PopoverContent>
      </Popover>
    ),
  ],
  [
    'DropdownMenu',
    () => (
      <DropdownMenu open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent data-testid={ID}>
          <DropdownMenuItem>one</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  ],
  [
    'Select',
    () => (
      <Select open>
        <SelectTrigger>pick</SelectTrigger>
        <SelectContent data-testid={ID}>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>
    ),
  ],
];

let setTheme: (theme: Theme) => void = () => undefined;
function Controls() {
  setTheme = useTheme().setTheme;
  return null;
}

const themedAncestor = (theme: Theme) => screen.getByTestId(ID).closest(`.hh-theme[data-theme='${theme}']`);
const staleAncestor = (theme: Theme) => screen.getByTestId(ID).closest(`[data-theme='${theme}']`);

describe('portalled components/ui primitives render in the active theme', () => {
  it.each(CASES)('%s content sits under the dark theme scope and follows a toggle both ways', (_name, ui) => {
    localStorage.setItem('hh-theme', 'dark');
    render(
      <ThemeProvider>
        <Controls />
        {ui()}
      </ThemeProvider>,
    );
    expect(themedAncestor('dark')).not.toBeNull();

    act(() => setTheme('light'));
    expect(themedAncestor('light')).not.toBeNull();
    expect(staleAncestor('dark')).toBeNull();

    act(() => setTheme('dark'));
    expect(themedAncestor('dark')).not.toBeNull();
    expect(staleAncestor('light')).toBeNull();
  });

  it('removes the portal container when the provider unmounts', () => {
    const { unmount } = render(<ThemeProvider>{null}</ThemeProvider>);
    unmount();
    expect(document.querySelectorAll('.hh-theme')).toHaveLength(0);
  });

  it('still renders without a ThemeProvider, in the document body', () => {
    render(
      <Dialog open>
        <DialogContent data-testid={ID}>
          <DialogTitle>t</DialogTitle>
          <DialogDescription>d</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByTestId(ID)).toBeInTheDocument();
    expect(screen.getByTestId(ID).closest('.hh-theme')).toBeNull();
  });
});
