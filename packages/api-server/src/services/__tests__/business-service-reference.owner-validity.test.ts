// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * readOwnerValidity: one batched, time-bounded identity-store lookup per read (the C1 `owner_valid`).
 */
import {
  OWNER_VALIDITY_TIMEOUT_MS, OwnerValidityTimeoutError, ownerValidityTimeoutMs, readOwnerValidity, type OwnerLookup, type OwnerUser,
} from '../business-service-reference';

const ORG = 'org-a';
const users = (entries: Record<string, string | null | undefined>, ambiguous: string[] = []): OwnerLookup => ({
  users: new Map<string, OwnerUser>(Object.entries(entries).map(([id, organization]) => [id, { _organizationId: organization }])),
  ambiguous,
});

describe('readOwnerValidity', () => {
  it('asks once for the distinct owners and compares each user\'s organization', async () => {
    const lookup = jest.fn(async (_ids: string[], _timeoutMs: number) =>
      users({ same: ORG, other: 'org-b', orphan: undefined }));

    const result = await readOwnerValidity(ORG, ['same', 'other', null, 'same', 'orphan', 'ghost'], lookup, 1000);

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]).toEqual([['same', 'other', 'orphan', 'ghost'], 1000]);
    expect([...result.valid]).toEqual([['same', true], ['other', false], ['orphan', false], ['ghost', false]]);
    expect(result.failures).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it('an ambiguous owner reads not valid and is reported, the others keep their answer', async () => {
    const lookup = jest.fn(async () => users({ same: ORG }, ['twin']));

    const result = await readOwnerValidity(ORG, ['same', 'twin'], lookup, 1000);

    expect([...result.valid]).toEqual([['same', true], ['twin', false]]);
    expect([result.ambiguous, result.failures]).toEqual([['twin'], []]);
  });

  it('asks nothing when no service names an owner', async () => {
    const lookup = jest.fn(async () => users({}));

    const result = await readOwnerValidity(ORG, [null, null], lookup, 1000);

    expect(lookup).not.toHaveBeenCalled();
    expect([result.valid.size, result.failures]).toEqual([0, []]);
  });

  it('a lookup that outlasts the bound reads every owner as not valid and records a fixed timeout error', async () => {
    const lookup = jest.fn(() => new Promise<OwnerLookup>(() => undefined));
    const started = Date.now();

    const result = await readOwnerValidity(ORG, ['secret-principal-id', 'another'], lookup, 20);

    expect(Date.now() - started).toBeLessThan(1000);
    expect([...result.valid]).toEqual([['secret-principal-id', false], ['another', false]]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toBeInstanceOf(OwnerValidityTimeoutError);
    expect((result.failures[0] as Error).message).toBe('Owner validity lookup timed out');
  });

  it('a lookup that fails reads every owner as not valid and never rejects, even when it rejects after the bound', async () => {
    const failure = new Error('identity store down');
    const failing = await readOwnerValidity(ORG, ['a', 'b'], async () => { throw failure; }, 1000);
    expect([...failing.valid]).toEqual([['a', false], ['b', false]]);
    expect(failing.failures).toEqual([failure]);

    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const late = await readOwnerValidity(ORG, ['a'], () => new Promise<OwnerLookup>((_resolve, reject) => {
        setTimeout(() => reject(failure), 60);
      }), 10);
      expect(late.failures[0]).toBeInstanceOf(OwnerValidityTimeoutError);
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('ownerValidityTimeoutMs', () => {
  it('is OWNER_VALIDITY_TIMEOUT_MS when set to a positive integer up to the int4 ceiling, else the default', () => {
    expect(ownerValidityTimeoutMs({})).toBe(OWNER_VALIDITY_TIMEOUT_MS);
    expect(ownerValidityTimeoutMs({ OWNER_VALIDITY_TIMEOUT_MS: '250' })).toBe(250);
    for (const bad of ['0', '-5', '1.5', 'abc', '', '2147483648']) {
      expect(ownerValidityTimeoutMs({ OWNER_VALIDITY_TIMEOUT_MS: bad })).toBe(OWNER_VALIDITY_TIMEOUT_MS);
    }
  });
});
