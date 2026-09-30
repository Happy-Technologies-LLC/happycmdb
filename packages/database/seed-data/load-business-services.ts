// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Business Service Seed Data Loader (TBM v5.0.1 Foundation)
 *
 * Loads TBM-based business service templates into PostgreSQL
 * Provides foundation for Business Service Management (BSM)
 *
 * Usage:
 *   node load-business-services.ts
 *   npm run seed:business-services
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { getPostgresClient } from '../src/postgres/client';
import { logger } from '@cmdb/common';

/**
 * Seed templates belong to the internal organization, the same id migration
 * 008_business_service_organization_scope.sql backfills existing rows to.
 */
const INTERNAL_ORGANIZATION_ID = '00000000-0000-0000-0000-000000000000';

interface BusinessService {
  id: string;
  name: string;
  description: string;
  service_classification: string;
  tbm_tower: string;
  business_criticality: string;
  operational_status: string;
  service_type?: string;
  owned_by?: string;
  managed_by?: string;
  support_group?: string;
  service_level_requirement?: string;
  category?: string;
  tags?: string[];
  related_ci_types?: string[];
  cost_allocation?: {
    chargeback_enabled: boolean;
    tbm_pool: string;
  };
}

interface ServiceDependency {
  service_id: string;
  depends_on: string[];
  dependency_type: string;
}

interface SeedData {
  business_services: BusinessService[];
  service_dependencies: ServiceDependency[];
}

/**
 * Load business service seed data from JSON file
 */
async function loadBusinessServices(): Promise<void> {
  const startTime = Date.now();

  logger.info('[LoadBusinessServices] Starting seed data load...');

  try {
    // Read seed data file
    const seedDataPath = join(__dirname, 'business-services-tbm.json');
    const seedDataJSON = readFileSync(seedDataPath, 'utf-8');
    const seedData: SeedData = JSON.parse(seedDataJSON);

    logger.info('[LoadBusinessServices] Loaded seed data', {
      services: seedData.business_services.length,
      dependencies: seedData.service_dependencies.length,
    });

    const pgClient = getPostgresClient();
    const pool = pgClient.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Step 1: Insert business services
      logger.info('[LoadBusinessServices] Inserting business services...');

      let servicesInserted = 0;
      let servicesSkipped = 0;

      for (const service of seedData.business_services) {
        try {
          // Check if service already exists
          const existingResult = await client.query(
            'SELECT service_id FROM dim_business_services WHERE service_id = $1',
            [service.id]
          );

          if (existingResult.rows.length > 0) {
            logger.debug('[LoadBusinessServices] Service already exists, skipping', {
              service_id: service.id,
            });
            servicesSkipped++;
            continue;
          }

          // Insert business service
          await client.query(
            `INSERT INTO dim_business_services (
              service_id,
              name,
              description,
              service_classification,
              tbm_tower,
              business_criticality,
              operational_status,
              service_type,
              owned_by,
              managed_by,
              support_group,
              service_level_requirement,
              category,
              tags,
              related_ci_types,
              cost_allocation,
              metadata,
              organization_id,
              created_at,
              updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW(), NOW())`,
            [
              service.id,
              service.name,
              service.description,
              service.service_classification,
              service.tbm_tower,
              service.business_criticality,
              service.operational_status,
              service.service_type,
              service.owned_by,
              service.managed_by,
              service.support_group,
              service.service_level_requirement,
              service.category,
              service.tags,
              service.related_ci_types,
              JSON.stringify(service.cost_allocation),
              '{}', // Empty metadata for seed data
              INTERNAL_ORGANIZATION_ID,
            ]
          );

          servicesInserted++;
          logger.debug('[LoadBusinessServices] Inserted business service', {
            service_id: service.id,
            name: service.name,
          });
        } catch (error) {
          logger.error('[LoadBusinessServices] Failed to insert business service', {
            service_id: service.id,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }

      logger.info('[LoadBusinessServices] Business services inserted', {
        inserted: servicesInserted,
        skipped: servicesSkipped,
      });

      // Step 2: Insert service dependencies
      logger.info('[LoadBusinessServices] Inserting service dependencies...');

      let dependenciesInserted = 0;

      for (const dep of seedData.service_dependencies) {
        for (const dependsOnServiceId of dep.depends_on) {
          try {
            // Check if dependency already exists
            const existingDepResult = await client.query(
              `SELECT id FROM business_service_dependencies
               WHERE service_id = $1 AND depends_on_service_id = $2`,
              [dep.service_id, dependsOnServiceId]
            );

            if (existingDepResult.rows.length > 0) {
              continue; // Skip if already exists
            }

            // Insert dependency
            await client.query(
              `INSERT INTO business_service_dependencies (
                service_id,
                depends_on_service_id,
                dependency_type,
                created_at
              ) VALUES ($1, $2, $3, NOW())`,
              [dep.service_id, dependsOnServiceId, dep.dependency_type]
            );

            dependenciesInserted++;
          } catch (error) {
            // Log error but continue (in case of foreign key violations for optional deps)
            logger.warn('[LoadBusinessServices] Failed to insert dependency', {
              service_id: dep.service_id,
              depends_on: dependsOnServiceId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      logger.info('[LoadBusinessServices] Service dependencies inserted', {
        inserted: dependenciesInserted,
      });

      await client.query('COMMIT');

      const durationMs = Date.now() - startTime;
      logger.info('[LoadBusinessServices] Seed data load completed successfully', {
        servicesInserted,
        servicesSkipped,
        dependenciesInserted,
        durationMs,
        durationSeconds: Math.round(durationMs / 1000),
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('[LoadBusinessServices] Transaction failed, rolled back', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('[LoadBusinessServices] Seed data load failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

// Run if executed directly
if (require.main === module) {
  loadBusinessServices()
    .then(() => {
      logger.info('[LoadBusinessServices] Seed data load script completed');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('[LoadBusinessServices] Seed data load script failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
}

export { loadBusinessServices };
