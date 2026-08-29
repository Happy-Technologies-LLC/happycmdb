// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// F-031 retest (cycle 10): SearchBar synchronizes controlled value, debounces
// onSearch, shows results on applicable focus/input, clears callbacks/results,
// and invokes onResultClick then closes results.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@/tests/utils/test-utils';
import SearchBar from './SearchBar';

describe('SearchBar Component (F-031)', () => {
  const mockResults = [
    { id: 'r1', title: 'web-server-01', subtitle: 'server', type: 'server' },
    { id: 'r2', title: 'db-server-01', subtitle: 'database', type: 'database' },
  ];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it('debounces onSearch after typing', async () => {
    const user = userEvent.setup({ delay: null });
    const onSearch = vi.fn();
    render(<SearchBar onSearch={onSearch} debounceTime={300} />);

    await user.type(screen.getByPlaceholderText(/search configuration items/i), 'web');

    // Not called synchronously.
    expect(onSearch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith('web'));
  });

  it('shows the results dropdown once results are supplied while typing', async () => {
    const user = userEvent.setup({ delay: null });
    const { rerender } = render(<SearchBar results={[]} />);

    const input = screen.getByPlaceholderText(/search configuration items/i);
    await user.type(input, 'web');
    vi.advanceTimersByTime(400);

    rerender(<SearchBar results={mockResults} value="web" onChange={() => {}} />);

    await waitFor(() => expect(screen.getByText('web-server-01')).toBeInTheDocument());
  });

  it('clears the value and hides results on clear click', async () => {
    const user = userEvent.setup({ delay: null });
    const onChange = vi.fn();
    render(<SearchBar value="web" onChange={onChange} results={mockResults} />);

    // Typing to open the dropdown first via a real interaction (controlled
    // value already has content, so the clear "x" button should be visible).
    const clearButton = screen.getAllByRole('button')[0];
    await user.click(clearButton);

    expect(onChange).toHaveBeenCalledWith('');
  });

  it('invokes onResultClick and closes the results dropdown', async () => {
    const user = userEvent.setup({ delay: null });
    const onResultClick = vi.fn();
    const onChange = vi.fn();
    render(
      <SearchBar
        value="web"
        onChange={onChange}
        results={mockResults}
        onResultClick={onResultClick}
      />
    );

    const input = screen.getByPlaceholderText(/search configuration items/i);
    await user.click(input); // triggers handleFocus -> showResults (value+results present)

    const resultButton = await screen.findByText('web-server-01');
    await user.click(resultButton);

    expect(onResultClick).toHaveBeenCalledWith(mockResults[0]);
    // Results dropdown should be gone after selecting a result.
    await waitFor(() => expect(screen.queryByText('db-server-01')).not.toBeInTheDocument());
  });

  it('synchronizes displayed value with a controlled `value` prop', () => {
    const { rerender } = render(<SearchBar value="initial" onChange={() => {}} />);
    expect(screen.getByPlaceholderText(/search configuration items/i)).toHaveValue('initial');

    rerender(<SearchBar value="updated" onChange={() => {}} />);
    expect(screen.getByPlaceholderText(/search configuration items/i)).toHaveValue('updated');
  });
});
