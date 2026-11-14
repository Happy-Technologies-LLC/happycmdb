// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

export type ItilRecordTable = 'itil_incidents' | 'itil_changes' | 'itil_baselines';

type CatalogQuery = (sql: string, params: unknown[]) => Promise<{ rows: Array<{ available?: boolean }> }>;

/**
 * V2/V3 deliberately have no ITIL record tables. Whether every named table
 * exists with its owner column is answered from catalog metadata, never by
 * probing record data or by turning undefined-table errors into an answer.
 * Query failures propagate to the caller.
 */
export async function itilRecordTablesAvailable(
  query: CatalogQuery,
  ...tables: ItilRecordTable[]
): Promise<boolean> {
  const result = await query(
    `SELECT bool_and(EXISTS (
       SELECT 1 FROM pg_attribute
       WHERE attrelid = to_regclass(name) AND attname = 'organization_id' AND NOT attisdropped
     )) AS available
     FROM unnest($1::text[]) AS name`,
    [tables.map(table => `public.${table}`)]
  );
  return result.rows[0]?.available === true;
}
