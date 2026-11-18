// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HP1 v16 §3.8 / X-27b: the plan encoding is injective over driver and JSON
// values and survives a jsonb round trip with types and IEEE-754 bits intact.
import neo4j from 'neo4j-driver';
import { createHash } from 'crypto';
import {
  assertPlanRepresentable, boundOversizedSnapshot, dec, enc, Encoded, OVERSIZED_SNAPSHOT_BYTES, PlanUnrepresentableError,
} from '../encoding';

const viaJson = (value: unknown) => dec(JSON.parse(JSON.stringify(enc(value))) as Encoded);
const t = neo4j.types;

it.each([
  ['Integer 2^60', neo4j.int('1152921504606846976')],
  ['Integer 2^63-1', neo4j.int('9223372036854775807')],
  ['Integer -2^63', neo4j.int('-9223372036854775808')],
  ['Float 1e300', 1e300], ['Float 2^53+2', 9007199254740994], ['Float 5e-324', 5e-324],
  ['DateTime with offset and nanos', new t.DateTime(2026, 1, 1, 0, 0, 0, 5, 3600)],
  ['DateTime with zone id', new t.DateTime(2026, 1, 1, 0, 0, 0, 0, undefined, 'Europe/Paris')],
  ['negative Duration', new t.Duration(-1, 0, -2, 5)],
  ['LocalTime', new t.LocalTime(1, 2, 3, 400)],
  ['Time', new t.Time(1, 2, 3, 0, -3601)],
  ['Date before year 0', new t.Date(-5, 1, 1)],
  ['Point', new t.Point(4326, 1.5, 2.5)],
  ['string with U+0000', 'a\u0000b'], ['lone surrogate', '\uD800x'],
  ['lists keep element types', [[1.5, 1e300], [neo4j.int(1), neo4j.int(2)]]],
])('%s round-trips through jsonb text exactly', (_name, value) => {
  expect(viaJson(value)).toEqual(value);
  expect(String(viaJson(value))).toBe(String(value));
});

it('keeps special floats bit-identical, which jsonb cannot store', () => {
  expect(Object.is(viaJson(-0), -0)).toBe(true);
  expect(Number.isNaN(viaJson(NaN))).toBe(true);
  expect(viaJson(Infinity)).toBe(Infinity);
  expect(viaJson(-Infinity)).toBe(-Infinity);
});

it('never confuses Integer with Float, or a literal tag-shaped value with a tag', () => {
  expect(enc(neo4j.int(5))).toEqual({ $hp1: 'int', v: '5' });
  expect(enc(5)).toBe(5);
  expect(enc({ $hp1: 'int', v: '5' })).not.toEqual(enc(neo4j.int(5)));
  for (const literal of [{ $hp1: 'int', v: '5' }, { $hp1: 'x' }, { a: { $hp1: 'utf16', b64: 'AAA=' } }, { 'k\u0000': 1 }]) {
    expect(viaJson(literal)).toEqual(literal);
  }
});

it('rejects a plan over the §3.6 limits as unrepresentable (422), not truncated', () => {
  expect(() => assertPlanRepresentable(enc({ metadata: 'x'.repeat(2 * 1024 * 1024) }))).toThrow(PlanUnrepresentableError);
  let deep: unknown = 1;
  for (let i = 0; i < 40; i++) deep = [deep];
  expect(() => assertPlanRepresentable(enc(deep))).toThrow(PlanUnrepresentableError);
  expect(() => assertPlanRepresentable(enc({ name: 'ok', n: neo4j.int(3) }))).not.toThrow();
  const props = { a: 'x'.repeat(30_000), b: 'y'.repeat(30_000), c: 'z'.repeat(30_000) }; // 64 KiB bounds a value, not the envelope
  expect(() => assertPlanRepresentable({ graph: { params: enc({ props }) }, history: { previous: enc(props) } })).not.toThrow();
  expect(() => assertPlanRepresentable(enc({ props: { a: 'x'.repeat(65_535) } }))).toThrow(PlanUnrepresentableError);
});

describe('boundOversizedSnapshot (HAP-797)', () => {
  const evidence = (value: unknown) => {
    const json = JSON.stringify(enc(value));
    return { bytes: Buffer.byteLength(json), sha256: createHash('sha256').update(json).digest('hex') };
  };
  const filler = (count: number, size: number): Record<string, string> =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`attr${String(i).padStart(2, '0')}`, `${i}`.padEnd(size, 'k')]));

  it('replaces nothing and returns the plain encoding when every value fits', () => {
    const props = { name: 'a', n: neo4j.int(3), description: 'x'.repeat(65_534) };
    expect(boundOversizedSnapshot(props)).toEqual({ snapshot: enc(props), oversized: [] });
  });

  it('replaces only a value over 64 KiB, hashing the HP1 encoding rather than the plain value', () => {
    const big = 'b'.repeat(65_535);
    const props = { name: 'a', big };
    const { snapshot, oversized } = boundOversizedSnapshot(props);
    expect(oversized).toEqual([{ field: 'big', ...evidence(big) }]);
    expect(dec(snapshot)).toEqual({ name: 'a', big: { $hp797: 'oversized', ...evidence(big) } });
    expect(() => assertPlanRepresentable(snapshot)).not.toThrow();
  });

  it('replaces an array over 1000 members and hashes its HP1 encoding, which differs from the plain JSON for Integers', () => {
    const ints = Array.from({ length: 1_001 }, (_, i) => neo4j.int(i));
    const { oversized } = boundOversizedSnapshot({ ints });
    expect(oversized).toEqual([{ field: 'ints', ...evidence(ints) }]);
    expect(oversized[0]!.sha256).not.toBe(createHash('sha256').update(JSON.stringify(ints.map(Number))).digest('hex'));
  });

  it('keeps every value that fits when only one value is over a limit, even with ~540 KB of other values', () => {
    const props = { ...filler(9, 60_000), big: 'b'.repeat(70_000) };
    expect(boundOversizedSnapshot(props).oversized.map(o => o.field)).toEqual(['big']);
  });

  it('trims the largest remaining values only when the bounded snapshot is over the budget, until it fits', () => {
    const props = { ...filler(20, 60_000), big: 'b'.repeat(70_000), huge: 'h'.repeat(65_000) };
    const { snapshot, oversized } = boundOversizedSnapshot(props);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(OVERSIZED_SNAPSHOT_BYTES);
    expect(() => assertPlanRepresentable(snapshot)).not.toThrow();
    const replaced = oversized.map(o => o.field);
    expect(replaced).toEqual(expect.arrayContaining(['big', 'huge']));
    expect(replaced.length).toBeGreaterThan(2);
    // Minimal: restoring any one trimmed value (all the same size) would push the snapshot back over the budget.
    const trimmed = replaced.find(field => field.startsWith('attr'))!;
    const restored = { ...(dec(snapshot) as Record<string, unknown>), [trimmed]: (props as Record<string, string>)[trimmed] };
    expect(Buffer.byteLength(JSON.stringify(enc(restored)))).toBeGreaterThan(OVERSIZED_SNAPSHOT_BYTES);
    for (const { field, ...digest } of oversized) expect(digest).toEqual(evidence((props as Record<string, string>)[field]));
  });

  it('escapes property names like a plan map and refuses a value enc cannot represent', () => {
    const { snapshot } = boundOversizedSnapshot({ $hp1: 'int', big: 'b'.repeat(65_535) });
    expect(Object.keys(dec(snapshot) as object).sort()).toEqual(['$hp1', 'big']);
    expect(() => boundOversizedSnapshot({ bad: Symbol('x') })).toThrow(PlanUnrepresentableError);
  });
});
