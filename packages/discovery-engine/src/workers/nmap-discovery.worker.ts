// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/discovery-engine/src/workers/nmap-discovery.worker.ts

import * as nmap from 'node-nmap';
import { logger, withRetry, assertDiscoveryRange, resolveDiscoveryHost, connectDiscoveryHost, DISCOVERY_TARGET_REFUSED } from '@cmdb/common';
import { DiscoveredCI, CIStatus, Relationship } from '@cmdb/common';

/**
 * Nmap Discovery Worker
 *
 * Performs network-based discovery of devices using Nmap port scanning.
 * Discovers:
 * - Network devices (routers, switches, firewalls)
 * - Servers with open ports
 * - Services running on discovered hosts
 * - OS fingerprinting (when available)
 *
 * Implements retry logic and comprehensive error handling.
 * Confidence score: 0.7 (network-based inference is less reliable than direct access)
 */
export class NmapDiscoveryWorker {
  /**
   * Scan a network range for devices
   * @param jobId Discovery job ID
   * @param range IP range to scan (e.g., "192.168.1.0/24" or "10.0.0.1-254")
   * @param scanType Type of scan to perform ('quick', 'port', 'os', 'version')
   */
  async scanNetwork(
    jobId: string,
    range: string,
    scanType: 'quick' | 'port' | 'os' | 'version' = 'quick'
  ): Promise<DiscoveredCI[]> {
    return withRetry(
      async () => {
        // Resolve hostnames ourselves and give nmap only numeric addresses.
        // CIDRs are checked for *any* prohibited overlap before the subprocess starts.
        const destination = range.includes('/') ? assertDiscoveryRange(range) :
          await connectDiscoveryHost(range, await resolveDiscoveryHost(range));
        logger.info('Starting Nmap scan', { jobId, scanType });

        return new Promise<DiscoveredCI[]>((resolve, reject) => {
          let scanner: any;

          // Select scanner type based on scanType
          switch (scanType) {
            case 'quick':
              scanner = new nmap.QuickScan(destination);
              break;
            case 'port':
              scanner = new (nmap as any).NmapScan(destination, '-p 1-65535');
              break;
            case 'os':
              scanner = new nmap.OsAndPortScan(destination);
              break;
            case 'version':
              scanner = new (nmap as any).NmapScan(destination, '-sV');
              break;
            default:
              scanner = new nmap.QuickScan(destination);
          }

          scanner.on('complete', (data: any[]) => {
            const cis: DiscoveredCI[] = [];

            for (const host of data) {
              const ci = this.createCIFromHost(jobId, host, scanType);
              if (ci) {
                cis.push(ci);
              }
            }

            logger.info('Nmap scan completed', {
              jobId,
              range,
              scanType,
              _discovered: cis.length,
            });

            resolve(cis);
          });

          scanner.on('error', (error: Error) => {
            logger.error('Nmap scan failed', { jobId, range, scanType, error: error.message });
            reject(error);
          });

          scanner.startScan();
        });
      },
      {
        maxAttempts: 3,
        initialDelay: 2000,
        operationName: 'scanNetwork',
      }
    );
  }

  /**
   * Scan multiple network ranges in parallel
   */
  async scanNetworks(
    jobId: string,
    ranges: Array<{ range: string; scanType?: 'quick' | 'port' | 'os' | 'version' }>
  ): Promise<DiscoveredCI[]> {
    // Reject the entire batch before scanning any member if one is forbidden.
    await Promise.all(ranges.map(({ range }) =>
      range.includes('/') ? Promise.resolve(assertDiscoveryRange(range)) : resolveDiscoveryHost(range)));
    logger.info('Starting Nmap scan for multiple ranges', {
      jobId,
      _rangeCount: ranges.length,
    });

    const results = await Promise.allSettled(
      ranges.map(({ range, scanType }) => this.scanNetwork(jobId, range, scanType || 'quick'))
    );

    const allCIs: DiscoveredCI[] = [];
    const failedScans: Array<{ range: string; error: any }> = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        allCIs.push(...result.value);
      } else {
        const rangeInfo = ranges[index];
        const range = rangeInfo ? rangeInfo.range : 'unknown';
        logger.error(`Nmap scan failed for range ${range}`, result.reason);
        failedScans.push({ range, error: result.reason });
      }
    });

    const successCount = results.filter(r => r.status === 'fulfilled').length;
    const failedCount = ranges.length - successCount;

    logger.info('Nmap scan completed for all ranges', {
      jobId,
      _discovered: allCIs.length,
      _failed: failedCount,
      _success: successCount,
    });

    // If ALL scans failed, throw an error
    if (failedCount === ranges.length) {
      const errorDetails = failedScans.map(f => `${f.range}: ${f.error?.message || f.error}`).join('; ');
      throw new Error(`All Nmap scans failed (${failedCount}/${ranges.length}): ${errorDetails}`);
    }

    // If SOME scans failed but others succeeded, log warning but continue
    if (failedCount > 0) {
      logger.warn(`Partial Nmap scan failure: ${failedCount}/${ranges.length} ranges failed`, {
        jobId,
        failedRanges: failedScans.map(f => f.range),
      });
    }

    return allCIs;
  }

  /**
   * Perform a detailed scan on a specific host
   */
  async scanHost(
    jobId: string,
    host: string,
    options?: {
      portRange?: string;
      detectOS?: boolean;
      detectVersion?: boolean;
      scriptScan?: boolean;
    }
  ): Promise<DiscoveredCI | null> {
    return withRetry(
      async () => {
        const destination = await connectDiscoveryHost(host, await resolveDiscoveryHost(host));
        logger.info('Starting Nmap host scan', { jobId, options });

        // Build nmap command flags
        const flags: string[] = [];

        if (options?.portRange) {
          if (!/^\d{1,5}(?:-\d{1,5})?(?:,\d{1,5}(?:-\d{1,5})?)*$/.test(options.portRange) ||
            options.portRange.split(/[,-]/).some(part => Number(part) < 1 || Number(part) > 65535)) {
            throw new Error('Invalid port range');
          }
          flags.push(`-p ${options.portRange}`);
        }

        if (options?.detectOS) {
          flags.push('-O'); // OS detection
        }

        if (options?.detectVersion) {
          flags.push('-sV'); // Version detection
        }

        if (options?.scriptScan) {
          // NSE scripts can contact other destinations without consulting this guard.
          throw new Error(DISCOVERY_TARGET_REFUSED);
        }

        const nmapFlags = flags.join(' ');

        return new Promise<DiscoveredCI | null>((resolve, reject) => {
          const scanner = new (nmap as any).NmapScan(destination, nmapFlags || undefined);

          scanner.on('complete', (data: any[]) => {
            if (data.length > 0) {
              const ci = this.createCIFromHost(jobId, data[0], 'detailed');
              logger.info('Nmap host scan completed', { jobId, host });
              resolve(ci);
            } else {
              logger.warn('Nmap host scan returned no results', { jobId, host });
              resolve(null);
            }
          });

          scanner.on('error', (error: Error) => {
            logger.error('Nmap host scan failed', { jobId, host, error: error.message });
            reject(error);
          });

          scanner.startScan();
        });
      },
      {
        maxAttempts: 3,
        initialDelay: 2000,
        operationName: 'scanHost',
      }
    );
  }

  /**
   * Create a DiscoveredCI from Nmap host data
   */
  private createCIFromHost(jobId: string, host: any, scanType: string): DiscoveredCI | null {
    if (!host) {
      return null;
    }

    const ip = host.ip || host.ipv4;
    const hostname = host.hostname || host.hostnames?.[0]?.name || ip;
    const status = this.mapHostStatus(host.status || host.state);

    // Extract open ports
    const openPorts = this.extractPorts(host.openPorts || host.ports || []);

    // Extract OS information
    const osInfo = this.extractOSInfo(host);

    // Determine device type based on open ports and OS
    const deviceType = this.inferDeviceType(openPorts, osInfo);

    // Extract MAC address and vendor
    const mac = host.mac || host.macAddr;
    const vendor = host.vendor || host.macVendor;

    return {
      _id: `nmap-${ip}`,
      external_id: ip,
      name: hostname,
      _type: deviceType,
      status: status,
      discovered_at: new Date().toISOString(),
      discovery_job_id: jobId,
      discovery_provider: 'nmap',
      confidence_score: this.calculateConfidence(host, scanType),
      metadata: {
        ip_address: ip,
        hostname: hostname,
        mac_address: mac,
        vendor: vendor,
        scan_type: scanType,
        ports: {
          open: openPorts,
          open_count: openPorts.length,
          filtered: host.filteredPorts?.length || 0,
          closed: host.closedPorts?.length || 0,
        },
        os: osInfo,
        services: this.extractServices(openPorts),
        response_time: host.responseTime || host.rtt,
        last_boot: host.lastBoot,
        uptime: host.uptime,
        distance: host.distance, // Network hops
        tcp_sequence: host.tcpSequence,
        ip_id_sequence: host.ipIdSequence,
      },
    };
  }

  /**
   * Extract and normalize port information
   */
  private extractPorts(ports: any[]): any[] {
    return ports.map(port => {
      // Handle different port object structures from node-nmap
      const portNumber = port.port || port.portId || port.id;
      const protocol = port.protocol || port.proto || 'tcp';
      const service = port.service || port.serviceName || port.name || 'unknown';
      const version = port.version || port.serviceVersion;
      const product = port.product || port.serviceProduct;
      const extraInfo = port.extraInfo || port.serviceExtraInfo;

      return {
        port: portNumber,
        protocol: protocol,
        state: port.state || 'open',
        service: service,
        version: version,
        product: product,
        extra_info: extraInfo,
        confidence: port.confidence || port.conf,
        method: port.method,
      };
    });
  }

  /**
   * Extract OS information from Nmap results
   */
  private extractOSInfo(host: any): any {
    const osInfo: any = {
      matches: [],
      fingerprint: undefined,
      classes: [],
    };

    // OS detection results
    if (host.osNmap) {
      osInfo.nmap_guess = host.osNmap;
    }

    if (host.osMatches || host.os?.matches) {
      const matches = host.osMatches || host.os.matches;
      osInfo.matches = matches.map((match: any) => ({
        name: match.name,
        accuracy: match.accuracy || match.acc,
        line: match.line,
        cpe: match.cpe,
      }));
    }

    if (host.os?.osmatch) {
      osInfo.matches = host.os.osmatch.map((match: any) => ({
        name: match.name,
        accuracy: match.accuracy,
        line: match.line,
        osclass: match.osclass,
      }));
    }

    // OS fingerprint
    if (host.osFingerprint || host.os?.fingerprint) {
      osInfo.fingerprint = host.osFingerprint || host.os.fingerprint;
    }

    // OS classes
    if (host.osClasses || host.os?.osclass) {
      const classes = host.osClasses || host.os.osclass;
      osInfo.classes = Array.isArray(classes)
        ? classes.map((cls: any) => ({
            type: cls.type,
            vendor: cls.vendor,
            os_family: cls.osfamily,
            os_gen: cls.osgen,
            accuracy: cls.accuracy,
            cpe: cls.cpe,
          }))
        : [];
    }

    return osInfo;
  }

  /**
   * Extract service information from ports
   */
  private extractServices(ports: any[]): any[] {
    const uniqueServices = new Map<string, any>();

    for (const port of ports) {
      const serviceName = port.service || 'unknown';

      if (!uniqueServices.has(serviceName)) {
        uniqueServices.set(serviceName, {
          name: serviceName,
          ports: [],
          version: port.version,
          product: port.product,
        });
      }

      uniqueServices.get(serviceName)!.ports.push({
        port: port.port,
        protocol: port.protocol,
      });
    }

    return Array.from(uniqueServices.values());
  }

  /**
   * Infer device type based on open ports and OS information
   */
  private inferDeviceType(ports: any[], osInfo: any): 'server' | 'network-device' | 'cloud-resource' {
    // Check common server ports
    const serverPorts = [80, 443, 22, 3306, 5432, 27017, 6379, 8080, 8443, 9000];
    const hasServerPorts = ports.some(p => serverPorts.includes(p.port));

    // Check network device ports
    const networkPorts = [23, 161, 162, 179]; // Telnet, SNMP, BGP
    const hasNetworkPorts = ports.some(p => networkPorts.includes(p.port));

    // Check OS information
    const osName = osInfo.matches?.[0]?.name?.toLowerCase() || '';
    const isNetworkOS = osName.includes('cisco') ||
                        osName.includes('juniper') ||
                        osName.includes('mikrotik') ||
                        osName.includes('router') ||
                        osName.includes('switch');

    if (isNetworkOS || (hasNetworkPorts && !hasServerPorts)) {
      return 'network-device';
    }

    if (hasServerPorts) {
      return 'server';
    }

    // Default to network-device for unknown devices
    return 'network-device';
  }

  /**
   * Calculate confidence score based on available information
   */
  private calculateConfidence(host: any, scanType: string): number {
    let confidence = 0.5; // Base confidence for network discovery

    // Increase confidence based on scan type
    if (scanType === 'os' || scanType === 'version') {
      confidence += 0.1;
    }

    // Increase confidence if hostname resolved
    if (host.hostname && host.hostname !== host.ip) {
      confidence += 0.1;
    }

    // Increase confidence if OS detected
    if (host.osNmap || host.osMatches?.length > 0) {
      confidence += 0.1;
    }

    // Increase confidence if services detected
    if (host.openPorts?.length > 0) {
      confidence += 0.1;
    }

    // Increase confidence if MAC address detected (local network)
    if (host.mac || host.macAddr) {
      confidence += 0.1;
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * Map Nmap host status to CI status
   */
  private mapHostStatus(state?: string): CIStatus {
    switch (state?.toLowerCase()) {
      case 'up':
        return 'active';
      case 'down':
        return 'inactive';
      case 'unknown':
      case 'filtered':
        return 'maintenance';
      default:
        return 'inactive';
    }
  }

  /**
   * Infer relationships between discovered devices
   */
  inferRelationships(discoveredCIs: DiscoveredCI[]): Relationship[] {
    const relationships: Relationship[] = [];

    // Create lookup maps
    const devicesBySubnet = new Map<string, DiscoveredCI[]>();
    const serversByPort = new Map<number, DiscoveredCI[]>();
    const networkDevices: DiscoveredCI[] = [];

    // Build lookup maps
    for (const ci of discoveredCIs) {
      const metadata = ci.metadata as any;

      // Index by subnet
      if (metadata.ip_address) {
        const subnet = metadata.ip_address.split('.').slice(0, 3).join('.');
        if (!devicesBySubnet.has(subnet)) {
          devicesBySubnet.set(subnet, []);
        }
        devicesBySubnet.get(subnet)!.push(ci);
      }

      // Index servers by common ports
      if (metadata.ports?.open) {
        for (const port of metadata.ports.open) {
          if (!serversByPort.has(port.port)) {
            serversByPort.set(port.port, []);
          }
          serversByPort.get(port.port)!.push(ci);
        }
      }

      // Collect network devices
      if (ci._type === 'network-device') {
        networkDevices.push(ci);
      }
    }

    // Infer relationships
    for (const ci of discoveredCIs) {
      const metadata = ci.metadata as any;

      // Devices on same subnet: LOCATED_IN relationship (same network segment)
      if (metadata.ip_address) {
        const subnet = metadata.ip_address.split('.').slice(0, 3).join('.');
        const devicesInSubnet = devicesBySubnet.get(subnet) || [];

        for (const otherDevice of devicesInSubnet) {
          if (otherDevice._id !== ci._id) {
            relationships.push({
              _from_id: ci._id,
              _to_id: otherDevice._id,
              _type: 'LOCATED_IN',
              properties: {
                subnet,
                confidence: 0.6,
                inferred_from: 'same_subnet',
              },
            });
          }
        }
      }

      // Servers with database ports → Potential database servers
      if (ci._type === 'server' && metadata.ports?.open) {
        const databasePorts = [3306, 5432, 27017, 6379, 1433]; // MySQL, PostgreSQL, MongoDB, Redis, SQL Server

        for (const port of metadata.ports.open) {
          if (databasePorts.includes(port.port)) {
            // Find other servers on same subnet that might connect to this database
            const subnet = metadata.ip_address?.split('.').slice(0, 3).join('.');
            const serversInSubnet = devicesBySubnet.get(subnet || '') || [];

            for (const otherServer of serversInSubnet) {
              if (otherServer._id !== ci._id && otherServer._type === 'server') {
                const otherPorts = (otherServer.metadata as any).ports?.open || [];
                const hasWebServer = otherPorts.some((p: any) => [80, 443, 8080, 8443].includes(p.port));

                if (hasWebServer) {
                  relationships.push({
                    _from_id: otherServer._id,
                    _to_id: ci._id,
                    _type: 'CONNECTS_TO',
                    properties: {
                      database_port: port.port,
                      service: port.service,
                      confidence: 0.5,
                      inferred_from: 'web_server_to_database',
                    },
                  });
                }
              }
            }
          }
        }
      }

      // Network devices → Servers: HOSTS relationship (gateway/routing)
      if (ci._type === 'network-device') {
        const subnet = metadata.ip_address?.split('.').slice(0, 3).join('.');
        const devicesInSubnet = devicesBySubnet.get(subnet || '') || [];

        for (const device of devicesInSubnet) {
          if (device._id !== ci._id && device._type === 'server') {
            relationships.push({
              _from_id: ci._id,
              _to_id: device._id,
              _type: 'HOSTS',
              properties: {
                subnet,
                confidence: 0.4,
                inferred_from: 'network_device_routing',
              },
            });
          }
        }
      }

      // SSH servers → Potential management relationship
      if (metadata.ports?.open) {
        const hasSsh = metadata.ports.open.some((p: any) => p.port === 22);

        if (hasSsh) {
          // This server might manage other servers on the same subnet
          const subnet = metadata.ip_address?.split('.').slice(0, 3).join('.');
          const serversInSubnet = devicesBySubnet.get(subnet || '') || [];

          for (const otherServer of serversInSubnet) {
            if (otherServer._id !== ci._id) {
              const otherPorts = (otherServer.metadata as any).ports?.open || [];
              const otherHasSsh = otherPorts.some((p: any) => p.port === 22);

              if (otherHasSsh) {
                // Both servers have SSH - potential management relationship
                relationships.push({
                  _from_id: ci._id,
                  _to_id: otherServer._id,
                  _type: 'CONNECTS_TO',
                  properties: {
                    protocol: 'ssh',
                    confidence: 0.3,
                    inferred_from: 'ssh_availability',
                  },
                });
              }
            }
          }
        }
      }
    }

    logger.info('Inferred Nmap discovery relationships', {
      _count: relationships.length,
    });

    return relationships;
  }

  /**
   * Analyze discovered network topology
   */
  analyzeTopology(discoveredCIs: DiscoveredCI[]): {
    subnets: Map<string, DiscoveredCI[]>;
    devices_by_type: Map<string, number>;
    services_summary: Map<string, number>;
    total_devices: number;
    total_open_ports: number;
  } {
    const subnets = new Map<string, DiscoveredCI[]>();
    const devicesByType = new Map<string, number>();
    const servicesSummary = new Map<string, number>();
    let totalOpenPorts = 0;

    for (const ci of discoveredCIs) {
      const metadata = ci.metadata as any;

      // Group by subnet
      if (metadata.ip_address) {
        const subnet = metadata.ip_address.split('.').slice(0, 3).join('.');
        if (!subnets.has(subnet)) {
          subnets.set(subnet, []);
        }
        subnets.get(subnet)!.push(ci);
      }

      // Count device types
      devicesByType.set(ci._type, (devicesByType.get(ci._type) || 0) + 1);

      // Count services
      if (metadata.services) {
        for (const service of metadata.services) {
          servicesSummary.set(service.name, (servicesSummary.get(service.name) || 0) + 1);
        }
      }

      // Count open ports
      if (metadata.ports?.open_count) {
        totalOpenPorts += metadata.ports.open_count;
      }
    }

    return {
      subnets,
      devices_by_type: devicesByType,
      services_summary: servicesSummary,
      total_devices: discoveredCIs.length,
      total_open_ports: totalOpenPorts,
    };
  }
}
