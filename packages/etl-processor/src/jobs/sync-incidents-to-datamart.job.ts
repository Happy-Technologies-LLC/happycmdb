// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Sync Incident Data to Data Mart Job (v3.0)
 *
 * Validates and enriches ITIL incident and change data in the PostgreSQL data mart
 * Ensures ITIL data is properly structured for reporting, SLA tracking, and analytics.
 *
 * This job works with the itil_incidents and itil_changes tables which are populated
 * by the ITIL APIs and seed data.
 *
 * Schedule: Every 15 minutes (real-time ITSM metrics)
 */

import { Job } from 'bullmq';
import { logger } from '@cmdb/common';
import { getPostgresClient } from '@cmdb/database';
import { subDays } from 'date-fns';

export interface SyncIncidentsJobData {
  /** Only process incidents/changes updated since this timestamp (ISO 8601) */
  incrementalSince?: string;
  /** Include changes in addition to incidents */
  includeChanges?: boolean;
  /** Calculate SLA compliance metrics */
  calculateSLAs?: boolean;
}

export interface SyncIncidentsJobResult {
  success: boolean;
  incidentsProcessed: number;
  incidentsEnriched: number;
  changesProcessed: number;
  changesEnriched: number;
  slaViolations: number;
  validationErrors: string[];
  enrichmentErrors: string[];
  startTime: string;
  endTime: string;
  durationMs: number;
}

/**
 * Main job processor for syncing and validating incident data
 */
export async function processSyncIncidentsToDatamart(
  job: Job<SyncIncidentsJobData>
): Promise<SyncIncidentsJobResult> {
  const startTime = Date.now();
  const result: SyncIncidentsJobResult = {
    success: false,
    incidentsProcessed: 0,
    incidentsEnriched: 0,
    changesProcessed: 0,
    changesEnriched: 0,
    slaViolations: 0,
    validationErrors: [],
    enrichmentErrors: [],
    startTime: new Date().toISOString(),
    endTime: '',
    durationMs: 0,
  };

  logger.info('[SyncIncidentsToDatamart] Starting incident data sync job', { jobId: job.id });

  try {
    const incrementalSince = job.data.incrementalSince || subDays(new Date(), 1).toISOString();
    const includeChanges = job.data.includeChanges !== false;
    const calculateSLAs = job.data.calculateSLAs !== false;

    // Step 1: Process incidents
    const incidentResult = await processIncidents(incrementalSince, calculateSLAs);
    result.incidentsProcessed = incidentResult.processed;
    result.incidentsEnriched = incidentResult.enriched;
    result.slaViolations = incidentResult.slaViolations;
    result.validationErrors.push(...incidentResult.validationErrors);
    result.enrichmentErrors.push(...incidentResult.enrichmentErrors);

    // Step 2: Process changes
    if (includeChanges) {
      const changeResult = await processChanges(incrementalSince);
      result.changesProcessed = changeResult.processed;
      result.changesEnriched = changeResult.enriched;
      result.validationErrors.push(...changeResult.validationErrors);
      result.enrichmentErrors.push(...changeResult.enrichmentErrors);
    }

    result.success = result.validationErrors.length === 0;
    result.endTime = new Date().toISOString();
    result.durationMs = Date.now() - startTime;

    logger.info('[SyncIncidentsToDatamart] Incident data sync job completed', {
      ...result,
      durationSeconds: Math.round(result.durationMs / 1000),
    });

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.validationErrors.push(`Fatal error: ${errorMsg}`);
    result.success = false;
    result.endTime = new Date().toISOString();
    result.durationMs = Date.now() - startTime;

    logger.error('[SyncIncidentsToDatamart] Incident data sync job failed', {
      jobId: job.id,
      error: errorMsg,
      stack: error instanceof Error ? error.stack : undefined,
    });

    return result;
  }
}

/**
 * Process and validate incidents
 */
async function processIncidents(
  incrementalSince: string,
  calculateSLAs: boolean
): Promise<{
  processed: number;
  enriched: number;
  slaViolations: number;
  validationErrors: string[];
  enrichmentErrors: string[];
}> {
  const result: {
    processed: number;
    enriched: number;
    slaViolations: number;
    validationErrors: string[];
    enrichmentErrors: string[];
  } = {
    processed: 0,
    enriched: 0,
    slaViolations: 0,
    validationErrors: [],
    enrichmentErrors: [],
  };

  const pgClient = getPostgresClient();
  const pool = pgClient.pool;

  // Get incidents updated since last sync
  const incidentsResult = await pool.query(
    `SELECT
      organization_id,
      id,
      incident_number,
      title,
      description,
      category,
      subcategory,
      impact,
      urgency,
      priority,
      affected_ci_id,
      affected_business_service_id,
      affected_application_service_id,
      status,
      assigned_to,
      assigned_group,
      reported_by,
      reported_at,
      acknowledged_at,
      resolved_at,
      closed_at,
      time_to_acknowledge_minutes,
      time_to_resolve_minutes,
      business_impact,
      resolution,
      resolution_code,
      created_at,
      updated_at
    FROM itil_incidents
    WHERE updated_at >= $1 AND organization_id IS NOT NULL
    ORDER BY updated_at DESC`,
    [incrementalSince]
  );

  const incidents = incidentsResult.rows;
  logger.info('[SyncIncidentsToDatamart] Retrieved incidents', {
    count: incidents.length,
    incrementalSince,
  });

  for (const incident of incidents) {
    try {
      // Validate incident data
      const validationResult = validateIncident(incident);
      if (!validationResult.isValid) {
        result.validationErrors.push(
          `Incident ${incident.incident_number}: ${validationResult.errors.join(', ')}`
        );
      }

      // Enrich with CI and business service details
      const enrichmentResult = await enrichIncident(incident);
      if (enrichmentResult.enriched) {
        result.enriched++;
      }
      if (enrichmentResult.errors.length > 0) {
        result.enrichmentErrors.push(
          `Incident ${incident.incident_number}: ${enrichmentResult.errors.join(', ')}`
        );
      }

      // Calculate SLA compliance
      if (calculateSLAs) {
        const slaResult = await calculateIncidentSLA(incident);
        if (slaResult.violated) {
          result.slaViolations++;
        }
      }

      result.processed++;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.validationErrors.push(`Incident ${incident.incident_number}: ${errorMsg}`);
      logger.error('[SyncIncidentsToDatamart] Error processing incident', {
        incident_number: incident.incident_number,
        error: errorMsg,
      });
    }
  }

  return result;
}

/**
 * Process and validate changes
 */
async function processChanges(
  incrementalSince: string
): Promise<{
  processed: number;
  enriched: number;
  validationErrors: string[];
  enrichmentErrors: string[];
}> {
  const result: {
    processed: number;
    enriched: number;
    validationErrors: string[];
    enrichmentErrors: string[];
  } = {
    processed: 0,
    enriched: 0,
    validationErrors: [],
    enrichmentErrors: [],
  };

  const pgClient = getPostgresClient();
  const pool = pgClient.pool;

  // Get changes updated since last sync
  const changesResult = await pool.query(
    `SELECT
      organization_id,
      id,
      change_number,
      title,
      description,
      change_type,
      status,
      approval_status,
      risk_assessment,
      business_impact,
      financial_impact,
      affected_ci_ids,
      affected_business_service_ids,
      affected_application_service_ids,
      assigned_to,
      assigned_group,
      requested_by,
      scheduled_start,
      scheduled_end,
      actual_start,
      actual_end,
      outcome,
      created_at,
      updated_at
    FROM itil_changes
    WHERE updated_at >= $1 AND organization_id IS NOT NULL
    ORDER BY updated_at DESC`,
    [incrementalSince]
  );

  const changes = changesResult.rows;
  logger.info('[SyncIncidentsToDatamart] Retrieved changes', {
    count: changes.length,
    incrementalSince,
  });

  for (const change of changes) {
    try {
      // Validate change data
      const validationResult = validateChange(change);
      if (!validationResult.isValid) {
        result.validationErrors.push(
          `Change ${change.change_number}: ${validationResult.errors.join(', ')}`
        );
      }

      // Enrich with CI and business service details
      const enrichmentResult = await enrichChange(change);
      if (enrichmentResult.enriched) {
        result.enriched++;
      }
      if (enrichmentResult.errors.length > 0) {
        result.enrichmentErrors.push(
          `Change ${change.change_number}: ${enrichmentResult.errors.join(', ')}`
        );
      }

      result.processed++;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.validationErrors.push(`Change ${change.change_number}: ${errorMsg}`);
      logger.error('[SyncIncidentsToDatamart] Error processing change', {
        change_number: change.change_number,
        error: errorMsg,
      });
    }
  }

  return result;
}

/**
 * Validate incident data integrity
 */
function validateIncident(incident: any): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Required fields
  if (!incident.incident_number) errors.push('Missing incident_number');
  if (!incident.title) errors.push('Missing title');
  if (!incident.priority) errors.push('Missing priority');
  if (!incident.status) errors.push('Missing status');
  if (!incident.reported_at) errors.push('Missing reported_at');

  // Priority validation
  if (incident.priority && ![1, 2, 3, 4, 5].includes(incident.priority)) {
    errors.push(`Invalid priority: ${incident.priority}`);
  }

  // Status validation
  const validStatuses = ['open', 'in_progress', 'pending', 'resolved', 'closed', 'canceled'];
  if (incident.status && !validStatuses.includes(incident.status)) {
    errors.push(`Invalid status: ${incident.status}`);
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Validate change data integrity
 */
function validateChange(change: any): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Required fields
  if (!change.change_number) errors.push('Missing change_number');
  if (!change.title) errors.push('Missing title');
  if (!change.change_type) errors.push('Missing change_type');
  if (!change.status) errors.push('Missing status');

  // Change type validation
  const validTypes = ['standard', 'normal', 'emergency'];
  if (change.change_type && !validTypes.includes(change.change_type)) {
    errors.push(`Invalid change_type: ${change.change_type}`);
  }

  // Status validation
  const validStatuses = ['draft', 'submitted', 'approved', 'scheduled', 'in_progress', 'completed', 'failed', 'rolled_back', 'canceled'];
  if (change.status && !validStatuses.includes(change.status)) {
    errors.push(`Invalid status: ${change.status}`);
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Enrich incident with CI and business service details
 */
async function enrichIncident(incident: any): Promise<{
  enriched: boolean;
  errors: string[];
}> {
  const errors: string[] = [];
  let enriched = false;

  const pgClient = getPostgresClient();
  const pool = pgClient.pool;

  try {
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    // Legacy NULL-owner records have no authority for enrichment.
    if (!incident.organization_id) return { enriched: false, errors };
    // Enrich with CI details if affected_ci_id is set
    if (incident.affected_ci_id) {
      const ciResult = await pool.query(
        `SELECT ci_key, ci_name, ci_type, bsm_attributes
         FROM cmdb.dim_ci
         WHERE ci_id = $1 AND organization_id = $2
           AND is_current = true AND org_backfilled = false
         LIMIT 1`,
        [incident.affected_ci_id, incident.organization_id]
      );

      if (ciResult.rows.length > 0) {
        const ci = ciResult.rows[0];
        const businessImpact = incident.business_impact || {};
        businessImpact.affected_ci_name = ci.ci_name;
        businessImpact.affected_ci_type = ci.ci_type;
        businessImpact.affected_ci_criticality = ci.bsm_attributes?.business_criticality;

        updates.push(`business_impact = $${paramIndex++}`);
        values.push(JSON.stringify(businessImpact));
        enriched = true;
      } else {
        errors.push(`CI not found: ${incident.affected_ci_id}`);
      }
    }

    // Update incident if enriched
    if (updates.length > 0) {
      values.push(incident.id, incident.organization_id);
      const updated = await pool.query(
        `UPDATE itil_incidents
         SET ${updates.join(', ')},
             updated_at = NOW()
         WHERE id = $${paramIndex} AND organization_id = $${paramIndex + 1}`,
        values
      );
      enriched = (updated.rowCount ?? 0) > 0;

      logger.debug('[SyncIncidentsToDatamart] Enriched incident', {
        incident_number: incident.incident_number,
      });
    }

    return { enriched, errors };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    errors.push(`Enrichment failed: ${errorMsg}`);
    return { enriched, errors };
  }
}

/**
 * Enrich change with CI and business service details
 */
async function enrichChange(_change: any): Promise<{
  enriched: boolean;
  errors: string[];
}> {
  const errors: string[] = [];
  let enriched = false;

  // Placeholder for change enrichment logic
  // Can be expanded to validate affected CIs and calculate risk scores

  return { enriched, errors };
}

/**
 * Calculate SLA compliance for incident
 */
async function calculateIncidentSLA(incident: any): Promise<{
  violated: boolean;
  details: any;
}> {
  // SLA targets based on priority
  const slaTargets = {
    1: { acknowledge_minutes: 15, resolve_minutes: 240 }, // P1: 15min / 4hr
    2: { acknowledge_minutes: 30, resolve_minutes: 480 }, // P2: 30min / 8hr
    3: { acknowledge_minutes: 60, resolve_minutes: 1440 }, // P3: 1hr / 24hr
    4: { acknowledge_minutes: 240, resolve_minutes: 2880 }, // P4: 4hr / 48hr
    5: { acknowledge_minutes: 480, resolve_minutes: 5760 }, // P5: 8hr / 96hr
  };

  const target = slaTargets[incident.priority as keyof typeof slaTargets] || slaTargets[5];
  const details: any = {
    priority: incident.priority,
    target_acknowledge_minutes: target.acknowledge_minutes,
    target_resolve_minutes: target.resolve_minutes,
    actual_acknowledge_minutes: incident.time_to_acknowledge_minutes,
    actual_resolve_minutes: incident.time_to_resolve_minutes,
    acknowledge_sla_met: true,
    resolve_sla_met: true,
  };

  let violated = false;

  if (incident.time_to_acknowledge_minutes > target.acknowledge_minutes) {
    details.acknowledge_sla_met = false;
    violated = true;
  }

  if (incident.time_to_resolve_minutes && incident.time_to_resolve_minutes > target.resolve_minutes) {
    details.resolve_sla_met = false;
    violated = true;
  }

  return { violated, details };
}

/**
 * Job configuration for BullMQ
 */
export const syncIncidentsJobConfig = {
  jobName: 'sync-incidents-to-datamart',
  defaultOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000, // 2 seconds
    },
    removeOnComplete: 500, // Keep last 500 completed jobs
    removeOnFail: 1000, // Keep last 1000 failed jobs for debugging
  },
  cronSchedule: '*/15 * * * *', // Every 15 minutes (real-time ITSM metrics)
};
