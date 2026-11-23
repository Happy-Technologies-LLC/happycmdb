// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1688 follow-ups for lib/session.ts: the tab id must not need a secure context, and the logout waits for peers
// exactly PEER_WAIT_MAX_MS. Each test loads a fresh copy of the module (its state is module-level).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realCrypto = globalThis.crypto;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const loadSession = async () => {
  vi.resetModules();
  return import('./session');
};

/** Delivery of BroadcastChannel messages runs on real macrotasks; let a few pass. */
const deliver = async () => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

describe('tab id (secure and insecure contexts)', () => {
  let peer: BroadcastChannel;
  let announcedBy: string[];
  beforeEach(() => {
    announcedBy = [];
    peer = new BroadcastChannel('cmdb-session');
    peer.onmessage = (event) => {
      if (event.data.type === 'logout-pending') announcedBy.push(event.data.from);
    };
  });
  afterEach(() => {
    peer.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Loads the module under `cryptoStub` and returns the id it announced a logout with. */
  const announcedId = async (cryptoStub: Partial<Crypto>): Promise<string> => {
    announcedBy = [];
    vi.stubGlobal('crypto', cryptoStub);
    const { endSession } = await loadSession();
    const loggingOut = endSession(() => Promise.resolve());
    await vi.waitFor(() => expect(announcedBy).toHaveLength(1));
    await loggingOut;
    return announcedBy[0];
  };

  it('uses crypto.randomUUID when the context provides it', async () => {
    const randomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555' as const);
    const getRandomValues = vi.fn();

    const id = await announcedId({ randomUUID, getRandomValues } as unknown as Partial<Crypto>);

    expect(id).toBe('11111111-2222-4333-8444-555555555555');
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it('loads on a plain-HTTP origin (no crypto.randomUUID) and builds a v4 UUID from crypto.getRandomValues', async () => {
    const getRandomValues = vi.fn((array: ArrayBufferView) => realCrypto.getRandomValues(array as Uint8Array));
    const math = vi.spyOn(Math, 'random');

    const id = await announcedId({ getRandomValues } as unknown as Partial<Crypto>);

    expect(id).toMatch(UUID_V4);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
    expect(math).not.toHaveBeenCalled();
  });

  it('the fallback id is the random bytes with only the version and variant bits forced', async () => {
    const zeros = (array: ArrayBufferView) => array; // a Uint8Array(16) is already all zero
    expect(await announcedId({ getRandomValues: zeros } as unknown as Partial<Crypto>)).toBe(
      '00000000-0000-4000-8000-000000000000',
    );

    const ones = (array: ArrayBufferView) => (new Uint8Array(array.buffer).fill(0xff), array);
    expect(await announcedId({ getRandomValues: ones } as unknown as Partial<Crypto>)).toBe(
      'ffffffff-ffff-4fff-bfff-ffffffffffff',
    );
  });
});

describe('PEER_WAIT_MAX_MS: a logout whose peers never answer', () => {
  let peer: BroadcastChannel;
  beforeEach(() => {
    peer = new BroadcastChannel('cmdb-session');
    // A peer that is renewing: it says busy and never says settled.
    peer.onmessage = (event) => {
      if (event.data.type === 'logout-pending') peer.postMessage({ type: 'busy', from: 'peer-tab', to: event.data.from });
    };
    // Only setTimeout is faked: BroadcastChannel delivery and promises keep running for real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    peer.close();
  });

  it('proceeds to the POST at exactly 5 s: not a millisecond before', async () => {
    const { endSession } = await loadSession();
    const logout = vi.fn(() => Promise.resolve());

    const loggingOut = endSession(logout);
    await deliver();
    await vi.advanceTimersByTimeAsync(4_999); // far past the 150 ms grace: the peer's busy is being waited for
    await deliver();
    expect(logout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await deliver();
    expect(logout).toHaveBeenCalledTimes(1);
    await loggingOut;
  });
});
