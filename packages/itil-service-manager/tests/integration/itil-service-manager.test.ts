// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Exercises CI and risk services against shared integration containers.
 * Unscoped standalone record writers must be rejected by HP1-S2 V1 guards;
 * tenant-owned record operations live on the authenticated REST/GraphQL API.
 * Kafka is not started, so event emission is stubbed.
 */

import { getNeo4jClient, getPostgresClient, closeQueueManagerConnection } from '@cmdb/database';
import { ConfigurationManagementService } from '../../src/services/configuration-management.service';
import { IncidentPriorityService } from '../../src/services/incident-priority.service';
import { ChangeRiskService } from '../../src/services/change-risk.service';
import { BaselineService } from '../../src/services/baseline.service';
import { v4 as uuidv4 } from 'uuid';

// Kafka is not started for integration tests. Stub the event producer so the
// configuration-management service's event emission is a no-op rather than a
// real Kafka connection attempt.
jest.mock('@cmdb/event-streaming', () => ({
  DiscoveryProducer: class {
    async connect(): Promise<void> {
      return undefined;
    }
    async disconnect(): Promise<void> {
      return undefined;
    }
    async publishCIUpdated(): Promise<void> {
      return undefined;
    }
    async publishCIDiscovered(): Promise<void> {
      return undefined;
    }
    async publishCIDeleted(): Promise<void> {
      return undefined;
    }
    async publishRelationshipCreated(): Promise<void> {
      return undefined;
    }
    async publishRelationshipDeleted(): Promise<void> {
      return undefined;
    }
    async publishBatch(): Promise<void> {
      return undefined;
    }
  },
}));

interface SeedCIOptions {
  id: string;
  name?: string;
  type?: string;
  status?: string;
  environment?: string;
  itilAttributes?: Record<string, unknown>;
  bsmAttributes?: Record<string, unknown>;
  tbmAttributes?: Record<string, unknown>;
}

const CI_ID_PREFIX = 'itil-test-';
const BS_OWNER = 'itil-itest';

describe('ITIL Service Manager Integration Tests', () => {
  /**
   * Seed a CI node in Neo4j. JSON attribute bags are stored as strings, exactly
   * as the repositories read them back via JSON.parse.
   */
  async function seedCI(options: SeedCIOptions): Promise<void> {
    const session = getNeo4jClient().getSession();
    try {
      await session.run(
        `
        CREATE (ci:CI {
          id: $id,
          name: $name,
          type: $type,
          status: $status,
          environment: $environment,
          itil_attributes: $itil,
          bsm_attributes: $bsm,
          tbm_attributes: $tbm,
          metadata: $metadata,
          created_at: datetime(),
          updated_at: datetime()
        })
        `,
        {
          id: options.id,
          name: options.name ?? options.id,
          type: options.type ?? 'server',
          status: options.status ?? 'active',
          environment: options.environment ?? 'production',
          itil: JSON.stringify(options.itilAttributes ?? {}),
          bsm: JSON.stringify(options.bsmAttributes ?? { business_criticality: 'tier_3' }),
          tbm: JSON.stringify(options.tbmAttributes ?? {}),
          metadata: JSON.stringify({}),
        }
      );
    } finally {
      await session.close();
    }
  }

  /** Read raw CI node properties back from Neo4j. */
  async function readCI(ciId: string): Promise<Record<string, unknown> | null> {
    const session = getNeo4jClient().getSession();
    try {
      const result = await session.run('MATCH (ci:CI {id: $ciId}) RETURN ci', { ciId });
      if (result.records.length === 0) {
        return null;
      }
      return result.records[0].get('ci').properties as Record<string, unknown>;
    } finally {
      await session.close();
    }
  }

  /**
   * Seed a business service (Postgres row + Neo4j node) that DEPENDS_ON a CI,
   * matching the graph traversal in BusinessServiceRepository.
   */
  async function seedBusinessService(opts: {
    ciId: string;
    name: string;
    bsmAttributes: Record<string, unknown>;
    itilAttributes: Record<string, unknown>;
    operationalStatus?: string;
    technicalOwner?: string;
  }): Promise<string> {
    const id = uuidv4();
    await getPostgresClient().query(
      `
      INSERT INTO business_services (
        id, name, itil_attributes, tbm_attributes, bsm_attributes,
        technical_owner, operational_status, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        id,
        opts.name,
        JSON.stringify(opts.itilAttributes),
        JSON.stringify({}),
        JSON.stringify(opts.bsmAttributes),
        opts.technicalOwner ?? 'svc-owner',
        opts.operationalStatus ?? 'operational',
        BS_OWNER,
      ]
    );

    const session = getNeo4jClient().getSession();
    try {
      await session.run(
        `
        MATCH (ci:CI {id: $ciId})
        CREATE (bs:BusinessService { id: $bsId, name: $name })
        CREATE (bs)-[:DEPENDS_ON]->(ci)
        `,
        { ciId: opts.ciId, bsId: id, name: opts.name }
      );
    } finally {
      await session.close();
    }

    return id;
  }

  async function cleanup(): Promise<void> {
    const session = getNeo4jClient().getSession();
    try {
      await session.run(
        'MATCH (n) WHERE n.id STARTS WITH $prefix DETACH DELETE n',
        { prefix: CI_ID_PREFIX }
      );
      // Business service nodes are keyed by uuid, not the test prefix; remove
      // any that were attached to the test CIs (now already deleted) by label.
      await session.run('MATCH (bs:BusinessService) DETACH DELETE bs');
    } finally {
      await session.close();
    }

    const pg = getPostgresClient();
    await pg.query('DELETE FROM business_services WHERE created_by = $1', [BS_OWNER]);
    await pg.query('DELETE FROM itil_incidents WHERE affected_ci_id LIKE $1', [`${CI_ID_PREFIX}%`]);
    await pg.query(
      `DELETE FROM itil_changes WHERE EXISTS (
         SELECT 1 FROM unnest(affected_ci_ids) AS cid WHERE cid LIKE $1
       )`,
      [`${CI_ID_PREFIX}%`]
    );
    await pg.query('DELETE FROM itil_baselines WHERE created_by = $1', [BS_OWNER]);
  }

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await closeQueueManagerConnection();
  });

  describe('Configuration Management Service', () => {
    it('should update CI lifecycle and publish event', async () => {
      const ciId = `${CI_ID_PREFIX}cfg-lifecycle`;
      await seedCI({
        id: ciId,
        itilAttributes: {
          lifecycle_stage: 'design',
          configuration_status: 'in_development',
          audit_status: 'unknown',
        },
        bsmAttributes: { business_criticality: 'tier_2' },
      });

      const service = new ConfigurationManagementService();
      const updated = await service.updateLifecycleStage(ciId, 'build', 'tester', 'ready to build');

      expect(updated.id).toBe(ciId);
      expect(updated.itil_attributes.lifecycle_stage).toBe('build');

      // Persisted to Neo4j.
      const persisted = await readCI(ciId);
      expect(persisted).not.toBeNull();
      const itil = JSON.parse(persisted!.itil_attributes as string);
      expect(itil.lifecycle_stage).toBe('build');
    });

    it('rejects an invalid lifecycle transition', async () => {
      const ciId = `${CI_ID_PREFIX}cfg-invalid`;
      await seedCI({
        id: ciId,
        itilAttributes: { lifecycle_stage: 'operate', configuration_status: 'active' },
        bsmAttributes: { business_criticality: 'tier_2' },
      });

      const service = new ConfigurationManagementService();
      // operate -> build is not a permitted transition (operate can only retire).
      await expect(service.updateLifecycleStage(ciId, 'build', 'tester')).rejects.toThrow(
        /Invalid lifecycle transition/
      );
    });

    it('should complete audit and update CI', async () => {
      const ciId = `${CI_ID_PREFIX}cfg-audit`;
      await seedCI({
        id: ciId,
        itilAttributes: {
          lifecycle_stage: 'operate',
          configuration_status: 'active',
          audit_status: 'unknown',
        },
        bsmAttributes: { business_criticality: 'tier_2' },
      });

      const service = new ConfigurationManagementService();
      const result = await service.completeAudit(
        ciId,
        'compliant',
        'auditor',
        ['no findings'],
        ['keep monitoring']
      );

      expect(result.ciId).toBe(ciId);
      expect(result.auditStatus).toBe('compliant');
      expect(result.auditedBy).toBe('auditor');
      expect(result.findings).toEqual(['no findings']);
      expect(result.recommendations).toEqual(['keep monitoring']);
      expect(result.auditDate).toBeInstanceOf(Date);
      expect(result.nextAuditDate).toBeInstanceOf(Date);
      expect(result.nextAuditDate.getTime()).toBeGreaterThan(result.auditDate.getTime());

      // Persisted audit status.
      const persisted = await readCI(ciId);
      const itil = JSON.parse(persisted!.itil_attributes as string);
      expect(itil.audit_status).toBe('compliant');
    });
  });

  describe('Incident Priority Service', () => {
    it('rejects an incident from the standalone writer without tenant authority', async () => {
      const ciId = `${CI_ID_PREFIX}inc-create`;
      await seedCI({ id: ciId, itilAttributes: { lifecycle_stage: 'operate' },
        bsmAttributes: { business_criticality: 'tier_1', customer_count: 5000 } });
      const service = new IncidentPriorityService();
      await expect(service.createIncident({
        affectedCIId: ciId,
        title: 'Database unavailable',
        description: 'Primary database is not responding',
        category: 'availability',
        subcategory: 'database',
        reportedBy: 'itil-itest-unowned',
        symptoms: ['timeouts'],
      })).rejects.toMatchObject({ code: '23514' });
      const rows = await getPostgresClient().query(
        'SELECT COUNT(*)::int AS count FROM itil_incidents WHERE reported_by = $1',
        ['itil-itest-unowned']);
      expect(rows.rows[0].count).toBe(0);
    });
    it('should calculate priority based on affected business services', async () => {
      const ciId = `${CI_ID_PREFIX}inc-bsm`;
      // The CI itself is only tier_3; the dependent business service is tier_1
      // and must drive the impact up to critical.
      await seedCI({
        id: ciId,
        itilAttributes: { lifecycle_stage: 'operate' },
        bsmAttributes: { business_criticality: 'tier_3', customer_count: 0 },
      });
      await seedBusinessService({
        ciId,
        name: 'Checkout Service',
        bsmAttributes: {
          business_criticality: 'tier_1',
          customer_count: 5000,
          annual_revenue_supported: 5_000_000,
        },
        itilAttributes: {
          support_level: 'l1',
          service_hours: { availability: '24x7', timezone: 'UTC' },
          sla_targets: { availability_percentage: 99.9, response_time_ms: 1000 },
        },
        operationalStatus: 'outage',
        technicalOwner: 'platform-team',
      });

      const service = new IncidentPriorityService();
      const priority = await service.calculatePriority({
        affectedCIId: ciId,
        title: 'Checkout failing',
        description: 'Checkout requests failing',
        reportedBy: 'oncall',
        symptoms: ['errors'],
      });

      expect(priority.affectedBusinessServices).toHaveLength(1);
      expect(priority.affectedBusinessServices[0].name).toBe('Checkout Service');
      // Escalated to critical because of the tier_1 dependent service.
      expect(priority.impact).toBe('critical');
      expect(priority.estimatedUserImpact).toBe(5000);
      expect(priority.recommendedResponseTeam.length).toBeGreaterThan(0);
    });
  });

  describe('Change Risk Service', () => {
    it('rejects a change from the standalone writer without tenant authority', async () => {
      const ciId = `${CI_ID_PREFIX}chg-create`;
      await seedCI({ id: ciId, bsmAttributes: { business_criticality: 'tier_2', customer_count: 100 } });
      const service = new ChangeRiskService();
      await expect(service.createChange({
        affectedCIIds: [ciId],
        title: 'Upgrade database engine',
        description: 'Apply minor version upgrade',
        changeType: 'normal',
        category: 'maintenance',
        plannedStart: new Date('2026-07-01T02:00:00Z'),
        plannedEnd: new Date('2026-07-01T04:00:00Z'),
        implementationPlan: 'Run upgrade script',
        backoutPlan: 'Restore from snapshot',
        testPlan: 'Validate in staging',
        requestedBy: 'itil-itest-unowned',
      })).rejects.toMatchObject({ code: '23514' });
      const rows = await getPostgresClient().query(
        'SELECT COUNT(*)::int AS count FROM itil_changes WHERE requested_by = $1',
        ['itil-itest-unowned']);
      expect(rows.rows[0].count).toBe(0);
    });
    it('should determine CAB approval requirement', async () => {
      const ciId = `${CI_ID_PREFIX}chg-cab`;
      await seedCI({
        id: ciId,
        itilAttributes: { lifecycle_stage: 'operate' },
        bsmAttributes: { business_criticality: 'tier_2', customer_count: 100 },
      });

      const service = new ChangeRiskService();
      const baseRequest = {
        affectedCIIds: [ciId],
        title: 'Change',
        description: 'A change',
        category: 'maintenance',
        plannedStart: new Date('2026-07-01T02:00:00Z'),
        plannedEnd: new Date('2026-07-01T03:00:00Z'),
        implementationPlan: 'plan',
        backoutPlan: 'backout',
        testPlan: 'tested',
        requestedBy: 'change-mgr',
      };

      // Major changes always require CAB approval.
      const major = await service.assessChangeRisk({ ...baseRequest, changeType: 'major' });
      expect(major.requiresCABApproval).toBe(true);
      expect(service.requiresCABApproval(major)).toBe(true);

      // A standard, low-risk change with no revenue at risk does not.
      const standard = await service.assessChangeRisk({ ...baseRequest, changeType: 'standard' });
      expect(standard.requiresCABApproval).toBe(false);
    });
  });

  describe('Baseline Service', () => {
    it('rejects a baseline from the standalone writer without tenant authority', async () => {
      const ciId = `${CI_ID_PREFIX}bl-create`;
      const name = `${CI_ID_PREFIX}baseline-unowned`;
      await seedCI({ id: ciId, status: 'active', environment: 'production',
        itilAttributes: { lifecycle_stage: 'operate', version: '1.0.0' },
        bsmAttributes: { business_criticality: 'tier_2' } });
      const service = new BaselineService();
      await expect(service.createBaseline(name, [ciId], 'Unowned baseline', 'configuration', BS_OWNER))
        .rejects.toMatchObject({ code: '23514' });
      const rows = await getPostgresClient().query(
        'SELECT COUNT(*)::int AS count FROM itil_baselines WHERE name = $1', [name]);
      expect(rows.rows[0].count).toBe(0);
    });
  });
});
