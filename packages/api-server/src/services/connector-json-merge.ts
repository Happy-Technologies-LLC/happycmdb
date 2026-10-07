// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Build a single-row, atomic jsonb patch: omitted keys survive; supplied leaves replace. */
export function connectorJsonMerge(column: string, patch: unknown, values: unknown[]): string {
  const merge = (base: string, value: unknown): string => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
      values.push(JSON.stringify(value));
      return `$${values.length}::jsonb`;
    }
    let expression = `COALESCE(${base}, '{}'::jsonb)`;
    for (const [key, child] of Object.entries(value)) {
      values.push(key);
      const keyParam = `$${values.length}`;
      const childBase = `${expression}->${keyParam}`;
      expression = `jsonb_set(${expression}, ARRAY[${keyParam}]::text[], ${merge(childBase, child)}, true)`;
    }
    return expression;
  };
  return merge(column, patch);
}
