// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Service offerings (HAP-1424, PoR S3; Suite Contracts v2 C1): a record under one business service.
 *
 * Tenant scoping: the organization comes from the token only (requestOrganizationId; the routers apply
 * requireOrganization()). Every statement filters by it, so another tenant's service or offering is the same 404 as a
 * missing one. Migration 046's composite foreign key (service_id, organization_id) also refuses, in the database, an
 * offering whose service belongs to another tenant.
 *
 * Rules (409, nothing written): no new offering under a retired service; an offering is live only under a live
 * service; lifecycle moves forward only and `retired` is terminal (retire = PATCH lifecycle=retired); a stale If-Match.
 * Each write locks the parent service row FOR SHARE, which conflicts with the service PATCH's FOR NO KEY UPDATE, so a
 * concurrent service lifecycle move cannot slip between the check and the write. Each accepted write appends one
 * hash-chained SERVICE_OFFERING audit_log row in the same transaction (no ledger event).
 */

import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { auditChainReady, getPostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import { requestOrganizationId } from '../../middleware/auth.middleware';
import { errorLogFields } from '../../utils/log-error';
import { C1Lifecycle, lifecycleMoveAllowed } from '../../services/business-service-reference';
import {
  appendPortfolioAudit, ifMatchVersion, sendWriteFailure, WRITE_UNAVAILABLE, type WriteRefusal,
} from './portfolio-write';

type OfferingRow = {
  offering_id: string; organization_id: string; service_id: string; name: string; description: string | null;
  audience: 'internal' | 'customer'; lifecycle: C1Lifecycle; service_level: Record<string, unknown>; version: number;
  created_at: Date; updated_at: Date;
};

/** The columns a PATCH may set (the route's Joi schema already strips anything else). */
const EDITABLE = ['name', 'description', 'audience', 'lifecycle', 'service_level'] as const;
const SERVICE_NOT_FOUND = { success: false, error: 'Business service not found' };
const OFFERING_NOT_FOUND = { success: false, error: 'Service offering not found' };
const LIVE_NEEDS_LIVE_SERVICE: WriteRefusal = {
  status: 409, body: { success: false, error: 'Conflict', message: 'An offering can be live only under a live service' },
};

/** The C1 offering read: tenant_id is the stored organization_id. */
function offeringReference(row: OfferingRow) {
  return {
    offering_id: row.offering_id, service_id: row.service_id, tenant_id: row.organization_id, name: row.name,
    description: row.description, audience: row.audience, lifecycle: row.lifecycle, service_level: row.service_level,
    version: row.version, updated_at: row.updated_at,
  };
}

export class ServiceOfferingController {
  private pgClient = getPostgresClient();

  /** GET /api/v1/business-services/:service_id/offerings: the service's offerings, oldest first. */
  async listServiceOfferings(req: Request, res: Response): Promise<void> {
    try {
      // One statement: the org-filtered parent and its offerings come from the same snapshot.
      const result = await this.pgClient.query(
        `SELECT o.* FROM dim_business_services s
         LEFT JOIN service_offerings o ON o.service_id = s.service_id AND o.organization_id = s.organization_id
         WHERE s.service_id = $1 AND s.organization_id = $2
         ORDER BY o.created_at, o.offering_id`,
        [req.params.service_id, requestOrganizationId(req)]
      );
      if (result.rows.length === 0) {
        res.status(404).json(SERVICE_NOT_FOUND);
        return;
      }
      res.json({
        success: true,
        data: (result.rows as OfferingRow[]).filter(row => row.offering_id !== null).map(offeringReference),
      });
    } catch (error) {
      logger.error('Error listing service offerings', { error: errorLogFields(error), service_id: req.params.service_id });
      res.status(500).json({ success: false, error: 'Failed to list service offerings' });
    }
  }

  /** GET /api/v1/service-offerings/:offering_id: the C1 offering read; ETag "<version>". */
  async getServiceOffering(req: Request, res: Response): Promise<void> {
    try {
      const row: OfferingRow | undefined = (await this.pgClient.query(
        'SELECT * FROM service_offerings WHERE offering_id = $1 AND organization_id = $2',
        [req.params.offering_id, requestOrganizationId(req)]
      )).rows[0];
      if (!row) {
        res.status(404).json(OFFERING_NOT_FOUND);
        return;
      }
      res.set('ETag', `"${row.version}"`).json({ success: true, data: offeringReference(row) });
    } catch (error) {
      logger.error('Error getting service offering', { error: errorLogFields(error), offering_id: req.params.offering_id });
      res.status(500).json({ success: false, error: 'Failed to get service offering' });
    }
  }

  /** POST /api/v1/business-services/:service_id/offerings: create under the caller's service; one CREATE audit row. */
  async createServiceOffering(req: Request, res: Response): Promise<void> {
    try {
      const { name, description = null, audience, lifecycle, service_level } = req.body as {
        name: string; description?: string; audience: string; lifecycle: C1Lifecycle; service_level: object;
      };
      if (!auditChainReady()) {
        res.status(503).json(WRITE_UNAVAILABLE);
        return;
      }
      const { service_id } = req.params;
      const organizationId = requestOrganizationId(req);
      const outcome = await this.pgClient.transaction(async (client): Promise<WriteRefusal | { row: OfferingRow }> => {
        const service: { lifecycle: C1Lifecycle } | undefined = (await client.query(
          'SELECT lifecycle FROM dim_business_services WHERE service_id = $1 AND organization_id = $2 FOR SHARE',
          [service_id, organizationId]
        )).rows[0];
        if (!service) return { status: 404, body: SERVICE_NOT_FOUND };
        if (service.lifecycle === 'retired') {
          return { status: 409, body: { success: false, error: 'Conflict',
            message: 'A retired business service takes no new offerings' } };
        }
        if (lifecycle === 'live' && service.lifecycle !== 'live') return LIVE_NEEDS_LIVE_SERVICE;

        const row: OfferingRow = (await client.query(
          `INSERT INTO service_offerings (offering_id, organization_id, service_id, name, description, audience, lifecycle,
             service_level)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [`so-${randomUUID()}`, organizationId, service_id, name, description, audience, lifecycle,
            JSON.stringify(service_level)]
        )).rows[0];
        await appendPortfolioAudit(client, req, organizationId, { type: 'SERVICE_OFFERING', id: row.offering_id },
          'CREATE', 'create', null, row);
        return { row };
      });

      if (!('row' in outcome)) {
        res.status(outcome.status).json(outcome.body);
        return;
      }
      logger.info('Service offering created', { offering_id: outcome.row.offering_id, service_id });
      res.set('ETag', `"${outcome.row.version}"`).status(201).json({ success: true, data: offeringReference(outcome.row) });
    } catch (error) {
      logger.error('Error creating service offering', { error: errorLogFields(error), service_id: req.params.service_id });
      sendWriteFailure(res, error, 'Failed to create service offering');
    }
  }

  /**
   * PATCH /api/v1/service-offerings/:offering_id: optional If-Match "<version>" (409 when stale); retire is
   * lifecycle=retired. An accepted update bumps version by one and appends one UPDATE audit row.
   */
  async updateServiceOffering(req: Request, res: Response): Promise<void> {
    try {
      const updates = req.body as Partial<Record<(typeof EDITABLE)[number], unknown>>;
      const fields = EDITABLE.filter(field => field in updates);
      if (fields.length === 0) {
        res.status(400).json({ success: false, error: 'No fields to update' });
        return;
      }
      const expectedVersion = ifMatchVersion(req.get('If-Match'));
      if (expectedVersion === undefined) {
        res.status(400).json({ success: false, error: 'Bad Request', message: 'If-Match must be a record version ("<version>")' });
        return;
      }
      if (!auditChainReady()) {
        res.status(503).json(WRITE_UNAVAILABLE);
        return;
      }

      const { offering_id } = req.params;
      const organizationId = requestOrganizationId(req);
      const outcome = await this.pgClient.transaction(async (client): Promise<WriteRefusal | { row: OfferingRow }> => {
        const locked: (OfferingRow & { service_lifecycle: C1Lifecycle }) | undefined = (await client.query(
          `SELECT o.*, s.lifecycle AS service_lifecycle
           FROM service_offerings o
           JOIN dim_business_services s ON s.service_id = o.service_id AND s.organization_id = o.organization_id
           WHERE o.offering_id = $1 AND o.organization_id = $2
           FOR NO KEY UPDATE OF o FOR SHARE OF s`,
          [offering_id, organizationId]
        )).rows[0];
        if (!locked) return { status: 404, body: OFFERING_NOT_FOUND };
        const { service_lifecycle: serviceLifecycle, ...current } = locked;
        if (expectedVersion !== null && current.version !== expectedVersion) {
          return { status: 409, body: { success: false, error: 'Conflict', message: 'Version mismatch', version: current.version } };
        }
        const lifecycle = (updates.lifecycle as C1Lifecycle | undefined) ?? current.lifecycle;
        if (!lifecycleMoveAllowed(current.lifecycle, lifecycle)) {
          return { status: 409, body: { success: false, error: 'Conflict',
            message: `Lifecycle cannot move from ${current.lifecycle} to ${lifecycle}` } };
        }
        if (lifecycle === 'live' && serviceLifecycle !== 'live') return LIVE_NEEDS_LIVE_SERVICE;

        const row: OfferingRow = (await client.query(
          `UPDATE service_offerings
           SET ${fields.map((field, index) => `${field} = $${index + 3}`).join(', ')}, version = version + 1, updated_at = NOW()
           WHERE offering_id = $1 AND organization_id = $2
           RETURNING *`,
          [offering_id, organizationId,
            ...fields.map(field => field === 'service_level' ? JSON.stringify(updates[field]) : updates[field])]
        )).rows[0];
        const retire = lifecycle === 'retired' && current.lifecycle !== 'retired';
        await appendPortfolioAudit(client, req, organizationId, { type: 'SERVICE_OFFERING', id: row.offering_id },
          'UPDATE', retire ? 'retire' : 'update', current, row);
        return { row };
      });

      if (!('row' in outcome)) {
        res.status(outcome.status).json(outcome.body);
        return;
      }
      logger.info('Service offering updated', { offering_id, updates: fields });
      res.set('ETag', `"${outcome.row.version}"`).json({ success: true, data: offeringReference(outcome.row) });
    } catch (error) {
      logger.error('Error updating service offering', { error: errorLogFields(error), offering_id: req.params.offering_id });
      sendWriteFailure(res, error, 'Failed to update service offering');
    }
  }
}
