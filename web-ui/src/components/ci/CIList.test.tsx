// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQueryClient } from '@/tests/utils/test-utils';
import CIList from './CIList';
import * as useCIsHook from '@hooks/useCIs';
import { mockApiHandlers } from '@/tests/mocks/handlers';

// Mock the useCIs hook
vi.mock('@hooks/useCIs');

// Mock navigation
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe('CIList Component', () => {
  const defaultMockData = {
    data: mockApiHandlers.getCIs.success,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
  });

  it('renders CI table with data', async () => {
    vi.mocked(useCIsHook.useCIs).mockReturnValue(defaultMockData);

    renderWithQueryClient(<CIList showActions={true} />);

    // Wait for data to load
    await waitFor(() => {
      expect(screen.getByText('web-server-01')).toBeInTheDocument();
      expect(screen.getByText('db-server-01')).toBeInTheDocument();
    });

    // Verify table headers
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Confidence')).toBeInTheDocument();
  });

  it('displays loading state', () => {
    vi.mocked(useCIsHook.useCIs).mockReturnValue({
      ...defaultMockData,
      isLoading: true,
      data: undefined,
    });

    renderWithQueryClient(<CIList />);

    // Should show loading spinner
    const spinner = screen.getByRole('table').querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('displays error state', () => {
    const errorMessage = 'Failed to load CIs';
    vi.mocked(useCIsHook.useCIs).mockReturnValue({
      ...defaultMockData,
      isLoading: false,
      error: new Error(errorMessage),
      data: undefined,
    });

    renderWithQueryClient(<CIList />);

    expect(screen.getByText(/error loading cis/i)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(errorMessage, 'i'))).toBeInTheDocument();
  });

  it('displays empty state when no CIs found', () => {
    vi.mocked(useCIsHook.useCIs).mockReturnValue({
      ...defaultMockData,
      data: mockApiHandlers.getCIs.empty,
    });

    renderWithQueryClient(<CIList />);

    expect(screen.getByText('No configuration items match this filter.')).toBeInTheDocument();
  });

  it('filters CIs by search term', async () => {
    const user = userEvent.setup();
    const mockUseCIs = vi.fn().mockReturnValue(defaultMockData);
    vi.mocked(useCIsHook.useCIs).mockImplementation(mockUseCIs);

    renderWithQueryClient(<CIList />);

    const searchInput = screen.getByPlaceholderText('Search items…');

    // Type in search
    await user.type(searchInput, 'web-server');

    // Verify search term is in input
    expect(searchInput).toHaveValue('web-server');

    // Wait for debounce and verify hook is called with search parameter
    await waitFor(
      () => {
        const lastCall = mockUseCIs.mock.calls[mockUseCIs.mock.calls.length - 1];
        expect(lastCall[0].search).toBe('web-server');
      },
      { timeout: 1000 }
    );
  });

  it('filters CIs by type', async () => {
    const user = userEvent.setup();
    const mockUseCIs = vi.fn().mockReturnValue(defaultMockData);
    vi.mocked(useCIsHook.useCIs).mockImplementation(mockUseCIs);

    renderWithQueryClient(<CIList />);

    // Find the type filter dropdown
    const typeFilter = screen.getByDisplayValue('All Types');

    // Select 'server' type
    await user.selectOptions(typeFilter, 'server');

    // Verify hook is called with type filter
    await waitFor(() => {
      const lastCall = mockUseCIs.mock.calls[mockUseCIs.mock.calls.length - 1];
      expect(lastCall[0].type).toBe('server');
    });
  });

  it('filters CIs by status', async () => {
    const user = userEvent.setup();
    const mockUseCIs = vi.fn().mockReturnValue(defaultMockData);
    vi.mocked(useCIsHook.useCIs).mockImplementation(mockUseCIs);

    renderWithQueryClient(<CIList />);

    // Status is now a brand pill-filter group rather than a <select>
    await user.click(screen.getByRole('button', { name: 'Active' }));

    await waitFor(() => {
      const lastCall = mockUseCIs.mock.calls[mockUseCIs.mock.calls.length - 1];
      expect(lastCall[0].status).toBe('active');
    });
  });

  it('filters CIs by environment', async () => {
    const user = userEvent.setup();
    const mockUseCIs = vi.fn().mockReturnValue(defaultMockData);
    vi.mocked(useCIsHook.useCIs).mockImplementation(mockUseCIs);

    renderWithQueryClient(<CIList />);

    const envFilter = screen.getByDisplayValue('All Environments');

    await user.selectOptions(envFilter, 'production');

    await waitFor(() => {
      const lastCall = mockUseCIs.mock.calls[mockUseCIs.mock.calls.length - 1];
      expect(lastCall[0].environment).toBe('production');
    });
  });

  it('sorts CIs by column', async () => {
    const user = userEvent.setup();
    const mockUseCIs = vi.fn().mockReturnValue(defaultMockData);
    vi.mocked(useCIsHook.useCIs).mockImplementation(mockUseCIs);

    renderWithQueryClient(<CIList />);

    // Click on Name header to sort
    const nameHeader = screen.getByRole('button', { name: /name/i });
    await user.click(nameHeader);

    // Should toggle from asc to desc
    await waitFor(() => {
      const lastCall = mockUseCIs.mock.calls[mockUseCIs.mock.calls.length - 1];
      expect(lastCall[0].sort_order).toBe('desc');
    });

    // Click again to toggle back
    await user.click(nameHeader);

    await waitFor(() => {
      const lastCall = mockUseCIs.mock.calls[mockUseCIs.mock.calls.length - 1];
      expect(lastCall[0].sort_order).toBe('asc');
    });
  });

  it('handles pagination - next page', async () => {
    const user = userEvent.setup();
    const mockUseCIs = vi.fn().mockReturnValue({
      ...defaultMockData,
      data: {
        ...mockApiHandlers.getCIs.success,
        total: 50, // More items for pagination
      },
    });
    vi.mocked(useCIsHook.useCIs).mockImplementation(mockUseCIs);

    renderWithQueryClient(<CIList />);

    const nextButton = screen.getByRole('button', { name: /next/i });
    await user.click(nextButton);

    // Should request page 2
    await waitFor(() => {
      const lastCall = mockUseCIs.mock.calls[mockUseCIs.mock.calls.length - 1];
      expect(lastCall[0].page).toBe(2);
    });
  });

  it('handles pagination - previous page', async () => {
    const user = userEvent.setup();
    const mockUseCIs = vi.fn().mockReturnValue({
      ...defaultMockData,
      data: {
        ...mockApiHandlers.getCIs.success,
        total: 50,
      },
    });
    vi.mocked(useCIsHook.useCIs).mockImplementation(mockUseCIs);

    renderWithQueryClient(<CIList />);

    // Go to page 2 first
    const nextButton = screen.getByRole('button', { name: /next/i });
    await user.click(nextButton);

    // Then go back
    const prevButton = screen.getByRole('button', { name: /previous/i });
    await user.click(prevButton);

    await waitFor(() => {
      const lastCall = mockUseCIs.mock.calls[mockUseCIs.mock.calls.length - 1];
      expect(lastCall[0].page).toBe(1);
    });
  });

  it('changes rows per page', async () => {
    const user = userEvent.setup();
    const mockUseCIs = vi.fn().mockReturnValue(defaultMockData);
    vi.mocked(useCIsHook.useCIs).mockImplementation(mockUseCIs);

    renderWithQueryClient(<CIList />);

    const rowsPerPageSelect = screen.getByDisplayValue('10');
    await user.selectOptions(rowsPerPageSelect, '25');

    await waitFor(() => {
      const lastCall = mockUseCIs.mock.calls[mockUseCIs.mock.calls.length - 1];
      expect(lastCall[0].limit).toBe(25);
      // Should reset to page 1
      expect(lastCall[0].page).toBe(1);
    });
  });

  it('navigates to CI detail on row click', async () => {
    const user = userEvent.setup();
    vi.mocked(useCIsHook.useCIs).mockReturnValue(defaultMockData);

    renderWithQueryClient(<CIList />);

    await waitFor(() => {
      expect(screen.getByText('web-server-01')).toBeInTheDocument();
    });

    const firstRow = screen.getByText('web-server-01').closest('tr');
    if (firstRow) {
      await user.click(firstRow);

      expect(mockNavigate).toHaveBeenCalledWith('/cis/ci-1');
    }
  });

  it('calls onView callback when provided', async () => {
    const user = userEvent.setup();
    const mockOnView = vi.fn();
    vi.mocked(useCIsHook.useCIs).mockReturnValue(defaultMockData);

    renderWithQueryClient(<CIList onView={mockOnView} />);

    await waitFor(() => {
      expect(screen.getByText('web-server-01')).toBeInTheDocument();
    });

    const firstRow = screen.getByText('web-server-01').closest('tr');
    if (firstRow) {
      await user.click(firstRow);

      expect(mockOnView).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'ci-1',
          name: 'web-server-01',
        })
      );
    }
  });

  it('displays action buttons when showActions is true', async () => {
    const mockOnEdit = vi.fn();
    const mockOnDelete = vi.fn();
    vi.mocked(useCIsHook.useCIs).mockReturnValue(defaultMockData);

    renderWithQueryClient(<CIList showActions={true} onEdit={mockOnEdit} onDelete={mockOnDelete} />);

    await waitFor(() => {
      expect(screen.getByText('web-server-01')).toBeInTheDocument();
    });

    // Should show action buttons
    const actionButtons = screen.getAllByTitle(/view details|edit|delete/i);
    expect(actionButtons.length).toBeGreaterThan(0);
  });

  it('hides action column when showActions is false', () => {
    vi.mocked(useCIsHook.useCIs).mockReturnValue(defaultMockData);

    renderWithQueryClient(<CIList showActions={false} />);

    // Actions header should not be present
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
  });

  it('displays pagination info correctly', async () => {
    vi.mocked(useCIsHook.useCIs).mockReturnValue({
      ...defaultMockData,
      data: {
        ...mockApiHandlers.getCIs.success,
        total: 50,
      },
    });

    renderWithQueryClient(<CIList />);

    // Should show "1-10 of 50"
    await waitFor(() => {
      expect(screen.getByText(/1-10 of 50/i)).toBeInTheDocument();
    });
  });
});
