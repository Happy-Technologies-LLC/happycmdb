// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-975: deletes the data-mart rows of exactly the given CI ids (the fixtures a run created): their
 * facts first, then every dim_ci version. Rows of any other CI id are never matched.
 */
type Query = (text: string, params: unknown[]) => Promise<unknown>;

const OWNED_KEYS = 'SELECT ci_key FROM cmdb.dim_ci WHERE ci_id = ANY($1::varchar[])';

export async function deleteOwnedDataMart(query: Query, ciIds: string[]): Promise<void> {
  await query(`DELETE FROM cmdb.fact_ci_relationships
    WHERE from_ci_key IN (${OWNED_KEYS}) OR to_ci_key IN (${OWNED_KEYS})`, [ciIds]);
  await query(`DELETE FROM cmdb.fact_ci_changes WHERE ci_key IN (${OWNED_KEYS})`, [ciIds]);
  await query(`DELETE FROM cmdb.fact_discovery WHERE ci_key IN (${OWNED_KEYS})`, [ciIds]);
  await query('DELETE FROM cmdb.dim_ci WHERE ci_id = ANY($1::varchar[])', [ciIds]);
}
