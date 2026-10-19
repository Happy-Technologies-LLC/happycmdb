import { Pool } from 'pg';
import { AuditLogEntry, AuditLogQuery, AuditLogResponse } from '@cmdb/common';
import { type ChainVerification } from '@happy-technologies/audit';
export declare const AUDIT_CHAIN_PARTITION = "global";
export type HP1ChainVerification = ChainVerification & {
    orgBindingViolations: string[];
};
export declare class AuditService {
    private pool;
    constructor(pool: Pool);
    logAudit(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>, organizationId: string): Promise<void>;
    verifyAuditChain(): Promise<HP1ChainVerification>;
    logCICreate(ciId: string, organizationId: string, actor: string, actorType: 'user' | 'system' | 'discovery', newData: Record<string, unknown>): Promise<void>;
    logCIUpdate(ciId: string, organizationId: string, actor: string, actorType: 'user' | 'system' | 'discovery', oldData: Record<string, unknown>, newData: Record<string, unknown>, metadata?: Record<string, unknown>): Promise<void>;
    logCIDelete(ciId: string, organizationId: string, actor: string, actorType: 'user' | 'system' | 'discovery', deletedData: Record<string, unknown>): Promise<void>;
    logRelationshipAdd(fromId: string, toId: string, type: string, organizationId: string, actor: string, actorType: 'user' | 'system' | 'discovery', properties?: Record<string, unknown>): Promise<void>;
    logRelationshipRemove(fromId: string, toId: string, type: string, organizationId: string, actor: string, actorType: 'user' | 'system' | 'discovery', properties?: Record<string, unknown>): Promise<void>;
    logDiscoveryUpdate(ciId: string, discoveryJobId: string, organizationId: string, oldData: Record<string, unknown>, newData: Record<string, unknown>): Promise<void>;
    queryAuditLogs(query: AuditLogQuery & {
        organizationId?: string;
    }): Promise<AuditLogResponse>;
    getCIAuditHistory(ciId: string, organizationId: string, limit?: number): Promise<AuditLogEntry[]>;
}
export declare function getAuditService(pool: Pool): AuditService;
//# sourceMappingURL=audit.service.d.ts.map