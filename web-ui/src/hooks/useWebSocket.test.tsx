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
  onclose: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string, readonly protocols?: string | string[]) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

type Auth = React.ContextType<typeof AuthContext>;

function renderWithToken(token: string | null) {
  let auth = { token } as Auth;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
  );
  const view = renderHook(() => useWebSocket({ reconnect: false }), { wrapper });
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

  afterEach(() => vi.unstubAllGlobals());

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
});
