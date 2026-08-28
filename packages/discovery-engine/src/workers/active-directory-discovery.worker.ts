// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/discovery-engine/src/workers/active-directory-discovery.worker.ts

import * as ldap from 'ldapjs';
import { logger, withRetry } from '@cmdb/common';
import {
  DiscoveredCI,
  DiscoveryConfig,
  CIStatus,
  Relationship,
  UnifiedCredential,
  CredentialProtocolAdapter,
} from '@cmdb/common';

/**
 * Active Directory Discovery Configuration
 */
export interface ActiveDirectoryDiscoveryConfig extends DiscoveryConfig {
  /** LDAP server domain (e.g., dc.example.com) */
  domain: string;
  /** Base DN (e.g., DC=example,DC=com) */
  base_dn: string;
  /** Use SSL/TLS */
  use_ssl?: boolean;
  /** Computer resource configuration */
  computers?: {
    /** Only include computers active in last N days (default: 90) */
    active_days?: number;
    /** Include servers (default: true) */
    include_servers?: boolean;
    /** Include workstations (default: true) */
    include_workstations?: boolean;
  };
  /** User resource configuration */
  users?: {
    /** Only include active users (default: true) */
    active_only?: boolean;
  };
  /** Group resource configuration */
  groups?: {
    /** Only include security groups (default: false, includes distribution groups too) */
    security_only?: boolean;
  };
}

/**
 * Active Directory Discovery Worker
 *
 * Multi-resource discovery worker for Microsoft Active Directory environments.
 * Discovers computers, users, groups, and organizational units using LDAP protocol.
 *
 * Supported Resources:
 * - computers: Computer objects (servers and workstations)
 * - users: User accounts
 * - groups: Security and distribution groups
 * - organizational_units: Organizational Units
 *
 * @example
 * const worker = new ActiveDirectoryDiscoveryWorker('dc.example.com', 'DC=example,DC=com', credential);
 * const computers = await worker.discoverComputers(jobId, { active_days: 90 });
 * const relationships = worker.inferRelationships(allCIs);
 */
export class ActiveDirectoryDiscoveryWorker {
  private domain: string;
  private baseDN: string;
  private bindDN: string;
  private password: string;
  private useSSL: boolean;
  private port: number;
  private ldapUrl: string;

  constructor(
    domain: string,
    baseDN: string,
    credential?: UnifiedCredential,
    options?: { useSSL?: boolean; port?: number }
  ) {
    this.domain = domain;
    this.baseDN = baseDN;
    this.useSSL = options?.useSSL !== undefined ? options.useSSL : true;
    this.port = options?.port || (this.useSSL ? 636 : 389);

    // Build LDAP URL
    const protocol = this.useSSL ? 'ldaps' : 'ldap';
    this.ldapUrl = domain.startsWith('ldap://') || domain.startsWith('ldaps://')
      ? domain
      : `${protocol}://${domain}:${this.port}`;

    // Use LDAP protocol for Active Directory
    if (credential) {
      if (credential.protocol !== 'ldap') {
        throw new Error(
          `Invalid protocol for Active Directory: ${credential.protocol}. Expected ldap.`
        );
      }

      const ldapConfig = CredentialProtocolAdapter.toLDAPConfig(credential);
      this.bindDN = ldapConfig.bindDN;
      this.password = ldapConfig.password;

      // Override domain/baseDN if provided in credential
      if (ldapConfig.baseDN) {
        this.baseDN = ldapConfig.baseDN;
      }
      if (ldapConfig.url) {
        this.ldapUrl = ldapConfig.url;
      }
    } else {
      throw new Error('Active Directory discovery requires LDAP credentials');
    }
  }

  /**
   * Discover all resources from Active Directory
   * Executes discovery for all enabled resource types in parallel
   */
  async discoverAll(
    jobId: string,
    config: ActiveDirectoryDiscoveryConfig,
    resourceConfigs?: Record<string, any>
  ): Promise<DiscoveredCI[]> {
    logger.info('Starting Active Directory discovery', {
      jobId,
      domain: this.domain,
      baseDN: this.baseDN,
      config,
    });

    const results = await Promise.allSettled([
      this.discoverComputers(jobId, resourceConfigs?.computers),
      this.discoverUsers(jobId, resourceConfigs?.users),
      this.discoverGroups(jobId, resourceConfigs?.groups),
      this.discoverOrganizationalUnits(jobId, resourceConfigs?.organizational_units),
    ]);

    const allCIs: DiscoveredCI[] = [];
    const resourceNames = ['computers', 'users', 'groups', 'organizational_units'];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        allCIs.push(...result.value);
        logger.info(`Active Directory ${resourceNames[index]} discovered`, {
          jobId,
          count: result.value.length,
        });
      } else {
        logger.error(`Active Directory ${resourceNames[index]} discovery failed`, {
          jobId,
          error: result.reason,
        });
      }
    });

    logger.info('Active Directory discovery completed', {
      jobId,
      totalDiscovered: allCIs.length,
    });

    return allCIs;
  }

  /**
   * Discover Computer objects from Active Directory
   *
   * @param jobId - Discovery job identifier
   * @param resourceConfig - Resource-specific configuration
   *   - active_days: Only include computers active in last N days (default: 90)
   *   - include_servers: Include server objects (default: true)
   *   - include_workstations: Include workstation objects (default: true)
   */
  async discoverComputers(
    jobId: string,
    resourceConfig?: {
      active_days?: number;
      include_servers?: boolean;
      include_workstations?: boolean;
    }
  ): Promise<DiscoveredCI[]> {
    return withRetry(
      async () => {
        const cis: DiscoveredCI[] = [];
        const client = await this.createLDAPClient();

        try {
          // Calculate cutoff date for active computers
          const activeDays = resourceConfig?.active_days || 90;
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - activeDays);
          const cutoffTimestamp = this.dateToLDAPTimestamp(cutoffDate);

          // Build filter for computer objects
          // (objectClass=computer) AND (lastLogon >= cutoff OR lastLogonTimestamp >= cutoff)
          const filter = `(&(objectClass=computer)(|(lastLogon>=${cutoffTimestamp})(lastLogonTimestamp>=${cutoffTimestamp})))`;

          const opts: ldap.SearchOptions = {
            filter,
            scope: 'sub',
            attributes: [
              'cn',
              'name',
              'distinguishedName',
              'dNSHostName',
              'operatingSystem',
              'operatingSystemVersion',
              'whenCreated',
              'whenChanged',
              'lastLogon',
              'lastLogonTimestamp',
              'description',
              'location',
              'managedBy',
              'operatingSystemServicePack',
            ],
            paged: true,
            sizeLimit: 1000,
          };

          const entries = await this.searchLDAP(client, this.baseDN, opts);

          for (const entry of entries) {
            const attrs = (entry as any).pojo || entry;

            // Extract computer name
            const name = attrs.cn || attrs.name || 'unknown';
            const dn = attrs.distinguishedName;
            const hostname = attrs.dNSHostName;
            const os = attrs.operatingSystem;

            // Determine CI type based on OS
            const ciType = this.inferComputerType(os);

            // Filter based on include_servers and include_workstations
            const includeServers = resourceConfig?.include_servers !== false;
            const includeWorkstations = resourceConfig?.include_workstations !== false;

            if (ciType === 'server' && !includeServers) continue;
            if (ciType === 'virtual-machine' && !includeWorkstations) continue;

            // Parse last logon time
            const lastLogon = this.parseLDAPTimestamp(
              attrs.lastLogonTimestamp || attrs.lastLogon
            );

            // Determine status based on last logon
            const status: CIStatus = lastLogon && lastLogon > cutoffDate ? 'active' : 'inactive';

            // Infer environment from OU path
            const environment = this.inferEnvironmentFromDN(dn);

            cis.push({
              _id: `ad-computer-${this.sanitizeDN(dn)}`,
              external_id: dn,
              name: hostname || name,
              _type: ciType,
              status,
              environment,
              discovered_at: new Date().toISOString(),
              discovery_job_id: jobId,
              discovery_provider: 'active-directory' as any,
              confidence_score: 1.0,
              metadata: {
                resource_type: 'computer',
                domain: this.domain,
                distinguished_name: dn,
                dns_hostname: hostname,
                operating_system: os,
                operating_system_version: attrs.operatingSystemVersion,
                operating_system_service_pack: attrs.operatingSystemServicePack,
                when_created: attrs.whenCreated,
                when_changed: attrs.whenChanged,
                last_logon: lastLogon?.toISOString(),
                description: attrs.description,
                location: attrs.location,
                managed_by: attrs.managedBy,
                ou_path: this.extractOUPath(dn),
              } as Record<string, any>,
            });
          }

          logger.info('Computer objects discovered', {
            jobId,
            count: cis.length,
          });

          return cis;
        } finally {
          await this.closeLDAPClient(client);
        }
      },
      {
        maxAttempts: 3,
        initialDelay: 2000,
        operationName: 'discoverComputers',
      }
    );
  }

  /**
   * Discover User accounts from Active Directory
   *
   * @param jobId - Discovery job identifier
   * @param resourceConfig - Resource-specific configuration
   *   - active_only: Only include active users (default: true)
   */
  async discoverUsers(
    jobId: string,
    resourceConfig?: {
      active_only?: boolean;
    }
  ): Promise<DiscoveredCI[]> {
    return withRetry(
      async () => {
        const cis: DiscoveredCI[] = [];
        const client = await this.createLDAPClient();

        try {
          // Build filter for user objects
          // (objectClass=user) AND (objectCategory=person) AND NOT disabled
          const activeOnly = resourceConfig?.active_only !== false;
          const filter = activeOnly
            ? '(&(objectClass=user)(objectCategory=person)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))'
            : '(&(objectClass=user)(objectCategory=person))';

          const opts: ldap.SearchOptions = {
            filter,
            scope: 'sub',
            attributes: [
              'cn',
              'name',
              'distinguishedName',
              'sAMAccountName',
              'userPrincipalName',
              'mail',
              'displayName',
              'givenName',
              'sn',
              'department',
              'title',
              'manager',
              'whenCreated',
              'whenChanged',
              'lastLogon',
              'lastLogonTimestamp',
              'userAccountControl',
              'description',
              'telephoneNumber',
              'mobile',
              'company',
            ],
            paged: true,
            sizeLimit: 1000,
          };

          const entries = await this.searchLDAP(client, this.baseDN, opts);

          for (const entry of entries) {
            const attrs = (entry as any).pojo || entry;

            const name = attrs.displayName || attrs.cn || attrs.name || 'unknown';
            const dn = attrs.distinguishedName;
            const email = attrs.mail || attrs.userPrincipalName;
            const samAccountName = attrs.sAMAccountName;

            // Parse user account control flags
            const userAccountControl = parseInt(attrs.userAccountControl || '0', 10);
            const isDisabled = (userAccountControl & 0x0002) !== 0;
            const status: CIStatus = isDisabled ? 'inactive' : 'active';

            // Parse last logon
            const lastLogon = this.parseLDAPTimestamp(
              attrs.lastLogonTimestamp || attrs.lastLogon
            );

            // Infer environment from OU
            const environment = this.inferEnvironmentFromDN(dn);

            cis.push({
              _id: `ad-user-${this.sanitizeDN(dn)}`,
              external_id: dn,
              name,
              _type: 'user',
              status,
              environment,
              discovered_at: new Date().toISOString(),
              discovery_job_id: jobId,
              discovery_provider: 'active-directory' as any,
              confidence_score: 1.0,
              metadata: {
                resource_type: 'user',
                domain: this.domain,
                distinguished_name: dn,
                sam_account_name: samAccountName,
                user_principal_name: attrs.userPrincipalName,
                email,
                given_name: attrs.givenName,
                surname: attrs.sn,
                department: attrs.department,
                title: attrs.title,
                manager: attrs.manager,
                when_created: attrs.whenCreated,
                when_changed: attrs.whenChanged,
                last_logon: lastLogon?.toISOString(),
                user_account_control: userAccountControl,
                is_disabled: isDisabled,
                description: attrs.description,
                telephone_number: attrs.telephoneNumber,
                mobile: attrs.mobile,
                company: attrs.company,
                ou_path: this.extractOUPath(dn),
              } as Record<string, any>,
            });
          }

          logger.info('User accounts discovered', {
            jobId,
            count: cis.length,
          });

          return cis;
        } finally {
          await this.closeLDAPClient(client);
        }
      },
      {
        maxAttempts: 3,
        initialDelay: 2000,
        operationName: 'discoverUsers',
      }
    );
  }

  /**
   * Discover Groups from Active Directory
   *
   * @param jobId - Discovery job identifier
   * @param resourceConfig - Resource-specific configuration
   *   - security_only: Only include security groups (default: false)
   */
  async discoverGroups(
    jobId: string,
    resourceConfig?: {
      security_only?: boolean;
    }
  ): Promise<DiscoveredCI[]> {
    return withRetry(
      async () => {
        const cis: DiscoveredCI[] = [];
        const client = await this.createLDAPClient();

        try {
          // Build filter for group objects
          const securityOnly = resourceConfig?.security_only || false;
          const filter = securityOnly
            ? '(&(objectClass=group)(groupType:1.2.840.113556.1.4.803:=2147483648))'
            : '(objectClass=group)';

          const opts: ldap.SearchOptions = {
            filter,
            scope: 'sub',
            attributes: [
              'cn',
              'name',
              'distinguishedName',
              'description',
              'groupType',
              'member',
              'whenCreated',
              'whenChanged',
              'managedBy',
              'mail',
            ],
            paged: true,
            sizeLimit: 1000,
          };

          const entries = await this.searchLDAP(client, this.baseDN, opts);

          for (const entry of entries) {
            const attrs = (entry as any).pojo || entry;

            const name = attrs.cn || attrs.name || 'unknown';
            const dn = attrs.distinguishedName;

            // Parse group type
            const groupType = parseInt(attrs.groupType || '0', 10);
            const isSecurityGroup = (groupType & 0x80000000) !== 0;
            const groupScope = this.parseGroupScope(groupType);

            // Extract members (DNs)
            const members = Array.isArray(attrs.member)
              ? attrs.member
              : attrs.member
              ? [attrs.member]
              : [];

            // Infer environment from OU
            const environment = this.inferEnvironmentFromDN(dn);

            cis.push({
              _id: `ad-group-${this.sanitizeDN(dn)}`,
              external_id: dn,
              name,
              _type: 'group',
              status: 'active',
              environment,
              discovered_at: new Date().toISOString(),
              discovery_job_id: jobId,
              discovery_provider: 'active-directory' as any,
              confidence_score: 1.0,
              metadata: {
                resource_type: 'group',
                domain: this.domain,
                distinguished_name: dn,
                description: attrs.description,
                group_type: groupType,
                is_security_group: isSecurityGroup,
                group_scope: groupScope,
                member_count: members.length,
                members: members.slice(0, 100), // Limit to first 100 for large groups
                when_created: attrs.whenCreated,
                when_changed: attrs.whenChanged,
                managed_by: attrs.managedBy,
                email: attrs.mail,
                ou_path: this.extractOUPath(dn),
              } as Record<string, any>,
            });
          }

          logger.info('Groups discovered', {
            jobId,
            count: cis.length,
          });

          return cis;
        } finally {
          await this.closeLDAPClient(client);
        }
      },
      {
        maxAttempts: 3,
        initialDelay: 2000,
        operationName: 'discoverGroups',
      }
    );
  }

  /**
   * Discover Organizational Units from Active Directory
   *
   * @param jobId - Discovery job identifier
   * @param resourceConfig - Resource-specific configuration
   */
  async discoverOrganizationalUnits(
    jobId: string,
    resourceConfig?: Record<string, any>
  ): Promise<DiscoveredCI[]> {
    return withRetry(
      async () => {
        const cis: DiscoveredCI[] = [];
        const client = await this.createLDAPClient();

        try {
          const filter = '(objectClass=organizationalUnit)';

          const opts: ldap.SearchOptions = {
            filter,
            scope: 'sub',
            attributes: [
              'ou',
              'name',
              'distinguishedName',
              'description',
              'whenCreated',
              'whenChanged',
              'managedBy',
            ],
            paged: true,
            sizeLimit: 1000,
          };

          const entries = await this.searchLDAP(client, this.baseDN, opts);

          for (const entry of entries) {
            const attrs = (entry as any).pojo || entry;

            const name = attrs.ou || attrs.name || 'unknown';
            const dn = attrs.distinguishedName;

            // Calculate OU depth
            const ouDepth = this.calculateOUDepth(dn);

            // Infer environment from OU name/path
            const environment = this.inferEnvironmentFromDN(dn);

            cis.push({
              _id: `ad-ou-${this.sanitizeDN(dn)}`,
              external_id: dn,
              name,
              _type: 'organizational-unit',
              status: 'active',
              environment,
              discovered_at: new Date().toISOString(),
              discovery_job_id: jobId,
              discovery_provider: 'active-directory' as any,
              confidence_score: 1.0,
              metadata: {
                resource_type: 'organizational-unit',
                domain: this.domain,
                distinguished_name: dn,
                description: attrs.description,
                when_created: attrs.whenCreated,
                when_changed: attrs.whenChanged,
                managed_by: attrs.managedBy,
                ou_depth: ouDepth,
                ou_path: this.extractOUPath(dn),
              } as Record<string, any>,
            });
          }

          logger.info('Organizational Units discovered', {
            jobId,
            count: cis.length,
          });

          return cis;
        } finally {
          await this.closeLDAPClient(client);
        }
      },
      {
        maxAttempts: 3,
        initialDelay: 2000,
        operationName: 'discoverOrganizationalUnits',
      }
    );
  }

  /**
   * Infer relationships between discovered Active Directory CIs
   *
   * Relationship patterns:
   * - Computer → OU (PART_OF)
   * - User → OU (PART_OF)
   * - User → Computer (USES) - via last logon on computer
   * - Group → OU (PART_OF)
   * - OU → Parent OU (PART_OF)
   */
  inferRelationships(discoveredCIs: DiscoveredCI[]): Relationship[] {
    const relationships: Relationship[] = [];

    // Create lookup maps
    const ciByDN = new Map<string, DiscoveredCI>();
    const ouByDN = new Map<string, DiscoveredCI>();

    // Build lookup maps
    for (const ci of discoveredCIs) {
      const dn = ci.metadata?.distinguished_name;
      if (dn) {
        ciByDN.set(dn, ci);

        if (ci._type === 'organizational-unit') {
          ouByDN.set(dn, ci);
        }
      }
    }

    // Infer relationships
    for (const ci of discoveredCIs) {
      const metadata = ci.metadata as any;
      const dn = metadata?.distinguished_name;

      if (!dn) continue;

      // Extract parent OU DN from distinguished name
      const parentOUDN = this.extractParentOUDN(dn);

      // Computer/User/Group → OU (PART_OF)
      if (
        ['server', 'virtual-machine', 'user', 'group'].includes(ci._type) &&
        parentOUDN
      ) {
        const ou = ouByDN.get(parentOUDN);
        if (ou) {
          relationships.push({
            _from_id: ci._id,
            _to_id: ou._id,
            _type: 'PART_OF',
            properties: {
              confidence: 1.0,
              relationship_type: 'ou_membership',
            },
          });
        }
      }

      // OU → Parent OU (PART_OF)
      if (ci._type === 'organizational-unit' && parentOUDN) {
        const parentOU = ouByDN.get(parentOUDN);
        if (parentOU) {
          relationships.push({
            _from_id: ci._id,
            _to_id: parentOU._id,
            _type: 'PART_OF',
            properties: {
              confidence: 1.0,
              relationship_type: 'ou_hierarchy',
            },
          });
        }
      }

      // User → Manager (reports to)
      if (ci._type === 'user' && metadata.manager) {
        const manager = ciByDN.get(metadata.manager);
        if (manager && manager._type === 'user') {
          relationships.push({
            _from_id: ci._id,
            _to_id: manager._id,
            _type: 'OWNED_BY',
            properties: {
              confidence: 1.0,
              relationship_type: 'reports_to',
            },
          });
        }
      }
    }

    logger.info('Inferred Active Directory relationships', {
      count: relationships.length,
    });

    return relationships;
  }

  /**
   * Create LDAP client and bind
   */
  private async createLDAPClient(): Promise<ldap.Client> {
    return new Promise((resolve, reject) => {
      const client = ldap.createClient({
        url: this.ldapUrl,
        tlsOptions: {
          rejectUnauthorized: this.useSSL,
        },
      });

      let settled = false;

      // ldapjs clients emit 'error' for connection failures (e.g. ECONNREFUSED,
      // socket resets) outside of the bind callback. Without a listener, these
      // are uncaught EventEmitter errors that crash the process.
      client.on('error', (err) => {
        logger.error('LDAP client error', { error: err.message });
        if (!settled) {
          settled = true;
          reject(new Error(`LDAP client error: ${err.message}`));
        }
      });

      client.bind(this.bindDN, this.password, (err) => {
        if (settled) {
          return;
        }
        settled = true;
        if (err) {
          logger.error('LDAP bind failed', { error: err.message });
          reject(new Error(`LDAP bind failed: ${err.message}`));
        } else {
          resolve(client);
        }
      });
    });
  }

  /**
   * Close LDAP client
   */
  private async closeLDAPClient(client: ldap.Client): Promise<void> {
    return new Promise((resolve) => {
      client.unbind((err) => {
        if (err) {
          logger.warn('LDAP unbind error', { error: err.message });
        }
        resolve();
      });
    });
  }

  /**
   * Search LDAP with pagination support
   */
  private async searchLDAP(
    client: ldap.Client,
    base: string,
    options: ldap.SearchOptions
  ): Promise<ldap.SearchEntry[]> {
    return new Promise((resolve, reject) => {
      const entries: ldap.SearchEntry[] = [];

      client.search(base, options, (err, res) => {
        if (err) {
          reject(err);
          return;
        }

        res.on('searchEntry', (entry) => {
          entries.push(entry);
        });

        res.on('error', (err) => {
          logger.error('LDAP search error', { error: err.message });
          reject(err);
        });

        res.on('end', (result) => {
          if (result?.status === 0) {
            resolve(entries);
          } else {
            reject(new Error(`LDAP search failed with status: ${result?.status}`));
          }
        });
      });
    });
  }

  /**
   * Convert JavaScript Date to LDAP timestamp (Windows FILETIME format)
   */
  private dateToLDAPTimestamp(date: Date): string {
    // Windows FILETIME: 100-nanosecond intervals since Jan 1, 1601
    const epochDiff = 11644473600000; // milliseconds between 1601 and 1970
    const timestamp = (date.getTime() + epochDiff) * 10000;
    return timestamp.toString();
  }

  /**
   * Parse LDAP timestamp to JavaScript Date
   */
  private parseLDAPTimestamp(timestamp: string | undefined): Date | null {
    if (!timestamp) return null;

    try {
      const ts = parseInt(timestamp, 10);
      if (ts === 0) return null;

      const epochDiff = 11644473600000;
      const milliseconds = ts / 10000 - epochDiff;
      return new Date(milliseconds);
    } catch (error) {
      return null;
    }
  }

  /**
   * Sanitize DN for use in CI ID
   */
  private sanitizeDN(dn: string): string {
    return dn.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  }

  /**
   * Extract OU path from DN
   */
  private extractOUPath(dn: string): string {
    const parts = dn.split(',').filter((part) => part.startsWith('OU='));
    return parts.map((part) => part.substring(3)).reverse().join('/');
  }

  /**
   * Extract parent OU DN from DN
   */
  private extractParentOUDN(dn: string): string | null {
    const parts = dn.split(',');
    const ouIndex = parts.findIndex((part) => part.startsWith('OU='));

    if (ouIndex === -1) return null;

    const parentParts = parts.slice(ouIndex);
    return parentParts.length > 1 ? parentParts.slice(1).join(',') : null;
  }

  /**
   * Calculate OU depth in hierarchy
   */
  private calculateOUDepth(dn: string): number {
    return dn.split(',').filter((part) => part.startsWith('OU=')).length;
  }

  /**
   * Infer environment from DN path
   */
  private inferEnvironmentFromDN(dn: string): any {
    const dnLower = dn.toLowerCase();

    if (dnLower.includes('ou=production') || dnLower.includes('ou=prod')) {
      return 'production';
    }
    if (dnLower.includes('ou=staging') || dnLower.includes('ou=stage')) {
      return 'staging';
    }
    if (dnLower.includes('ou=development') || dnLower.includes('ou=dev')) {
      return 'development';
    }
    if (dnLower.includes('ou=test') || dnLower.includes('ou=qa')) {
      return 'test';
    }

    return 'production'; // Default to production if no environment found
  }

  /**
   * Infer computer type from operating system
   */
  private inferComputerType(os: string | undefined): 'server' | 'virtual-machine' {
    if (!os) return 'virtual-machine';

    const osLower = os.toLowerCase();

    if (osLower.includes('server')) {
      return 'server';
    }

    return 'virtual-machine'; // Workstations
  }

  /**
   * Parse Active Directory group scope from groupType
   */
  private parseGroupScope(groupType: number): string {
    const scope = groupType & 0x0000000F;

    switch (scope) {
      case 2:
        return 'global';
      case 4:
        return 'domain-local';
      case 8:
        return 'universal';
      default:
        return 'unknown';
    }
  }
}
