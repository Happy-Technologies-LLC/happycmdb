// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Router, type Request, type Response } from 'express';
import Joi from 'joi';
import { ITILController } from '../controllers/itil.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { auditMiddleware } from '../../middleware/audit.middleware';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';

export const itilRoutes = Router();
const controller = new ITILController();
const authMiddleware = getAuthMiddleware();

itilRoutes.use('/configuration-items', authMiddleware.requireOrganization());
itilRoutes.use('/metrics/configuration-accuracy', authMiddleware.requireOrganization());
// Apply audit middleware to all routes
itilRoutes.use(auditMiddleware);

// Incident/change records have no tenant column until HP1-S2. Refuse every
// authenticated caller before validation, role checks or database access.
const recordsUnavailable = (_req: Request, res: Response): void => {
  res.status(403).json({ success: false, error: 'ITIL records unavailable' });
};
itilRoutes.use('/incidents', recordsUnavailable);
itilRoutes.use('/changes', recordsUnavailable);
itilRoutes.use('/metrics/incident-summary', recordsUnavailable);
itilRoutes.use('/metrics/change-success-rate', recordsUnavailable);
itilRoutes.use('/metrics/mttr', recordsUnavailable);
itilRoutes.use('/metrics/mtbf', recordsUnavailable);

// Validation schemas
const updateLifecycleSchema = Joi.object({
  stage: Joi.string()
    .valid('PLANNING', 'DESIGN', 'BUILD', 'TEST', 'DEPLOY', 'OPERATE', 'RETIRE')
    .required(),
});

const updateConfigStatusSchema = Joi.object({
  status: Joi.string()
    .valid('PLANNED', 'ORDERED', 'IN_DEVELOPMENT', 'ACTIVE', 'MAINTENANCE', 'RETIRED', 'DISPOSED')
    .required(),
});

const scheduleAuditSchema = Joi.object({
  auditDate: Joi.date().iso().required(),
  auditor: Joi.string().optional(),
  notes: Joi.string().optional(),
});

const completeAuditSchema = Joi.object({
  auditStatus: Joi.string().valid('COMPLIANT', 'NON_COMPLIANT', 'UNKNOWN').required(),
  findings: Joi.string().optional(),
  completedBy: Joi.string().required(),
});

const createIncidentSchema = Joi.object({
  affectedCIId: Joi.string().required(),
  description: Joi.string().required().min(10),
  reportedBy: Joi.string().required(),
  symptoms: Joi.array().items(Joi.string()).optional(),
  detectedAt: Joi.date().iso().optional(),
});

const updateIncidentSchema = Joi.object({
  status: Joi.string()
    .valid('NEW', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')
    .optional(),
  assignedTo: Joi.string().optional(),
  priority: Joi.number().integer().min(1).max(5).optional(),
});

const resolveIncidentSchema = Joi.object({
  resolution: Joi.string().required().min(10),
  resolvedBy: Joi.string().required(),
});

const createChangeSchema = Joi.object({
  changeType: Joi.string().valid('STANDARD', 'NORMAL', 'EMERGENCY').required(),
  description: Joi.string().required().min(10),
  affectedCIIds: Joi.array().items(Joi.string()).min(1).required(),
  requestedBy: Joi.string().required(),
  plannedStart: Joi.date().iso().required(),
  plannedDuration: Joi.number().integer().min(1).required(), // in minutes
  implementationPlan: Joi.string().required().min(50),
  backoutPlan: Joi.string().optional(),
  testPlan: Joi.string().optional(),
});

const updateChangeSchema = Joi.object({
  status: Joi.string()
    .valid('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'IN_PROGRESS', 'IMPLEMENTED', 'CLOSED', 'CANCELLED')
    .optional(),
  implementedBy: Joi.string().optional(),
  actualDuration: Joi.number().integer().min(1).optional(),
});

const closeChangeSchema = Joi.object({
  result: Joi.string().valid('SUCCESS', 'PARTIAL_SUCCESS', 'FAILED', 'ROLLED_BACK').required(),
  notes: Joi.string().optional(),
  closedBy: Joi.string().required(),
});

const createBaselineSchema = Joi.object({
  name: Joi.string().required().min(3).max(100),
  ciIds: Joi.array().items(Joi.string()).min(1).required(),
  description: Joi.string().optional(),
  createdBy: Joi.string().required(),
});

const restoreFromBaselineSchema = Joi.object({
  ciId: Joi.string().required(),
  restoreAttributes: Joi.array().items(Joi.string()).optional(),
  performedBy: Joi.string().required(),
});

const ciFiltersSchema = Joi.object({
  lifecycle: Joi.string()
    .valid('PLANNING', 'DESIGN', 'BUILD', 'TEST', 'DEPLOY', 'OPERATE', 'RETIRE')
    .optional(),
  status: Joi.string()
    .valid('PLANNED', 'ORDERED', 'IN_DEVELOPMENT', 'ACTIVE', 'MAINTENANCE', 'RETIRED', 'DISPOSED')
    .optional(),
  ciType: Joi.string().optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(1000).default(50),
});

const incidentFiltersSchema = Joi.object({
  status: Joi.string()
    .valid('NEW', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')
    .optional(),
  priority: Joi.number().integer().min(1).max(5).optional(),
  affectedCIId: Joi.string().optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(1000).default(50),
});

const changeFiltersSchema = Joi.object({
  status: Joi.string()
    .valid('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'IN_PROGRESS', 'IMPLEMENTED', 'CLOSED', 'CANCELLED')
    .optional(),
  changeType: Joi.string().valid('STANDARD', 'NORMAL', 'EMERGENCY').optional(),
  requestedBy: Joi.string().optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(1000).default(50),
});

// ============================================================================
// Configuration Items (ITIL Management)
// ============================================================================

itilRoutes.get(
  '/configuration-items',
  validateOptional(ciFiltersSchema, 'query'),
  controller.getConfigurationItems.bind(controller)
);

itilRoutes.get(
  '/configuration-items/:id',
  controller.getConfigurationItem.bind(controller)
);

itilRoutes.patch(
  '/configuration-items/:id/lifecycle',
  authMiddleware.requirePermission('write'),
  validateRequest(updateLifecycleSchema, 'body'),
  controller.updateLifecycleStage.bind(controller)
);

itilRoutes.patch(
  '/configuration-items/:id/status',
  authMiddleware.requirePermission('write'),
  validateRequest(updateConfigStatusSchema, 'body'),
  controller.updateConfigurationStatus.bind(controller)
);

itilRoutes.get(
  '/configuration-items/:id/history',
  controller.getCIHistory.bind(controller)
);

itilRoutes.get(
  '/configuration-items/audit/due',
  controller.getCIsDueForAudit.bind(controller)
);

itilRoutes.post(
  '/configuration-items/:id/audit',
  authMiddleware.requirePermission('write'),
  validateRequest(scheduleAuditSchema, 'body'),
  controller.scheduleAudit.bind(controller)
);

itilRoutes.post(
  '/configuration-items/:id/audit/complete',
  authMiddleware.requirePermission('write'),
  validateRequest(completeAuditSchema, 'body'),
  controller.completeAudit.bind(controller)
);

// ============================================================================
// Incidents
// ============================================================================

itilRoutes.post(
  '/incidents',
  authMiddleware.requirePermission('write'),
  validateRequest(createIncidentSchema, 'body'),
  controller.createIncident.bind(controller)
);

itilRoutes.get(
  '/incidents',
  validateOptional(incidentFiltersSchema, 'query'),
  controller.getIncidents.bind(controller)
);

itilRoutes.get(
  '/incidents/:id',
  controller.getIncident.bind(controller)
);

itilRoutes.patch(
  '/incidents/:id',
  authMiddleware.requirePermission('write'),
  validateRequest(updateIncidentSchema, 'body'),
  controller.updateIncident.bind(controller)
);

itilRoutes.post(
  '/incidents/:id/resolve',
  authMiddleware.requirePermission('write'),
  validateRequest(resolveIncidentSchema, 'body'),
  controller.resolveIncident.bind(controller)
);

itilRoutes.get(
  '/incidents/:id/priority',
  controller.getIncidentPriority.bind(controller)
);

// ============================================================================
// Changes
// ============================================================================

itilRoutes.post(
  '/changes',
  authMiddleware.requirePermission('write'),
  validateRequest(createChangeSchema, 'body'),
  controller.createChange.bind(controller)
);

itilRoutes.get(
  '/changes',
  validateOptional(changeFiltersSchema, 'query'),
  controller.getChanges.bind(controller)
);

itilRoutes.get(
  '/changes/:id',
  controller.getChange.bind(controller)
);

itilRoutes.patch(
  '/changes/:id',
  authMiddleware.requirePermission('write'),
  validateRequest(updateChangeSchema, 'body'),
  controller.updateChange.bind(controller)
);

itilRoutes.get(
  '/changes/:id/risk-assessment',
  controller.assessChangeRisk.bind(controller)
);

itilRoutes.post(
  '/changes/:id/approve',
  authMiddleware.requirePermission('write'),
  controller.approveChange.bind(controller)
);

itilRoutes.post(
  '/changes/:id/implement',
  authMiddleware.requirePermission('write'),
  controller.implementChange.bind(controller)
);

itilRoutes.post(
  '/changes/:id/close',
  authMiddleware.requirePermission('write'),
  validateRequest(closeChangeSchema, 'body'),
  controller.closeChange.bind(controller)
);

// ============================================================================
// Baselines
// ============================================================================

itilRoutes.post(
  '/baselines',
  authMiddleware.requireOrganization(),
  authMiddleware.requirePermission('write'),
  validateRequest(createBaselineSchema, 'body'),
  controller.createBaseline.bind(controller)
);

itilRoutes.get(
  '/baselines',
  authMiddleware.requireOrganization(),
  controller.getBaselines.bind(controller)
);

itilRoutes.get(
  '/baselines/:id',
  authMiddleware.requireOrganization(),
  controller.getBaseline.bind(controller)
);

itilRoutes.delete(
  '/baselines/:id',
  authMiddleware.requireOrganization(),
  authMiddleware.requirePermission('write'),
  controller.deleteBaseline.bind(controller)
);

itilRoutes.get(
  '/baselines/:id/comparison',
  authMiddleware.requireOrganization(),
  controller.compareToBaseline.bind(controller)
);

itilRoutes.post(
  '/baselines/:id/restore',
  authMiddleware.requirePermission('write'),
  authMiddleware.requireOrganization(),
  validateRequest(restoreFromBaselineSchema, 'body'),
  controller.restoreFromBaseline.bind(controller)
);

// ============================================================================
// Metrics
// ============================================================================

itilRoutes.get(
  '/metrics/configuration-accuracy',
  controller.getConfigurationAccuracy.bind(controller)
);

itilRoutes.get(
  '/metrics/incident-summary',
  controller.getIncidentSummary.bind(controller)
);

itilRoutes.get(
  '/metrics/change-success-rate',
  controller.getChangeSuccessRate.bind(controller)
);

itilRoutes.get(
  '/metrics/mttr',
  controller.getMeanTimeToResolve.bind(controller)
);

itilRoutes.get(
  '/metrics/mtbf',
  controller.getMeanTimeBetweenFailures.bind(controller)
);
