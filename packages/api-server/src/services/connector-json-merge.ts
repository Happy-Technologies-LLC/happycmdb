// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Limits apply to all write-only JSON fields in one connector mutation. */
export class ConnectorJsonPatchError extends Error {
  constructor() { super('Connector JSON patch exceeds size, node, key or depth limit'); }
}

export class ConnectorJsonPatchBudget {
  private bytes = 0;
  private nodes = 0;
  private keys = 0;

  add(patch: unknown): string {
    const visit = (value: unknown, depth: number): void => {
      if (++this.nodes > 256 || depth > 12) throw new ConnectorJsonPatchError();
      if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value);
        this.keys += entries.length;
        if (this.keys > 256) throw new ConnectorJsonPatchError();
        for (const [, child] of entries) visit(child, depth + 1);
      }
    };
    visit(patch, 0);
    const encoded = JSON.stringify(patch);
    if (encoded === undefined) throw new ConnectorJsonPatchError();
    this.bytes += Buffer.byteLength(encoded, 'utf8');
    if (this.bytes > 64 * 1024) throw new ConnectorJsonPatchError();
    return encoded;
  }
}

/** Atomic single-parameter JSONB patch. Nested empty objects are no-ops;
 * an empty top-level resource_configs object still deliberately clears it. */
export function connectorJsonMerge(column: string, patch: unknown, values: unknown[], budget: ConnectorJsonPatchBudget): string {
  values.push(budget.add(patch));
  if (patch !== null && typeof patch === 'object' && !Array.isArray(patch) && Object.keys(patch).length === 0) {
    return `$${values.length}::jsonb`;
  }
  return `public.connector_jsonb_merge(${column}, $${values.length}::jsonb)`;
}
