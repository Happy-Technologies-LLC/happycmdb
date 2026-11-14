// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

// Built at runtime so the marker is not in the source text.
const MARKER = ['h1280', 'render', 'marker'].join('-');

function Bad(): never {
  throw new Error(`failed for ${MARKER}`);
}

afterEach(() => vi.restoreAllMocks());

describe('ErrorBoundary fallback (HAP-1280)', () => {
  it('shows a fixed message, never the error text, with Try again and Reload buttons', () => {
    // React reports the caught error itself (dev build), and the logger writes the label line.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { container } = render(
      <ErrorBoundary>
        <Bad />
      </ErrorBoundary>,
    );
    expect(container.textContent).not.toContain(MARKER);
    expect(screen.getByText('An unexpected error occurred.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeTruthy();
    // The boundary's own report carries the class only: no logger call contains the marker.
    expect(errors.mock.calls.filter((call) => call[0] === '[ERROR] Render error')).toEqual([
      ['[ERROR] Render error', { errorClass: 'Error' }],
    ]);
  });
});
