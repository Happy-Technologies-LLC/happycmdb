// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import CICard from './CICard';
import type { CI } from '../../services/ci.service';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => mockNavigate,
}));

const ci: CI = {
  id: 'ci-7',
  name: 'billing-api',
  type: 'application',
  status: 'active',
  environment: 'production',
  description: 'Handles invoicing',
  tags: ['pci', 'tier-1', 'eu', 'blue'],
  discovered_by: 'aws-connector',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
} as CI;

const renderCard = (props: Partial<React.ComponentProps<typeof CICard>> = {}) =>
  render(
    <MemoryRouter>
      <CICard ci={ci} {...props} />
    </MemoryRouter>
  );

describe('CICard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the name as a heading with its type, status, environment, description and provenance', () => {
    renderCard();
    expect(screen.getByRole('heading', { name: 'billing-api' })).toBeInTheDocument();
    expect(screen.getByText('Application')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('production')).toBeInTheDocument();
    expect(screen.getByText('Handles invoicing')).toBeInTheDocument();
    expect(screen.getByText('Discovered by: aws-connector')).toBeInTheDocument();
  });

  it('shows the first three tags and a count for the rest', () => {
    renderCard();
    expect(screen.getByText('pci')).toBeInTheDocument();
    expect(screen.getByText('eu')).toBeInTheDocument();
    expect(screen.queryByText('blue')).toBeNull();
    expect(screen.getByText('+1')).toBeInTheDocument();
  });

  it('opens the record on a card click, to the inventory route by default', async () => {
    renderCard();
    await userEvent.click(screen.getByText('Handles invoicing'));
    expect(mockNavigate).toHaveBeenCalledWith('/inventory/ci-7');
  });

  it('an action button runs its own action only, not the card click', async () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onView = vi.fn();
    const onPeek = vi.fn();
    renderCard({ onEdit, onDelete, onView, onPeek });

    await userEvent.click(screen.getByRole('button', { name: 'Edit billing-api' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete billing-api' }));
    await userEvent.click(screen.getByRole('button', { name: 'Quick view billing-api' }));

    expect(onEdit).toHaveBeenCalledWith(ci);
    expect(onDelete).toHaveBeenCalledWith(ci);
    expect(onPeek).toHaveBeenCalledWith(ci);
    expect(onView).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('offers only the actions it was given a handler for', () => {
    renderCard();
    expect(screen.getByRole('button', { name: 'View details for billing-api' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^delete/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /quick view/i })).toBeNull();
  });

  it('shows no action buttons when showActions is false', () => {
    renderCard({ onEdit: vi.fn(), onDelete: vi.fn(), onPeek: vi.fn(), showActions: false });
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
