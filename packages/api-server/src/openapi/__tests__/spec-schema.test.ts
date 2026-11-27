// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// The shared openapi test validator is the oracle for the closed 403 arms, so it must fail closed: a key counts only when the value
// OWNS it. An inherited name (`constructor`, `toString`, `hasOwnProperty`) is not a declared, present or permitted key.
import { violations, type Schema } from './spec-schema';

const closed: Schema = { type: 'object', required: ['success'], additionalProperties: false, properties: { success: { type: 'boolean' } } };

describe('violations() key checks use own keys, not the prototype chain', () => {
  it('accepts a body with exactly the declared key', () => {
    expect(violations(closed, { success: false })).toEqual([]);
  });

  it.each(['constructor', 'toString', 'hasOwnProperty'])('reports an own `%s` key on a closed object as unexpected', key => {
    expect(violations(closed, { success: false, [key]: 'x' })).toContain(`$: unexpected ${key}`);
  });

  it('reports an own __proto__ key (as JSON.parse creates it) as unexpected', () => {
    const parsed = JSON.parse('{"success":false,"__proto__":{"a":1}}') as Record<string, unknown>;
    expect(Object.keys(parsed)).toContain('__proto__');
    expect(violations(closed, parsed)).toContain('$: unexpected __proto__');
  });

  it('does not let an inherited name satisfy required', () => {
    expect(violations({ type: 'object', required: ['toString'] }, {})).toContain('$: missing toString');
  });

  it('does not validate an inherited member against a property schema of the same name', () => {
    const schema: Schema = { type: 'object', properties: { toString: { type: 'string' } } };
    expect(violations(schema, {})).toEqual([]);
    expect(violations(schema, { toString: 5 })).toEqual(['$.toString: expected string, got number']);
  });

  it('matches no anyOf branch when a closed arm gets an extra inherited-name key', () => {
    const other: Schema = { type: 'object', required: ['error'], additionalProperties: false, properties: { error: { type: 'string' } } };
    const either: Schema = { anyOf: [closed, other] };
    expect(violations(either, { success: false })).toEqual([]);
    expect(violations(either, { success: false, constructor: 'x' })).toContain('$: matches no anyOf branch');
    expect(violations(either, { error: 'e', toString: 'x' })).toContain('$: matches no anyOf branch');
  });
});
