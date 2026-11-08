// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1426 (PoR S5, brief §5): POST /api/v1/portfolio/imports?mode=dry_run|apply, the one-way import of a HappyHive
 * catalog-as-portfolio export into the caller's tenant (the token's organization; never the file, query or body).
 *
 * Both modes parse and validate the whole file, then plan every line against the tenant with reads only (a READ ONLY
 * PostgreSQL transaction and Neo4j reads): `create`, `match` (already imported, or a service of the same name) or
 * `skip` (with a reason); a line that cannot be planned is rejected by line number. A dry run returns that plan and
 * persists nothing (D5). Apply refuses the whole file (422, zero writes) when any line is rejected, then records the
 * import and writes in dependency order: services (+ one internal offering each), CIs, relationships, service-CI
 * mappings. Every record's portfolio_import_map row is written with it (in its transaction for PostgreSQL records), so
 * a re-run of the same file matches what an interrupted run committed and creates only the rest.
 *
 * Audit: services and offerings through appendPortfolioAudit, CIs and relationships through the journal (one row per
 * relationship endpoint), a service-CI mapping and a service name match (HAP-1625) as a BUSINESS_SERVICE UPDATE; each
 * row's metadata names the import_id and every defaulted value (D3).
 * Only allow-listed fields reach a write, a response or a log line.
 */

import { Request, Response } from 'express';
import { createHash, randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import {
  auditChainReady, getNeo4jClient, getPostgresClient, JournalAbortedError, JournalGapError, JournalUnavailableError,
} from '@cmdb/database';
import { logger, type CIInput } from '@cmdb/common';
import { requestOrganizationId } from '../../middleware/auth.middleware';
import { requestActor } from '../../journal-http';
import { CIGapError, CI_GAP_RESPONSE, writeReferencedCIs } from '../../read-admission';
import {
  CI_STATUS, CI_TYPES, ciEnvironment, ciSkipReason, IMPORT_SOURCE, ImportFileError, parseImport, RELATIONSHIP_LABELS,
  SERVICE_DEFAULTS, SERVICE_OPERATIONAL_STATUS, serviceLifecycle, UNASSIGNED_LEGACY, type CIRecord, type Defaulted,
  type ImportKind, type ImportRecord, type ParsedImport, type RelationshipRecord, type Rejection, type ServiceCIRecord,
  type ServiceRecord,
} from '../../services/portfolio-import';
import { appendPortfolioAudit, WRITE_UNAVAILABLE } from './portfolio-write';

export interface MappingEntry {
  kind: ImportKind; source_id: string; target_id: string | null; action: 'create' | 'match' | 'skip';
  reason?: string; defaulted?: Defaulted[];
}

/**
 * One planned line. `pending`: the id a created CI will have; `mapped`: its map row exists already; `ends`: a link's
 * two resolved endpoints (relationship: source, target CI; service_ci: service, CI).
 */
interface Planned { record: ImportRecord; entry: MappingEntry; pending?: string; mapped: boolean; ends?: Endpoint[] }

/**
 * An endpoint a relationship or service-CI line names: a planned line of this file (its target id is known once that
 * line is written), or a record a past import of this tenant mapped (`id`).
 */
type Endpoint = { usable: false } | { usable: true; id: string | null; line?: Planned };

class ImportTargetMissingError extends Error {}

const MODES = ['dry_run', 'apply'];
const bad = (res: Response, status: number, code: string, extra: Record<string, unknown> = {}): void => {
  res.status(status).json({ success: false, error: status === 422 ? 'Unprocessable Entity' : 'Bad Request', code, ...extra });
};
const mapKey = (kind: ImportKind, sourceId: string): string => `${kind}\u0000${sourceId}`;
const nameKey = (name: string): string => name.trim().toLowerCase();

/** A CI the import creates has an id derived from (tenant, source, source id): a re-run finds it without a map row. */
export function importedCIId(organizationId: string, sourceId: string): string {
  return `hh_${createHash('sha256').update(JSON.stringify([organizationId, IMPORT_SOURCE, sourceId])).digest('hex').slice(0, 32)}`;
}

const relationshipTarget = (from: string, label: string, to: string): string => `${from}|${label}|${to}`;

export class PortfolioImportController {
  async importPortfolio(req: Request, res: Response): Promise<void> {
    const mode = req.query['mode'];
    // The tenant is the token's: a query naming one (or anything but mode) is a 400, never a scope.
    if (Object.keys(req.query).some(key => key !== 'mode') || typeof mode !== 'string' || !MODES.includes(mode)) {
      bad(res, 400, 'invalid_mode');
      return;
    }
    if (typeof req.body !== 'string') {
      res.status(415).json({ success: false, error: 'Unsupported Media Type', code: 'ndjson_required' });
      return;
    }
    const organizationId = requestOrganizationId(req);
    let parsed: ParsedImport;
    try {
      parsed = parseImport(req.body, organizationId);
    } catch (error) {
      if (!(error instanceof ImportFileError)) throw error;
      bad(res, error.status, error.code);
      return;
    }
    if (!parsed.countsMatch) {
      bad(res, 422, 'row_counts_mismatch', { rejected: parsed.rejected });
      return;
    }
    if (mode === 'apply' && !auditChainReady()) {
      res.status(503).json(WRITE_UNAVAILABLE);
      return;
    }
    try {
      const rejected = [...parsed.rejected];
      const planned = await this.plan(organizationId, parsed.records, rejected);
      rejected.sort((a, b) => a.line - b.line);
      if (mode === 'dry_run') {
        res.status(200).json({ import_id: randomUUID(), mode, mapping: planned.map(row => row.entry), rejected });
        return;
      }
      if (rejected.length) {
        bad(res, 422, 'rejected_lines', { mode, mapping: [], rejected });
        return;
      }
      const importId = randomUUID();
      await this.apply(req, organizationId, importId, parsed, planned);
      logger.info('Portfolio import applied', {
        import_id: importId,
        created: planned.filter(row => row.entry.action === 'create').length,
        matched: planned.filter(row => row.entry.action === 'match').length,
        skipped: planned.filter(row => row.entry.action === 'skip').length,
      });
      res.status(201).json({ import_id: importId, mode, mapping: planned.map(row => row.entry), rejected: [] });
    } catch (error) {
      this.sendFailure(res, error);
    }
  }

  /**
   * Every record planned in line order with reads only, after the tenant's Unassigned legacy service (created on its
   * first apply, matched by its map row after); a line naming a record nobody has is rejected.
   */
  private async plan(organizationId: string, fileRecords: ImportRecord[], rejected: Rejection[]): Promise<Planned[]> {
    const records: ImportRecord[] = [UNASSIGNED_LEGACY, ...fileRecords];
    const sourceIds = new Set<string>();
    for (const record of records) {
      sourceIds.add(record.source_id);
      if (record.kind === 'relationship') sourceIds.add(record.source_ci).add(record.target_ci);
      if (record.kind === 'service_ci') sourceIds.add(record.service_source_id).add(record.ci_source_id);
    }
    // The file's services: the only ones a name can match.
    const services = fileRecords.filter((record): record is ServiceRecord => record.kind === 'service');
    const { mapRows, liveServices, byName } = await getPostgresClient().transaction(async client => {
      await client.query('SET TRANSACTION READ ONLY');
      const map = (await client.query<{ kind: ImportKind; source_id: string; target_id: string }>(
        `SELECT kind, source_id, target_id FROM portfolio_import_map
         WHERE organization_id = $1 AND source_system = $2 AND source_id = ANY($3::varchar[])`,
        [organizationId, IMPORT_SOURCE, [...sourceIds]])).rows;
      const serviceTargets = map.filter(row => row.kind === 'service').map(row => row.target_id);
      const live = (await client.query<{ service_id: string }>(
        'SELECT service_id FROM dim_business_services WHERE organization_id = $1 AND service_id = ANY($2::varchar[])',
        [organizationId, serviceTargets])).rows;
      // A service another HappyHive record was imported into is not a name match; one this file's own records were
      // imported into stays a candidate, so a line that was ambiguous stays ambiguous on re-run.
      const named = (await client.query<{ service_id: string; name_key: string }>(
        `SELECT s.service_id, lower(btrim(s.name)) AS name_key FROM dim_business_services s
         WHERE s.organization_id = $1 AND lower(btrim(s.name)) = ANY($2::text[])
           AND NOT EXISTS (SELECT 1 FROM portfolio_import_map m WHERE m.organization_id = s.organization_id
                           AND m.kind = 'service' AND m.target_id = s.service_id
                           AND NOT (m.source_id = ANY($3::varchar[])))`,
        [organizationId, [...new Set(services.map(record => nameKey(record.name)))], services.map(record => record.source_id)])).rows;
      const names = new Map<string, string[]>();
      for (const row of named) names.set(row.name_key, [...(names.get(row.name_key) ?? []), row.service_id]);
      return {
        mapRows: new Map(map.map(row => [mapKey(row.kind, row.source_id), row.target_id])),
        liveServices: new Set(live.map(row => row.service_id)), byName: names,
      };
    });
    const neo4j = getNeo4jClient();
    const ciExists = new Map<string, Promise<boolean>>();
    const ownedCI = (id: string): Promise<boolean> => {
      if (!ciExists.has(id)) ciExists.set(id, neo4j.getCIProperties(id, organizationId).then(props => props !== null));
      return ciExists.get(id)!;
    };
    const planned: Planned[] = [];
    const lines = new Map<string, Planned>();
    // Targets of this file's mapped services are claimed before any line plans, whatever the line order.
    const claimed = new Set(services.flatMap(record => mapRows.get(mapKey('service', record.source_id)) ?? []));
    const add = (row: Planned): void => {
      planned.push(row);
      lines.set(mapKey(row.record.kind, row.record.source_id), row);
    };
    const entry = (record: ImportRecord, action: MappingEntry['action'], target: string | null,
      extra: { reason?: string; defaulted?: Defaulted[] } = {}): MappingEntry =>
      ({ kind: record.kind, source_id: record.source_id, target_id: target, action, ...extra });

    for (const record of records) {
      const mapped = mapRows.get(mapKey(record.kind, record.source_id));
      if (record.kind === 'service') {
        if (mapped !== undefined) {
          add(liveServices.has(mapped) ? { record, entry: entry(record, 'match', mapped), mapped: true }
            : { record, entry: entry(record, 'skip', null, { reason: 'target_missing' }), mapped: true });
          continue;
        }
        const candidates = record === UNASSIGNED_LEGACY ? [] : byName.get(nameKey(record.name)) ?? [];
        if (candidates.length > 1) {
          add({ record, entry: entry(record, 'skip', null, { reason: 'ambiguous_name' }), mapped: false });
        } else if (candidates.length === 1) {
          const target = candidates[0]!;
          add(claimed.has(target)
            ? { record, entry: entry(record, 'skip', null, { reason: 'ambiguous_name' }), mapped: false }
            : { record, entry: entry(record, 'match', target, { reason: 'name_match' }), mapped: false });
          claimed.add(target);
        } else {
          const { defaulted } = serviceLifecycle(record);
          add({ record, entry: entry(record, 'create', null, { defaulted: [...SERVICE_DEFAULTS, ...defaulted] }), mapped: false });
        }
      } else if (record.kind === 'ci') {
        if (mapped !== undefined) {
          add(await ownedCI(mapped) ? { record, entry: entry(record, 'match', mapped), mapped: true }
            : { record, entry: entry(record, 'skip', null, { reason: 'target_missing' }), mapped: true });
          continue;
        }
        const skip = ciSkipReason(record);
        if (skip) {
          add({ record, entry: entry(record, 'skip', null, { reason: skip }), mapped: false });
          continue;
        }
        const id = importedCIId(organizationId, record.source_id);
        // An interrupted run created the CI but not its map row.
        if (await ownedCI(id)) add({ record, entry: entry(record, 'match', id), mapped: false });
        else {
          add({ record, entry: entry(record, 'create', null, { defaulted: [...record.defaulted, ...ciEnvironment(record).defaulted] }),
            pending: id, mapped: false });
        }
      } else {
        const ends = record.kind === 'relationship'
          ? [await this.ciEndpoint(record.source_ci, lines, mapRows, ownedCI), await this.ciEndpoint(record.target_ci, lines, mapRows, ownedCI)]
          : [this.serviceEndpoint(record.service_source_id, lines, mapRows, liveServices),
            await this.ciEndpoint(record.ci_source_id, lines, mapRows, ownedCI)];
        if (ends.some(end => end === null)) {
          rejected.push({ line: record.line, code: 'unknown_reference' });
          continue;
        }
        if (mapped !== undefined) {
          add({ record, entry: entry(record, 'match', mapped), mapped: true });
          continue;
        }
        const [from, to] = ends as Endpoint[];
        if (!from!.usable || !to!.usable) {
          add({ record, entry: entry(record, 'skip', null, { reason: 'endpoint_skipped' }), mapped: false });
          continue;
        }
        const existing = from!.id !== null && to!.id !== null
          ? await this.linkTarget(organizationId, record, from!.id, to!.id) : null;
        add(existing ? { record, entry: entry(record, 'match', existing), mapped: false, ends: [from!, to!] }
          : { record, entry: entry(record, 'create', null), mapped: false, ends: [from!, to!] });
      }
    }
    return planned;
  }

  /** A relationship or service-CI link both of whose ends exist already: its map target id when it exists too. */
  private async linkTarget(organizationId: string, record: RelationshipRecord | ServiceCIRecord, from: string,
    to: string): Promise<string | null> {
    if (record.kind === 'relationship') {
      const label = RELATIONSHIP_LABELS[record.relationship_type];
      return await getNeo4jClient().relationshipExists(organizationId, from, label, to) ? relationshipTarget(from, label, to) : null;
    }
    const row = await getPostgresClient().query(
      `SELECT 1 FROM ci_business_service_mappings m JOIN dim_business_services s ON s.service_id = m.service_id
       WHERE m.service_id = $1 AND m.ci_id = $2 AND m.mapping_type = 'supports' AND s.organization_id = $3`,
      [from, to, organizationId]);
    return row.rows.length ? `${from}/${to}` : null;
  }

  private async ciEndpoint(sourceId: string, lines: Map<string, Planned>, mapRows: Map<string, string>,
    ownedCI: (id: string) => Promise<boolean>): Promise<Endpoint | null> {
    const line = lines.get(mapKey('ci', sourceId));
    if (line) return line.entry.action === 'skip' ? { usable: false } : { usable: true, id: line.entry.target_id, line };
    // Not in this file: only this tenant's own map row to a CI it still owns (D4); anything else is unknown.
    const mapped = mapRows.get(mapKey('ci', sourceId));
    return mapped !== undefined && await ownedCI(mapped) ? { usable: true, id: mapped } : null;
  }

  private serviceEndpoint(sourceId: string, lines: Map<string, Planned>, mapRows: Map<string, string>,
    liveServices: Set<string>): Endpoint | null {
    const line = lines.get(mapKey('service', sourceId));
    if (line) return line.entry.action === 'skip' ? { usable: false } : { usable: true, id: line.entry.target_id, line };
    const mapped = mapRows.get(mapKey('service', sourceId));
    return mapped !== undefined && liveServices.has(mapped) ? { usable: true, id: mapped } : null;
  }

  /** The import row, then every create or unmapped match in dependency order (records are in line order). */
  private async apply(req: Request, organizationId: string, importId: string, parsed: ParsedImport,
    planned: Planned[]): Promise<void> {
    const pg = getPostgresClient();
    const neo4j = getNeo4jClient();
    const actor = requestActor(req);
    await pg.query(
      `INSERT INTO portfolio_imports (import_id, organization_id, source_system, mode, file_sha256, row_counts, actor)
       VALUES ($1, $2, $3, 'apply', $4, $5, $6)`,
      [importId, organizationId, IMPORT_SOURCE, createHash('sha256').update(req.body as string).digest('hex'),
        JSON.stringify(parsed.header.row_counts), actor]);
    const writeMap = (client: { query(text: string, params: unknown[]): Promise<{ rowCount: number | null }> }, row: Planned,
      target: string) => client.query(
        `INSERT INTO portfolio_import_map (organization_id, source_system, kind, source_id, target_id, import_id)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (organization_id, source_system, kind, source_id) DO NOTHING`,
        [organizationId, IMPORT_SOURCE, row.record.kind, row.record.source_id, target, importId]);
    // A line of this file was written before the links naming it (dependency order), so its target id is set.
    const idOf = (end: Endpoint | undefined): string => {
      const id = end?.usable ? end.line?.entry.target_id ?? end.id : null;
      if (!id) throw new ImportTargetMissingError();
      return id;
    };

    const order: ImportKind[] = ['service', 'ci', 'relationship', 'service_ci'];
    for (const kind of order) {
      for (const row of planned.filter(candidate => candidate.record.kind === kind)) {
        const { entry } = row;
        if (entry.action === 'skip' || (entry.action === 'match' && row.mapped)) continue;
        if (entry.action === 'match') {
          if (entry.reason === 'name_match') {
            await this.bindService(req, organizationId, row.record.source_id, entry.target_id!, importId,
              client => writeMap(client, row, entry.target_id!));
          } else {
            await writeMap(pg, row, entry.target_id!);
          }
          continue;
        }
        const audit = { import_id: importId, ...(entry.defaulted?.length ? { defaulted: entry.defaulted } : {}) };
        if (row.record.kind === 'service') {
          entry.target_id = await this.createService(req, organizationId, row.record, audit,
            (client, serviceId) => writeMap(client, row, serviceId));
        } else if (row.record.kind === 'ci') {
          entry.target_id = await this.createCI(organizationId, actor, row.record, row.pending!, audit);
          await writeMap(pg, row, entry.target_id);
        } else if (row.record.kind === 'relationship') {
          const label = RELATIONSHIP_LABELS[row.record.relationship_type];
          const from = idOf(row.ends?.[0]);
          const to = idOf(row.ends?.[1]);
          const written = await neo4j.writeRelationship('relationship_create', from, to, label, organizationId, actor,
            { source_system: IMPORT_SOURCE, source_id: row.record.source_id }, undefined, 'user', audit);
          if (!written) throw new ImportTargetMissingError();
          entry.target_id = relationshipTarget(from, label, to);
          await writeMap(pg, row, entry.target_id);
        } else {
          const serviceId = idOf(row.ends?.[0]);
          const ciId = idOf(row.ends?.[1]);
          entry.target_id = `${serviceId}/${ciId}`;
          await this.mapServiceCI(req, organizationId, serviceId, ciId, audit, client => writeMap(client, row, entry.target_id!));
        }
      }
    }
  }

  /** The service, its internal offering, both audit rows and the map row: one transaction. */
  private async createService(req: Request, organizationId: string, record: ServiceRecord,
    audit: Record<string, unknown>, writeMap: (client: PoolClient, serviceId: string) => Promise<unknown>): Promise<string> {
    const serviceId = `bs-${randomUUID()}`;
    const { lifecycle } = serviceLifecycle(record);
    await getPostgresClient().transaction(async client => {
      const service = (await client.query(
        `INSERT INTO dim_business_services (service_id, name, description, service_classification, tbm_tower,
           business_criticality, operational_status, service_type, owned_by, support_group, category, tags,
           organization_id, lifecycle, source_system, source_id)
         VALUES ($1, $2, $3, 'other_it', 'other_it', 'medium', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
        [serviceId, record.name, record.description, SERVICE_OPERATIONAL_STATUS[record.status], record.service_type,
          record.owner, record.support_group, record.category, record.tags, organizationId, lifecycle, IMPORT_SOURCE,
          record.source_id])).rows[0];
      await appendPortfolioAudit(client, req, organizationId, { type: 'BUSINESS_SERVICE', id: serviceId }, 'CREATE',
        'import', null, service, audit);
      const offering = (await client.query(
        `INSERT INTO service_offerings (offering_id, organization_id, service_id, name, description, audience, lifecycle,
           service_level, source_system, source_id)
         VALUES ($1, $2, $3, $4, $5, 'internal', $6, $7, $8, $9) RETURNING *`,
        [`so-${randomUUID()}`, organizationId, serviceId, record.name, record.offering_description, lifecycle,
          JSON.stringify(record.expected_sla_hours === null ? {} : { response_target_hours: record.expected_sla_hours }),
          IMPORT_SOURCE, record.source_id])).rows[0];
      await appendPortfolioAudit(client, req, organizationId, { type: 'SERVICE_OFFERING', id: offering.offering_id },
        'CREATE', 'import', null, offering, { import_id: audit['import_id'] });
      await writeMap(client, serviceId);
    });
    return serviceId;
  }

  /**
   * HAP-1625: a name match binds the file's service to a tenant service it did not create. One transaction: the
   * service row locked FOR UPDATE (gone: ImportTargetMissingError), the map row, and, when this run wrote the map row,
   * its BUSINESS_SERVICE UPDATE audit row (import_source_id null -> the HappyHive source id).
   */
  private async bindService(req: Request, organizationId: string, sourceId: string, serviceId: string, importId: string,
    writeMap: (client: PoolClient) => Promise<{ rowCount: number | null }>): Promise<void> {
    const client = await getPostgresClient().pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      try {
        const service = (await client.query<{ version: number }>(
          'SELECT version FROM dim_business_services WHERE service_id = $1 AND organization_id = $2 FOR UPDATE',
          [serviceId, organizationId])).rows[0];
        if (service === undefined) {
          throw new ImportTargetMissingError();
        }
        if (((await writeMap(client)).rowCount ?? 0) > 0) {
          await appendPortfolioAudit(client, req, organizationId, { type: 'BUSINESS_SERVICE', id: serviceId }, 'UPDATE',
            'import', { version: service.version, import_source_id: null }, { version: service.version, import_source_id: sourceId },
            { import_id: importId, match: 'name_match' });
        }
        await client.query('COMMIT');
      } catch (error) {
        // A failed ROLLBACK destroys the connection: never pool it inside a transaction still holding the row lock.
        await client.query('ROLLBACK').catch((rollbackError: Error) => {
          broken = rollbackError;
        });
        throw error;
      }
    } finally {
      client.release(broken);
    }
  }

  /** A journaled create of the CI's derived id; another run's create of the same id is this one's match. */
  private async createCI(organizationId: string, actor: string, record: CIRecord, id: string,
    audit: Record<string, unknown>): Promise<string> {
    const { environment } = ciEnvironment(record);
    const ci = {
      _id: id, name: record.name, _type: CI_TYPES[record.item_type], status: CI_STATUS[record.status], environment,
      metadata: { source_system: IMPORT_SOURCE, source_id: record.source_id, item_type: record.item_type, ...record.details },
    } as CIInput;
    try {
      await getNeo4jClient().createCI(ci, organizationId, actor, undefined, 'user', audit);
    } catch (error) {
      if (!(error instanceof JournalAbortedError) || !(await getNeo4jClient().getCIProperties(id, organizationId))) throw error;
    }
    return id;
  }

  /**
   * D4: the CI is this tenant's own (a line of this file or its map row, then the graph's owned read under the
   * admission lock), never another tenant's. One transaction: mapping, BUSINESS_SERVICE UPDATE audit row, map row.
   */
  private async mapServiceCI(req: Request, organizationId: string, serviceId: string, ciId: string,
    audit: Record<string, unknown>, writeMap: (client: PoolClient) => Promise<unknown>): Promise<void> {
    if (!(await getNeo4jClient().getCIProperties(ciId, organizationId))) throw new ImportTargetMissingError();
    await writeReferencedCIs(organizationId, [ciId], async client => {
      const service = (await client.query<{ version: number }>(
        'SELECT version FROM dim_business_services WHERE service_id = $1 AND organization_id = $2 FOR UPDATE',
        [serviceId, organizationId])).rows[0];
      if (!service) throw new ImportTargetMissingError();
      const linked = await client.query(
        `INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type, confidence_score)
         VALUES ($1, $2, 'supports', 1.0) ON CONFLICT (ci_id, service_id, mapping_type) DO NOTHING`, [ciId, serviceId]);
      // A pair linked already (another writer got there first) changed nothing: no audit row.
      if ((linked.rowCount ?? 0) > 0) {
        await appendPortfolioAudit(client, req, organizationId, { type: 'BUSINESS_SERVICE', id: serviceId }, 'UPDATE',
          'import', { version: service.version, ci_mapping: null }, { version: service.version, ci_mapping: ciId }, audit);
      }
      await writeMap(client);
    });
  }

  /** Records committed before the failure stay (each with its map row); re-running the file resumes. */
  private sendFailure(res: Response, error: unknown): void {
    const code = (error as { code?: unknown } | null)?.code;
    if (error instanceof CIGapError || error instanceof JournalGapError) {
      res.status(409).json(CI_GAP_RESPONSE);
    } else if (error instanceof ImportTargetMissingError) {
      res.status(409).json({ success: false, error: 'Conflict', code: 'target_missing' });
    } else if (code === '23505') {
      res.status(409).json({ success: false, error: 'Conflict', code: 'concurrent_import' });
    } else if (error instanceof JournalUnavailableError || code === '55P03') {
      res.status(503).json(WRITE_UNAVAILABLE);
    } else {
      // Name and SQLSTATE only: a driver message can quote a row value from the file.
      logger.error('Portfolio import failed', { error: { name: (error as Error | null)?.name, code } });
      res.status(500).json({ success: false, error: 'Portfolio import failed' });
    }
  }
}
