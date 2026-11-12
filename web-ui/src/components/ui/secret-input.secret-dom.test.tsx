// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1893: a SecretInput mounted with a value already set (an edit form, a restored draft) shows it in the
// input's value property without mirroring it into the DOM or tripping React's controlled/uncontrolled warning.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { domLeaks, secretMarker } from '@/tests/utils/secretDom';
import { SecretInput, SecretTextarea } from './secret-input';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SecretInput initial value (HAP-1893)', () => {
  it('mounts with a non-empty value: set on .value, absent from the DOM, no React warning', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const marker = secretMarker('initial');
    const onChange = vi.fn();
    const { rerender } = render(
      <SecretInput aria-label="secret" value={marker} onChange={onChange} />
    );
    const field = screen.getByLabelText('secret') as HTMLInputElement;

    expect(field.value).toBe(marker);
    expect(field).toHaveAttribute('type', 'password');
    expect(domLeaks(marker)).toEqual([]);

    // A parent-driven change (controlled semantics) reaches the element too.
    const next = secretMarker('next');
    rerender(<SecretInput aria-label="secret" value={next} onChange={onChange} />);
    expect(field.value).toBe(next);
    expect(domLeaks(next)).toEqual([]);
    expect(domLeaks(marker)).toEqual([]);

    // A parent that rejects the edit gets the controlled value restored.
    fireEvent.change(field, { target: { value: 'rejected' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(field.value).toBe(next);

    expect(errors).not.toHaveBeenCalled();
  });
});

describe('SecretTextarea initial value (HAP-1895)', () => {
  it('mounts with a multi-line value: set on .value, absent from the DOM, restores a rejected edit, no React warning', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const marker = secretMarker('pem-initial');
    const pem = `-----BEGIN PRIVATE KEY-----\n${marker}\n-----END PRIVATE KEY-----`;
    const onChange = vi.fn();
    const { rerender } = render(<SecretTextarea aria-label="secret" value={pem} onChange={onChange} />);
    const field = screen.getByLabelText('secret') as HTMLTextAreaElement;

    expect(field.tagName).toBe('TEXTAREA');
    expect(field.value).toBe(pem);
    expect(field.textContent).toBe('');
    expect(domLeaks(marker)).toEqual([]);

    // A parent-driven change (controlled semantics) reaches the element too.
    const next = secretMarker('pem-next');
    rerender(<SecretTextarea aria-label="secret" value={next} onChange={onChange} />);
    expect(field.value).toBe(next);
    expect(domLeaks(next)).toEqual([]);
    expect(domLeaks(marker)).toEqual([]);

    // A parent that rejects the edit gets the controlled value restored.
    fireEvent.change(field, { target: { value: 'rejected' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(field.value).toBe(next);

    expect(errors).not.toHaveBeenCalled();
  });

  it('forwards a ref to the textarea element', () => {
    const ref = { current: null as HTMLTextAreaElement | null };
    render(<SecretTextarea aria-label="secret" ref={ref} value="v" onChange={() => {}} />);
    expect(ref.current).toBe(screen.getByLabelText('secret'));
  });
});
