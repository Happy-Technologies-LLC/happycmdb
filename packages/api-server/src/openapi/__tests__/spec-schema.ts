// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// Shared by the openapi.yaml 403 tests (forbidden-spec.test.ts and the credential runtime check): the loaded spec, `$ref` resolution
// and a small JSON-schema check.
import { join } from 'path';
import * as YAML from 'yamljs';

export type Schema = {
  $ref?: string; type?: string; nullable?: boolean; required?: string[]; additionalProperties?: boolean;
  properties?: Record<string, Schema>; items?: Schema; enum?: unknown[]; anyOf?: Schema[]; oneOf?: Schema[];
};
export type Media = { schema?: Schema; example?: unknown; examples?: Record<string, { value: unknown }> };
export type Response = { $ref?: string; content?: { 'application/json': Media } };
export type Operation = { operationId?: string; responses: Record<string, Response> };
export const spec = YAML.load(join(__dirname, '../openapi.yaml')) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema>; responses: Record<string, Response> };
};

/** Follows `$ref` (any `#/a/b/c` pointer into the spec) until a node that is not one. */
export function deref<T extends { $ref?: string }>(node: T): T {
  if (!node.$ref) return node;
  return deref(node.$ref.replace('#/', '').split('/').reduce<any>((at, key) => at[key], spec));
}

/**
 * A small JSON-schema check, enough for the keywords the 403 schemas use: $ref, type, nullable, enum, required, properties,
 * additionalProperties: false, items, anyOf and oneOf (exactly one branch). ajv is only a transitive dependency of the lint stack
 * (v6), so it is not imported here. Returns the violations; empty means the value satisfies the schema.
 */
export function violations(schema: Schema, value: unknown, at = '$'): string[] {
  const node = deref(schema);
  if (value === null && node.nullable) return [];
  const found: string[] = [];
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (node.type && !(node.type === kind || (node.type === 'integer' && Number.isInteger(value)))) found.push(`${at}: expected ${node.type}, got ${kind}`);
  if (node.enum && !node.enum.includes(value)) found.push(`${at}: ${JSON.stringify(value)} is not in the enum`);
  if (kind === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of node.required ?? []) if (!(key in object)) found.push(`${at}: missing ${key}`);
    for (const [key, child] of Object.entries(node.properties ?? {})) if (key in object) found.push(...violations(child, object[key], `${at}.${key}`));
    if (node.additionalProperties === false) for (const key of Object.keys(object)) if (!(key in (node.properties ?? {}))) found.push(`${at}: unexpected ${key}`);
  }
  if (kind === 'array' && node.items) (value as unknown[]).forEach((item, index) => found.push(...violations(node.items!, item, `${at}[${index}]`)));
  if (node.anyOf && !node.anyOf.some(branch => violations(branch, value, at).length === 0)) found.push(`${at}: matches no anyOf branch`);
  if (node.oneOf) {
    const matched = node.oneOf.filter(branch => violations(branch, value, at).length === 0).length;
    if (matched !== 1) found.push(`${at}: matches ${matched} oneOf branches, exactly 1 required`);
  }
  return found;
}

/** The declared `application/json` media of an operation's response (a `$ref` to components/responses is followed). */
export const declaredResponse = (path: string, method: string, status: string): Media =>
  deref(spec.paths[path]![method]!.responses[status]!).content!['application/json'];
