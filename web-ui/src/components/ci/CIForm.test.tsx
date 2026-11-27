// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CIForm from './CIForm';
import type { CI } from '../../services/ci.service';

const existing: CI = {
  id: 'ci-7',
  name: 'billing-api',
  type: 'application',
  status: 'maintenance',
  environment: 'staging',
  description: 'Handles invoicing',
  tags: ['pci'],
  attributes: { cpu: 4 },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
} as CI;

describe('CIForm', () => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  beforeEach(() => vi.clearAllMocks());

  it('create: submits the defaults plus what was typed, as exactly the payload the API takes', async () => {
    render(<CIForm onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByRole('heading', { name: 'Create Configuration Item' })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/^name/i), 'web-01');
    await userEvent.selectOptions(screen.getByLabelText(/^type/i), 'database');
    await userEvent.selectOptions(screen.getByLabelText(/^environment/i), 'production');
    await userEvent.type(screen.getByLabelText(/^description/i), 'primary');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toEqual({
      name: 'web-01',
      type: 'database',
      status: 'active',
      environment: 'production',
      description: 'primary',
      tags: [],
      attributes: {},
    });
  });

  it('edit: starts from the CI and submits its changes with the tags and attributes carried over', async () => {
    render(<CIForm ci={existing} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByRole('heading', { name: 'Edit Configuration Item' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^name/i)).toHaveValue('billing-api');

    await userEvent.clear(screen.getByLabelText(/^name/i));
    await userEvent.type(screen.getByLabelText(/^name/i), 'billing-api-v2');
    await userEvent.selectOptions(screen.getByLabelText(/^status/i), 'active');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toEqual({
      name: 'billing-api-v2',
      type: 'application',
      status: 'active',
      environment: 'staging',
      description: 'Handles invoicing',
      tags: ['pci'],
      attributes: { cpu: 4 },
    });
  });

  it('a missing name is refused with its message, announced, and nothing is submitted', async () => {
    render(<CIForm onSubmit={onSubmit} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Name is required');
    expect(screen.getByLabelText(/^name/i)).toBeInvalid();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Enter adds a trimmed tag once, a duplicate is ignored, and a tag can be removed again', async () => {
    render(<CIForm onSubmit={onSubmit} onCancel={onCancel} />);
    const tagField = screen.getByLabelText(/^tags/i);

    await userEvent.type(tagField, '  prod {Enter}');
    await userEvent.type(tagField, 'prod{Enter}');
    await userEvent.type(tagField, 'eu{Enter}');
    expect(tagField).toHaveValue('');
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
    expect(onSubmit).not.toHaveBeenCalled(); // Enter in the tag field is not a form submit

    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    await userEvent.type(screen.getByLabelText(/^name/i), 'web-01');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].tags).toEqual(['eu']);
  });

  it('Cancel calls onCancel without submitting', async () => {
    render(<CIForm onSubmit={onSubmit} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('while submitting, both buttons are disabled and Save reads Saving...', () => {
    render(<CIForm onSubmit={onSubmit} onCancel={onCancel} isSubmitting />);
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
  });
});
