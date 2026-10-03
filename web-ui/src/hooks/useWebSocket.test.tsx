// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AuthContext from '@/contexts/AuthContext';
import { useWebSocket } from './useWebSocket';

/** Records every socket the hook opens; never touches the network. */
class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string, readonly protocols?: string | string[]) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

type Auth = React.ContextType<typeof AuthContext>;

function renderWithToken(token: string | null, options: { reconnect?: boolean } = { reconnect: false }) {
  let auth = { token } as Auth;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
  );
  // A fresh inline callback on every render, as real consumers pass.
  const view = renderHook(() => useWebSocket({ ...options, onMessage: () => {} }), { wrapper });
  return {
    setToken(next: string | null) {
      auth = { token: next } as Auth;
      view.rerender();
    },
  };
}

describe('useWebSocket', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends the access token as a Sec-WebSocket-Protocol entry on connect', () => {
    renderWithToken('access-1');

    expect(FakeWebSocket.instances).toHaveLength(1);
    const [socket] = FakeWebSocket.instances;
    expect(socket!.url.endsWith('/ws')).toBe(true);
    expect(socket!.protocols).toEqual(['cmdb.v1', 'bearer.access-1']);
  });

  it('reconnects with the fresh token when the session token changes', () => {
    const auth = renderWithToken('access-1');

    auth.setToken('access-2');

    expect(FakeWebSocket.instances.map(s => [s.protocols, s.closed])).toEqual([
      [['cmdb.v1', 'bearer.access-1'], true],
      [['cmdb.v1', 'bearer.access-2'], false],
    ]);
  });

  it('keeps one socket across re-renders that pass new inline callbacks', () => {
    const auth = renderWithToken('access-1');

    auth.setToken('access-1');
    auth.setToken('access-1');

    expect(FakeWebSocket.instances.map(s => s.closed)).toEqual([false]);
  });

  it('does not reconnect with the old token after the session token is cleared', () => {
    vi.useFakeTimers();
    const auth = renderWithToken('access-1', { reconnect: true });
    const [old] = FakeWebSocket.instances;

    auth.setToken(null);
    old!.onclose?.({ code: 1000 });
    vi.advanceTimersByTime(10 * 60_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(old!.closed).toBe(true);
  });

  it('waits for a fresh token after a 4001 close instead of retrying the stale one', () => {
    vi.useFakeTimers();
    const auth = renderWithToken('access-1', { reconnect: true });
    const [expired] = FakeWebSocket.instances;

    expired!.onclose?.({ code: 4001 });
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    auth.setToken('access-2');
    expect(FakeWebSocket.instances.map(s => s.protocols)).toEqual([
      ['cmdb.v1', 'bearer.access-1'],
      ['cmdb.v1', 'bearer.access-2'],
    ]);
  });
});
