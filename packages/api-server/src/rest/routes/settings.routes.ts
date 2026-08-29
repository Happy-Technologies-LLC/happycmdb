// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Settings Routes
 *
 * Routes for GeneralSettings, NotificationSettings, DatabaseSettings, and
 * DiscoverySettings (web-ui/src/components/settings/*). Mounted centrally
 * at /api/v1/settings by rest/server.ts, which also applies
 * `authMiddleware.authenticate()` to every /api/v1 route before this
 * router -- individual routes below only need to layer additional
 * role/permission gates (e.g. `requireRole('admin')`) on top.
 */

import { Router } from 'express';
import { SettingsController } from '../controllers/settings.controller';
import { validateRequest } from '../middleware/validation.middleware';
import { settingsSchemas } from '../../validation/schemas';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';

export const settingsRoutes = Router();
const controller = new SettingsController();
const authMiddleware = getAuthMiddleware();

// PUT /settings - general application preferences (authenticated user scope)
settingsRoutes.put(
  '/',
  validateRequest(settingsSchemas.general, 'body'),
  controller.updateGeneralSettings.bind(controller)
);

// PUT /settings/notifications
settingsRoutes.put(
  '/notifications',
  validateRequest(settingsSchemas.notifications, 'body'),
  controller.updateNotificationSettings.bind(controller)
);

// GET /settings/database - admin only
settingsRoutes.get(
  '/database',
  authMiddleware.requireRole('admin'),
  controller.getDatabaseStatus.bind(controller)
);

// PUT /settings/discovery/:provider
settingsRoutes.put(
  '/discovery/:provider',
  validateRequest(settingsSchemas.discoveryProvider, 'body'),
  controller.updateDiscoveryProviderSettings.bind(controller)
);
