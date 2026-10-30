// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1210 S1 (P-1): discovery settings never send typed provider secrets to /discovery/test-connection.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Built at runtime from neutral parts so no fixture looks like a real value.
const MARK = ['hap', String(1210), 'mark'].join('-');

const { request } = vi.hoisted(() => ({ request: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock('axios', () => ({ default: { create: () => ({
  ...request, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
}) } }));

import { DiscoverySettings } from './DiscoverySettings';

const SECTIONS = ['AWS', 'Azure', 'Google Cloud Platform', 'SSH'];
const FIELDS = [/secret access key/i, /client secret/i, /service account credentials/i, /private key/i];

const spies: MockInstance[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  request.post.mockResolvedValue({ data: {} });
  request.put.mockResolvedValue({ data: {} });
  for (const level of ['log', 'info', 'debug', 'warn', 'error'] as const) {
    spies.push(vi.spyOn(console, level).mockImplementation(() => undefined));
  }
});
afterEach(() => {
  cleanup();
  // No console level ever sees the marker, in any argument, at any depth.
  const calls = spies.splice(0).map((spy) => {
    const seen = inspect(spy.mock.calls, { depth: null });
    spy.mockRestore();
    return seen;
  });
  expect(calls.join('\n')).not.toContain(MARK);
});

// Closed Radix content is unmounted, so every section is opened before its fields are typed into.
function renderFilled(): void {
  render(<DiscoverySettings />);
  for (const name of SECTIONS) {
    fireEvent.click(screen.getByRole('button', { name }));
  }
  for (const label of FIELDS) {
    fireEvent.change(screen.getByLabelText(label), { target: { value: MARK } });
  }
}

const postedPaths = (): string[] => (request.post.mock.calls as [string][]).map(([path]) => path);

describe('DiscoverySettings secret send (HAP-1210 S1)', () => {
  it('(a) offers no connection test once every provider secret is typed', () => {
    renderFilled();
    expect(screen.queryAllByRole('button', { name: /test connection/i })).toEqual([]);
    expect(screen.queryAllByText(/test connection/i)).toEqual([]);
  });

  it('(b) no button posts to the test-connection route; Save still sends its PUT', async () => {
    renderFilled();
    // Section triggers carry aria-expanded; clicking them would unmount the content, so skip them.
    const actions = screen.getAllByRole('button').filter((button) => !button.hasAttribute('aria-expanded'));
    for (const button of actions) {
      fireEvent.click(button);
    }
    await waitFor(() => expect(request.put).toHaveBeenCalledTimes(4));
    expect(postedPaths().filter((path) => /test-connection/.test(path))).toEqual([]);
    expect(actions.map((button) => button.textContent?.trim())).toEqual(['Save', 'Save', 'Save', 'Save']);
    const puts = request.put.mock.calls as [string, unknown][];
    expect(puts.map(([path]) => path)).toEqual(
      ['aws', 'azure', 'gcp', 'ssh'].map((provider) => `/settings/discovery/${provider}`));
    for (const [, body] of puts) {
      expect(JSON.stringify(body)).toContain(MARK);
    }
    expect(await screen.findAllByText('Credentials saved successfully')).toHaveLength(4);
  });

  it('(c) no non-test web-ui source references the test-connection route', () => {
    const root = join(__dirname, '../..');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
    const sources = walk(root).filter((file) => /\.tsx?$/.test(file) && !/\.(test|spec)\.tsx?$/.test(file));
    expect(sources.length).toBeGreaterThan(50);
    const hits = sources.filter((file) => readFileSync(file, 'utf8').includes('test-connection')).map((file) => relative(root, file));
    expect(hits).toEqual([]);
  });
});
