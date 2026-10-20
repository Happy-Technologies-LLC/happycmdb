// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HP1 v16 §3.8 / X-27b: the plan encoding is injective over driver and JSON
// values and survives a jsonb round trip with types and IEEE-754 bits intact.
import neo4j from 'neo4j-driver';
import { assertPlanRepresentable, dec, enc, Encoded, PlanUnrepresentableError } from '../encoding';

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
});
