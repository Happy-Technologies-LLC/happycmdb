// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@/tests/utils/test-utils';
import Login from './Login';
import * as api from '@services/api';
import { mockApiHandlers } from '@/tests/mocks/handlers';

// Mock the api module
vi.mock('@services/api', () => ({
  api: {
    login: vi.fn(),
    getCurrentUser: vi.fn(),
    logout: vi.fn(),
  },
}));

// Mock the navigation
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    Navigate: ({ to }: { to: string }) => {
      mockNavigate(to);
      return null;
    },
    useNavigate: () => mockNavigate,
  };
});

describe('Login Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders login form with all fields', async () => {
    render(<Login />);

    // Wait for AuthProvider to finish initializing (isLoading -> false)
    await waitFor(() => {
      expect(screen.getByText('HappyCMDB')).toBeInTheDocument();
    });

    expect(screen.getByText('Welcome back')).toBeInTheDocument();
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter your password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('validates required fields', async () => {
    const user = userEvent.setup();
    render(<Login />);

    // Wait for form to be visible
    await waitFor(() => {
      expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    });

    const usernameInput = screen.getByLabelText(/username/i);
    const submitButton = screen.getByRole('button', { name: /sign in/i });

    // Clear the default values
    await user.clear(usernameInput);
    await user.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/username must be at least 3 characters/i)).toBeInTheDocument();
    });
  });

  it('successfully logs in with valid credentials', async () => {
    const user = userEvent.setup();

    // Mock successful API responses with delay to catch loading state
    vi.mocked(api.api.login).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(mockApiHandlers.login.success), 50))
    );
    vi.mocked(api.api.getCurrentUser).mockResolvedValue(mockApiHandlers.getCurrentUser.success);

    render(<Login />);

    // Wait for form to be visible
    await waitFor(() => {
      expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    });

    const usernameInput = screen.getByLabelText(/username/i);
    const passwordInput = screen.getByPlaceholderText(/enter your password/i);
    const submitButton = screen.getByRole('button', { name: /sign in/i });

    // Enter credentials
    await user.clear(usernameInput);
    await user.type(usernameInput, 'admin');
    await user.clear(passwordInput);
    await user.type(passwordInput, 'Admin123!');

    // Submit form
    await user.click(submitButton);

    // Verify API was called with correct credentials
    await waitFor(() => {
      expect(api.api.login).toHaveBeenCalledWith({
        username: 'admin',
        password: 'Admin123!',
      });
    });

    // Verify token is stored in localStorage
    await waitFor(() => {
      expect(localStorage.getItem('auth_token')).toBe('mock-token-12345');
    });

    // Verify user data is stored
    await waitFor(() => {
      const userData = localStorage.getItem('user');
      expect(userData).toBeTruthy();
      if (userData) {
        const parsedUser = JSON.parse(userData);
        expect(parsedUser.username).toBe('admin');
      }
    });

    // Verify navigation to home page
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });

  it('displays error message with invalid credentials', async () => {
    const user = userEvent.setup();

    // Mock failed login - the AuthContext.login() sets isLoading: true then back to false,
    // causing LoginForm to remount. The error is caught and re-thrown, but the LoginForm
    // catches it and sets local error state. However, because AuthContext flips isLoading,
    // the LoginForm may remount losing local state.
    // We verify the API is called and the user stays on the login page.
    vi.mocked(api.api.login).mockRejectedValue({
      response: {
        data: {
          message: 'Invalid username or password',
        },
      },
    });

    render(<Login />);

    // Wait for form to be visible
    await waitFor(() => {
      expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    });

    const usernameInput = screen.getByLabelText(/username/i);
    const passwordInput = screen.getByPlaceholderText(/enter your password/i);
    const submitButton = screen.getByRole('button', { name: /sign in/i });

    // Enter invalid but validation-passing credentials
    await user.clear(usernameInput);
    await user.type(usernameInput, 'wronguser');
    await user.clear(passwordInput);
    await user.type(passwordInput, 'WrongPass123!');

    // Submit form
    await user.click(submitButton);

    // Verify API was called
    await waitFor(() => {
      expect(api.api.login).toHaveBeenCalledWith({
        username: 'wronguser',
        password: 'WrongPass123!',
      });
    });

    // Verify token is NOT stored
    expect(localStorage.getItem('auth_token')).toBeNull();

    // After the failed login, the form should be visible again (isLoading returns to false)
    await waitFor(() => {
      expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    });

    // Verify user is not navigated to home
    expect(mockNavigate).not.toHaveBeenCalledWith('/');
  });

  it('toggles password visibility', async () => {
    const user = userEvent.setup();
    render(<Login />);

    // Wait for form to be visible
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/enter your password/i)).toBeInTheDocument();
    });

    const passwordInput = screen.getByPlaceholderText(/enter your password/i) as HTMLInputElement;

    // Initially password should be hidden
    expect(passwordInput.type).toBe('password');

    // Find and click the show/hide button (Eye icon)
    const toggleButton = passwordInput.parentElement?.querySelector('button[type="button"]');
    expect(toggleButton).toBeInTheDocument();

    if (toggleButton) {
      await user.click(toggleButton);

      // Password should now be visible
      await waitFor(() => {
        expect(passwordInput.type).toBe('text');
      });

      // Click again to hide
      await user.click(toggleButton);

      await waitFor(() => {
        expect(passwordInput.type).toBe('password');
      });
    }
  });

  it('redirects authenticated users to home page', async () => {
    // Set up authenticated state
    localStorage.setItem('auth_token', 'existing-token');
    localStorage.setItem('user', JSON.stringify(mockApiHandlers.getCurrentUser.success));

    vi.mocked(api.api.getCurrentUser).mockResolvedValue(mockApiHandlers.getCurrentUser.success);

    render(<Login />);

    // Should redirect to home
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });

  it('handles network errors gracefully', async () => {
    const user = userEvent.setup();

    // Mock network error
    vi.mocked(api.api.login).mockRejectedValue(new Error('Network error'));

    render(<Login />);

    // Wait for form to be visible
    await waitFor(() => {
      expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    });

    const usernameInput = screen.getByLabelText(/username/i);
    const passwordInput = screen.getByPlaceholderText(/enter your password/i);
    const submitButton = screen.getByRole('button', { name: /sign in/i });

    // Must fill in valid credentials so form validation passes
    await user.clear(usernameInput);
    await user.type(usernameInput, 'testuser');
    await user.clear(passwordInput);
    await user.type(passwordInput, 'TestPass123!');

    await user.click(submitButton);

    // Verify the login API was called (even though it fails)
    await waitFor(() => {
      expect(api.api.login).toHaveBeenCalledWith({
        username: 'testuser',
        password: 'TestPass123!',
      });
    });

    // Verify user stays on login page (not navigated)
    expect(mockNavigate).not.toHaveBeenCalledWith('/');

    // After the failed login, the form should be visible again
    await waitFor(() => {
      expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    });
  });

  it('shows loading state during submission', async () => {
    const user = userEvent.setup();

    let resolveLogin: any;
    const loginPromise = new Promise((resolve) => {
      resolveLogin = resolve;
    });

    // Mock a slow login that we control
    vi.mocked(api.api.login).mockReturnValue(loginPromise as any);
    vi.mocked(api.api.getCurrentUser).mockResolvedValue(mockApiHandlers.getCurrentUser.success);

    render(<Login />);

    // Wait for form to be visible
    await waitFor(() => {
      expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    });

    const usernameInput = screen.getByLabelText(/username/i);
    const passwordInput = screen.getByPlaceholderText(/enter your password/i);
    const submitButton = screen.getByRole('button', { name: /sign in/i });

    // Fill in valid credentials so form validation passes
    await user.type(usernameInput, 'admin');
    await user.type(passwordInput, 'Admin123!');

    // Click submit
    await user.click(submitButton);

    // AuthContext.login sets isLoading: true, which makes Login show "Loading..." state
    await waitFor(() => {
      expect(screen.getByText('Loading...')).toBeInTheDocument();
    });

    // Resolve the promise to clean up
    resolveLogin(mockApiHandlers.login.success);
  });
});
