"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditService = exports.AUDIT_CHAIN_PARTITION = void 0;
exports.getAuditService = getAuditService;
const crypto_1 = require("crypto");
const common_1 = require("@cmdb/common");
const audit_1 = require("@happy-technologies/audit");
exports.AUDIT_CHAIN_PARTITION = 'global';
function toChainFields(row) {
    return {
        id: row.id,
        action: row.action,
        actorId: row.actor,
        tenantId: exports.AUDIT_CHAIN_PARTITION,
        resourceType: row.entity_type,
        resourceId: row.entity_id,
        metadata: row.metadata ?? {},
        ipAddress: row.ip_address ?? null,
        userAgent: row.user_agent ?? null,
    };
}
let auditChainKernel = null;
function getAuditChainKernel() {
    if (!auditChainKernel) {
        const secret = process.env['AUDIT_CHAIN_KEY'];
        if (!secret) {
            throw new Error('AUDIT_CHAIN_KEY environment variable is not set; it is required to compute or verify the audit hash chain');
        }
        auditChainKernel = (0, audit_1.createAuditChain)(secret);
    }
    return auditChainKernel;
}
class AuditService {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async logAudit(entry, organizationId) {
        if (!organizationId || !entry['actor'])
            throw new Error('Verified actor and organization required');
        let client;
        try {
            client = await this.pool.connect();
            await client.query('BEGIN');
            try {
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [exports.AUDIT_CHAIN_PARTITION]);
                const prevResult = await client.query(`
          SELECT entry_hash FROM audit_log
          WHERE entry_hash IS NOT NULL
          ORDER BY timestamp DESC, id DESC
          LIMIT 1
          `);
                const prevHash = prevResult.rows[0]?.entry_hash ?? null;
                const id = (0, crypto_1.randomUUID)();
                const metadata = { ...(entry['metadata'] ?? {}), organization_id: organizationId };
                const chainFields = toChainFields({
                    id,
                    action: entry['action'],
                    actor: entry['actor'],
                    entity_type: entry['entity_type'],
                    entity_id: entry['entity_id'],
                    metadata,
                    ip_address: entry['ip_address'] ?? null,
                    user_agent: entry['user_agent'] ?? null,
                });
                const entryHash = getAuditChainKernel().computeEntryHash(chainFields, prevHash);
                await client.query(`
          INSERT INTO audit_log (
            id, entity_type, entity_id, action, actor, actor_type, changes,
            metadata, ip_address, user_agent, prev_hash, entry_hash, organization_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          `, [
                    id, entry['entity_type'], entry['entity_id'], entry['action'],
                    entry['actor'], entry['actor_type'], JSON.stringify(entry['changes']),
                    JSON.stringify(metadata), entry['ip_address'] || null,
                    entry['user_agent'] || null, prevHash, entryHash, organizationId,
                ]);
                await client.query('COMMIT');
            }
            catch (txError) {
                await client.query('ROLLBACK');
                throw txError;
            }
        }
        catch (error) {
            common_1.logger.error('Failed to log audit entry');
            throw error;
        }
        finally {
            client?.release();
        }
    }
    async verifyAuditChain() {
        const result = await this.pool.query(`
      SELECT id, entity_type, entity_id, action, actor, metadata, organization_id, ip_address, user_agent, prev_hash, entry_hash
      FROM audit_log
      ORDER BY timestamp ASC, id ASC
      `);
        const rows = result.rows.map((row) => ({
            ...toChainFields(row),
            prevHash: row.prev_hash ?? null,
            entryHash: row.entry_hash ?? null,
        }));
        const kernel = getAuditChainKernel().verifyAuditChain(rows);
        const orgBindingViolations = result.rows.filter(row => row.organization_id === null
            ? row.metadata !== null && Object.prototype.hasOwnProperty.call(row.metadata, 'organization_id')
            : row.metadata?.['organization_id'] !== row.organization_id).map(row => row.id);
        return { ...kernel, ok: kernel.ok && orgBindingViolations.length === 0, orgBindingViolations };
    }
    async logCICreate(ciId, organizationId, actor, actorType, newData) {
        const changes = Object.entries(newData).map(([field, value]) => ({
            field,
            old_value: null,
            new_value: value,
        }));
        await this.logAudit({
            entity_type: 'CI',
            entity_id: ciId,
            action: 'CREATE',
            actor,
            actor_type: actorType,
            changes,
        }, organizationId);
    }
    async logCIUpdate(ciId, organizationId, actor, actorType, oldData, newData, metadata) {
        const changes = [];
        for (const [field, newValue] of Object.entries(newData)) {
            const oldValue = oldData[field];
            if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
                changes.push({
                    field,
                    old_value: oldValue,
                    new_value: newValue,
                });
            }
        }
        if (changes.length > 0) {
            await this.logAudit({
                entity_type: 'CI',
                entity_id: ciId,
                action: 'UPDATE',
                actor,
                actor_type: actorType,
                changes,
                metadata,
            }, organizationId);
        }
    }
    async logCIDelete(ciId, organizationId, actor, actorType, deletedData) {
        const changes = Object.entries(deletedData).map(([field, value]) => ({
            field,
            old_value: value,
            new_value: null,
        }));
        await this.logAudit({
            entity_type: 'CI',
            entity_id: ciId,
            action: 'DELETE',
            actor,
            actor_type: actorType,
            changes,
        }, organizationId);
    }
    async logRelationshipAdd(fromId, toId, type, organizationId, actor, actorType, properties) {
        const relationshipId = `${fromId}-${type}-${toId}`;
        await this.logAudit({
            entity_type: 'RELATIONSHIP',
            entity_id: relationshipId,
            action: 'RELATIONSHIP_ADD',
            actor,
            actor_type: actorType,
            changes: [
                { field: 'from_id', old_value: null, new_value: fromId },
                { field: 'to_id', old_value: null, new_value: toId },
                { field: 'type', old_value: null, new_value: type },
                { field: 'properties', old_value: null, new_value: properties },
            ],
        }, organizationId);
    }
    async logRelationshipRemove(fromId, toId, type, organizationId, actor, actorType, properties) {
        const relationshipId = `${fromId}-${type}-${toId}`;
        await this.logAudit({
            entity_type: 'RELATIONSHIP',
            entity_id: relationshipId,
            action: 'RELATIONSHIP_REMOVE',
            actor,
            actor_type: actorType,
            changes: [
                { field: 'from_id', old_value: fromId, new_value: null },
                { field: 'to_id', old_value: toId, new_value: null },
                { field: 'type', old_value: type, new_value: null },
                { field: 'properties', old_value: properties, new_value: null },
            ],
        }, organizationId);
    }
    async logDiscoveryUpdate(ciId, discoveryJobId, organizationId, oldData, newData) {
        const changes = [];
        for (const [field, newValue] of Object.entries(newData)) {
            const oldValue = oldData[field];
            if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
                changes.push({
                    field,
                    old_value: oldValue,
                    new_value: newValue,
                });
            }
        }
        if (changes.length > 0) {
            await this.logAudit({
                entity_type: 'CI',
                entity_id: ciId,
                action: 'DISCOVERY_UPDATE',
                actor: 'discovery-engine',
                actor_type: 'discovery',
                changes,
                metadata: {
                    discovery_job_id: discoveryJobId,
                },
            }, organizationId);
        }
    }
    async queryAuditLogs(query) {
        const client = await this.pool.connect();
        try {
            const conditions = [];
            const params = [];
            let paramIndex = 1;
            if (query.entity_type) {
                conditions.push(`entity_type = $${paramIndex++}`);
                params.push(query.entity_type);
            }
            if (query.entity_id) {
                conditions.push(`entity_id = $${paramIndex++}`);
                params.push(query.entity_id);
            }
            if (query.action) {
                conditions.push(`action = $${paramIndex++}`);
                params.push(query.action);
            }
            if (query.actor) {
                conditions.push(`actor = $${paramIndex++}`);
                params.push(query.actor);
            }
            if (query.from_date) {
                conditions.push(`timestamp >= $${paramIndex++}`);
                params.push(query.from_date);
            }
            if (query.to_date) {
                conditions.push(`timestamp <= $${paramIndex++}`);
                params.push(query.to_date);
            }
            if (query.organizationId) {
                conditions.push(`organization_id = $${paramIndex}::uuid AND metadata->>'organization_id' = $${paramIndex}::text`);
                params.push(query.organizationId);
                paramIndex++;
            }
            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
            const countResult = await client.query(`SELECT COUNT(*) as total FROM audit_log ${whereClause}`, params);
            const total = parseInt(countResult.rows[0].total, 10);
            const limit = query.limit || 50;
            const offset = query.offset || 0;
            const page = Math.floor(offset / limit) + 1;
            const dataResult = await client.query(`
        SELECT
          id,
          entity_type,
          entity_id,
          action,
          actor,
          actor_type,
          changes,
          metadata,
          timestamp,
          ip_address,
          user_agent
        FROM audit_log
        ${whereClause}
        ORDER BY timestamp DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
        `, [...params, limit, offset]);
            const entries = dataResult.rows.map((row) => ({
                id: row.id,
                entity_type: row.entity_type,
                entity_id: row.entity_id,
                action: row.action,
                actor: row.actor,
                actor_type: row.actor_type,
                changes: row.changes,
                metadata: row.metadata,
                timestamp: row.timestamp.toISOString(),
                ip_address: row.ip_address,
                user_agent: row.user_agent,
            }));
            return {
                entries,
                total,
                page,
                limit,
                total_pages: Math.ceil(total / limit),
            };
        }
        finally {
            client.release();
        }
    }
    async getCIAuditHistory(ciId, organizationId, limit = 100) {
        if (!organizationId)
            throw new Error('Organization required for CI audit history');
        const response = await this.queryAuditLogs({
            entity_type: 'CI',
            entity_id: ciId,
            organizationId,
            limit,
        });
        return response.entries;
    }
}
exports.AuditService = AuditService;
let auditService = null;
function getAuditService(pool) {
    if (!auditService) {
        auditService = new AuditService(pool);
    }
    return auditService;
}
//# sourceMappingURL=audit.service.js.map