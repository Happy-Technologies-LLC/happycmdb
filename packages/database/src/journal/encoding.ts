// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HP1 v16 §3.8 total, injective encoding of Neo4j property values (G) and JSON
 * values (J) into PostgreSQL-storable JSON, and its inverse back to driver
 * values. Integers are always tagged and Floats never are, so Integer(5) and
 * Float(5.0) stay distinct; NaN, ±Infinity and -0 (which jsonb cannot hold or
 * normalizes away) and strings jsonb cannot store are tagged; any literal
 * object with a `$hp1` member is map-wrapped so it never equals a tag.
 */
import neo4j from 'neo4j-driver';

export type Encoded = null | boolean | number | string | Encoded[] | { [key: string]: Encoded };

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** False for U+0000 or a lone surrogate (PG text/jsonb cannot represent them). */
export function isStorableString(value: string): boolean {
  return !value.includes('\u0000') && !LONE_SURROGATE.test(value);
}

const TEMPORALS: Array<[string, (v: unknown) => boolean]> = [
  ['DateTime', neo4j.isDateTime], ['LocalDateTime', neo4j.isLocalDateTime], ['Date', neo4j.isDate],
  ['Time', neo4j.isTime], ['LocalTime', neo4j.isLocalTime], ['Duration', neo4j.isDuration],
];

export function enc(value: unknown): Encoded {
  if (value === null || value === undefined || typeof value === 'boolean') return value ?? null;
  if (neo4j.isInt(value)) return { $hp1: 'int', v: value.toString() };
  if (typeof value === 'number') {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value;
    return { $hp1: 'float', v: Object.is(value, -0) ? '-0' : String(value) };
  }
  if (typeof value === 'bigint') return { $hp1: 'int', v: value.toString() };
  if (typeof value === 'string') {
    return isStorableString(value) ? value
      : { $hp1: 'utf16', b64: Buffer.from(value, 'utf16le').toString('base64') };
  }
  if (Array.isArray(value)) return value.map(enc);
  for (const [type, test] of TEMPORALS) {
    if (test(value)) return { $hp1: 'temporal', t: type, v: String(value) };
  }
  if (neo4j.isPoint(value)) {
    const point = value as { srid: unknown; x: number; y: number; z?: number };
    const coords = point.z === undefined ? [point.x, point.y] : [point.x, point.y, point.z];
    return { $hp1: 'point', srid: enc(point.srid), coords: coords.map(enc) };
  }
  if (typeof value === 'object') {
    // Default sort compares UTF-16 code units: the canonical key order.
    const keys = Object.keys(value).sort();
    const object = value as Record<string, unknown>;
    if (keys.some(key => key === '$hp1' || !isStorableString(key))) {
      return { $hp1: 'map', entries: keys.map(key => [enc(key), enc(object[key])]) };
    }
    const out: Record<string, Encoded> = {};
    for (const key of keys) out[key] = enc(object[key]);
    return out;
  }
  throw new PlanUnrepresentableError();
}

export class PlanUnrepresentableError extends Error {
  constructor() { super('CI cannot be changed through the audited path'); }
}

const DATE = '([+-]?\\d{4,})-(\\d{2})-(\\d{2})';
const TIME = '(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,9}))?';
const OFFSET = '(Z|[+-]\\d{2}:\\d{2}(?::\\d{2})?)';
const nanos = (fraction: string | undefined) => Number((fraction ?? '').padEnd(9, '0'));
function offsetSeconds(offset: string): number {
  if (offset === 'Z') return 0;
  const [h, m, s] = offset.slice(1).split(':').map(Number) as [number, number, number?];
  return (offset[0] === '-' ? -1 : 1) * (h * 3600 + m * 60 + (s ?? 0));
}
function parseTemporal(type: string, text: string): unknown {
  const t = neo4j.types;
  let m: RegExpMatchArray | null;
  if (type === 'Date' && (m = text.match(new RegExp(`^${DATE}$`)))) return new t.Date(+m[1]!, +m[2]!, +m[3]!);
  if (type === 'LocalTime' && (m = text.match(new RegExp(`^${TIME}$`)))) {
    return new t.LocalTime(+m[1]!, +m[2]!, +m[3]!, nanos(m[4]));
  }
  if (type === 'Time' && (m = text.match(new RegExp(`^${TIME}${OFFSET}$`)))) {
    return new t.Time(+m[1]!, +m[2]!, +m[3]!, nanos(m[4]), offsetSeconds(m[5]!));
  }
  if (type === 'LocalDateTime' && (m = text.match(new RegExp(`^${DATE}T${TIME}$`)))) {
    return new t.LocalDateTime(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!, nanos(m[7]));
  }
  if (type === 'DateTime' && (m = text.match(new RegExp(`^${DATE}T${TIME}${OFFSET}?(?:\\[([^\\]]+)\\])?$`)))) {
    if (m[8] === undefined && m[9] === undefined) throw new PlanUnrepresentableError();
    return new t.DateTime(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!, nanos(m[7]),
      m[8] === undefined ? undefined : offsetSeconds(m[8]), m[9]);
  }
  if (type === 'Duration' && (m = text.match(/^P(-?\d+)M(-?\d+)DT(-?)(\d+)(?:\.(\d{1,9}))?S$/))) {
    const total = (m[3] ? -1n : 1n) * (BigInt(m[4]!) * 1_000_000_000n + BigInt(nanos(m[5])));
    const seconds = total >= 0n ? total / 1_000_000_000n : -((-total + 999_999_999n) / 1_000_000_000n);
    // The driver stores Integer seconds/nanoseconds; its typings only name number.
    return new t.Duration(+m[1]!, +m[2]!, neo4j.int(seconds.toString()) as unknown as number,
      neo4j.int((total - seconds * 1_000_000_000n).toString()) as unknown as number);
  }
  throw new PlanUnrepresentableError();
}

/** Inverse of enc, producing driver values (Integer, special Float, temporal, Point). */
export function dec(value: Encoded): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(dec);
  const tag = value['$hp1'];
  if (tag === undefined) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) out[key] = dec(member);
    return out;
  }
  switch (tag) {
    case 'int': return neo4j.int(value['v'] as string);
    case 'float': return value['v'] === '-0' ? -0 : Number(value['v']);
    case 'utf16': return Buffer.from(value['b64'] as string, 'base64').toString('utf16le');
    case 'temporal': return parseTemporal(value['t'] as string, value['v'] as string);
    case 'point': {
      const [x, y, z] = (value['coords'] as Encoded[]).map(dec) as number[];
      return new neo4j.types.Point(dec(value['srid']!) as number, x!, y!, z);
    }
    case 'map': {
      const out: Record<string, unknown> = {};
      for (const [key, member] of value['entries'] as Array<[Encoded, Encoded]>) out[dec(key) as string] = dec(member);
      return out;
    }
    default: throw new PlanUnrepresentableError();
  }
}

/** v16 §3.6 limits on a derived plan (422 abort): valueBytes per stored value, never the envelope; totalBytes per plan. */
export const PLAN_LIMITS = { depth: 32, valueBytes: 65_536, keys: 1_000, array: 1_000, totalBytes: 1_048_576 };
export function assertPlanRepresentable(plan: Encoded): void {
  const walk = (value: Encoded, depth: number): void => {
    if (depth > PLAN_LIMITS.depth) throw new PlanUnrepresentableError();
    if (Array.isArray(value)) {
      if (value.length > PLAN_LIMITS.array) throw new PlanUnrepresentableError();
      value.forEach(member => walk(member, depth + 1));
    } else if (value !== null && typeof value === 'object') {
      const members = Object.values(value);
      if (members.length > PLAN_LIMITS.keys) throw new PlanUnrepresentableError();
      members.forEach(member => walk(member, depth + 1));
    } else if (Buffer.byteLength(JSON.stringify(value)) > PLAN_LIMITS.valueBytes) throw new PlanUnrepresentableError();
  };
  if (Buffer.byteLength(JSON.stringify(plan)) > PLAN_LIMITS.totalBytes) throw new PlanUnrepresentableError();
  walk(plan, 0);
}
