// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1213: typed provider secrets live in the input's value property only, never in the DOM tree.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { domLeaks, secretMarker } from '@/tests/utils/secretDom';

vi.mock('axios', () => ({ default: { create: () => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
}) } }));

import { DiscoverySettings } from './DiscoverySettings';

afterEach(cleanup);

const SECRET_FIELDS = [
  { section: 'AWS', label: /secret access key/i },
  { section: 'Azure', label: /client secret/i },
  { section: 'Google Cloud Platform', label: /service account credentials/i },
  { section: 'SSH', label: /private key/i },
];

describe('DiscoverySettings secret fields (HAP-1213)', () => {
  it('keeps every typed secret out of the DOM tree and in the input value property', () => {
    render(<DiscoverySettings />);
    for (const { section } of SECRET_FIELDS) {
      fireEvent.click(screen.getByRole('button', { name: section }));
    }
    const typed = SECRET_FIELDS.map(({ label }) => {
      const marker = secretMarker('settings');
      const field = screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
      fireEvent.change(field, { target: { value: marker } });
      return { marker, field };
    });
    // A second edit takes the update path as well as the first commit.
    for (const { field } of typed) {
      fireEvent.change(field, { target: { value: `${field.value}-more` } });
    }

    for (const { marker, field } of typed) {
      expect(field.value).toBe(`${marker}-more`);
      expect(domLeaks(marker)).toEqual([]);
    }
  });

  it('masks the single-line secrets and disables autofill on every secret field', () => {
    render(<DiscoverySettings />);
    for (const { section } of SECRET_FIELDS) {
      fireEvent.click(screen.getByRole('button', { name: section }));
    }
    for (const label of [/secret access key/i, /client secret/i]) {
      const field = screen.getByLabelText(label);
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveAttribute('autocomplete', 'new-password');
    }
    for (const label of [/service account credentials/i, /private key/i]) {
      expect(screen.getByLabelText(label)).toHaveAttribute('autocomplete', 'off');
    }
  });
});
