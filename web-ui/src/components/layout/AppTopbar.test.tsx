// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AppTopbar } from './AppTopbar';

vi.mock('@contexts/AuthContext', () => ({
  useAuth: () => ({ user: { username: 'ada', full_name: 'Ada Lovelace', role: 'operator' } }),
}));
// Neither child takes part in the search; both need providers the search does not.
vi.mock('./AccountMenu', () => ({ AccountMenu: () => null }));
vi.mock('./ServiceHealthDots', () => ({ ServiceHealthDots: () => null }));

const Where = () => {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
};

function renderTopbar() {
  render(
    <MemoryRouter initialEntries={['/start']}>
      <AppTopbar navOpen={false} onToggleNav={() => undefined} />
      <Where />
    </MemoryRouter>,
  );
  return { box: screen.getByRole('searchbox'), where: screen.getByTestId('where') };
}

describe('AppTopbar search', () => {
  it('Enter opens the CI list with the text trimmed and URL-encoded', async () => {
    const user = userEvent.setup();
    const { box, where } = renderTopbar();
    await user.type(box, '  foo bar {Enter}');
    expect(where).toHaveTextContent('/cis?search=foo%20bar');
  });

  it('Enter on whitespace only opens the unfiltered CI list', async () => {
    const user = userEvent.setup();
    const { box, where } = renderTopbar();
    await user.type(box, '   {Enter}');
    expect(where).toHaveTextContent(/^\/cis$/);
  });

  it('other keys do not navigate', async () => {
    const user = userEvent.setup();
    const { box, where } = renderTopbar();
    await user.type(box, 'foo{Tab}');
    expect(where).toHaveTextContent(/^\/start$/);
    box.focus();
    await user.keyboard('{Escape}{ArrowDown}');
    expect(where).toHaveTextContent(/^\/start$/);
  });
});
