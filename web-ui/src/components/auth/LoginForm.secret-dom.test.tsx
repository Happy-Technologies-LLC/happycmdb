// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1893: the typed login password lives in the input's value property only, never in the DOM tree.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { domLeaks, secretMarker } from '@/tests/utils/secretDom';

const { login } = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ login }) }));

import { LoginForm } from './LoginForm';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LoginForm password field (HAP-1893)', () => {
  it('keeps the typed password out of the DOM tree, masked or revealed, with current-password autofill', () => {
    render(<LoginForm />);
    const marker = secretMarker('login');
    const field = screen.getByPlaceholderText('Enter your password') as HTMLInputElement;
    fireEvent.change(field, { target: { value: marker } });
    // A second edit takes the update path as well as the first commit.
    fireEvent.change(field, { target: { value: `${marker}-more` } });

    expect(field.value).toBe(`${marker}-more`);
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'current-password');
    expect(domLeaks(marker)).toEqual([]);
  });

  it('still keeps the password out of the DOM once the user reveals it', () => {
    const { container } = render(<LoginForm />);
    const marker = secretMarker('login-reveal');
    const field = screen.getByPlaceholderText('Enter your password') as HTMLInputElement;
    fireEvent.change(field, { target: { value: marker } });
    fireEvent.click(screen.getByRole('button', { name: /show password/i }));

    expect(container.querySelector('input[name="password"]')).toHaveAttribute('type', 'text');
    expect(field.value).toBe(marker);
    expect(domLeaks(marker)).toEqual([]);
  });

  it('still submits the typed password to login()', async () => {
    login.mockResolvedValue(undefined);
    render(<LoginForm />);
    const marker = secretMarker('login-submit');
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: marker } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    expect(login).toHaveBeenCalledWith({ username: 'alice', password: marker });
  });
});
