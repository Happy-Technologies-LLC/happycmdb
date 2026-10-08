// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * NMAP Discovery Tool
 * Allows AI to scan network ports and services
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { DiscoveryTool } from '../types';
import { logger, resolveDiscoveryHost, connectDiscoveryHost, DISCOVERY_TARGET_REFUSED } from '@cmdb/common';

const execFileAsync = promisify(execFile);

export const nmapTool: DiscoveryTool = {
  name: 'nmap_scan',
  description:
    'Scan network ports and detect services on a target host. Use this to identify open ports, running services, and service versions.',
  inputSchema: {
    type: 'object',
    properties: {
      host: {
        type: 'string',
        description: 'Target hostname or IP address',
      },
      ports: {
        type: 'string',
        description:
          'Port range to scan (e.g., "80,443" or "1-1000"). Default: top 100 ports',
      },
      scanType: {
        type: 'string',
        enum: ['quick', 'version'],
        description: 'Type of scan: quick (fast) or version (detect versions)',
      },
    },
    required: ['host'],
  },
  execute: async (params: any) => {
    const { host, ports, scanType = 'quick' } = params;
    if (scanType === 'aggressive') throw new Error(DISCOVERY_TARGET_REFUSED);
    if (scanType !== 'quick' && scanType !== 'version') {
      throw new Error('Invalid scan type');
    }

    const destination = await connectDiscoveryHost(host, await resolveDiscoveryHost(host));
    if (ports !== undefined && (typeof ports !== 'string' ||
      !/^\d{1,5}(?:-\d{1,5})?(?:,\d{1,5}(?:-\d{1,5})?)*$/.test(ports) ||
      ports.split(/[,-]/).some((part: string) => Number(part) < 1 || Number(part) > 65535))) {
      throw new Error('Invalid port range');
    }
    logger.info('Executing NMAP scan');

    try {
      // Only the two validated modes can reach the subprocess.
      const nmapArgs = scanType === 'quick' ? '-sT' : '-sV';

      const args = [nmapArgs, ...(ports === undefined ? ['--top-ports', '100'] : ['-p', ports]),
        destination, '-oX', '-'];
      // execFile never invokes a shell; the destination is a checked numeric IP.
      const { stdout, stderr } = await execFileAsync('nmap', args, {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });

      if (stderr && !stderr.includes('Starting Nmap')) {
        logger.warn('NMAP stderr output');
      }

      // Parse nmap XML output (simplified parser)
      const result = parseNmapOutput(stdout);

      logger.info('NMAP scan completed', {
        openPorts: result.openPorts?.length || 0,
      });

      return result;
    } catch {
      logger.error('NMAP scan failed');
      throw new Error('NMAP scan failed');
    }
  },
};

/**
 * Parse NMAP output (simplified)
 * In production, use a proper XML parser like xml2js
 */
function parseNmapOutput(output: string): any {
  const result: any = {
    status: 'unknown',
    openPorts: [],
    services: [],
    osGuess: null,
  };

  try {
    // Check if host is up
    if (output.includes('Host is up')) {
      result.status = 'up';
    } else if (output.includes('host down')) {
      result.status = 'down';
      return result;
    }

    // Extract open ports (simple regex parsing)
    const portRegex = /(\d+)\/tcp\s+open\s+(\S+)\s*(.*)/g;
    let match;

    while ((match = portRegex.exec(output)) !== null) {
      const port = parseInt(match[1], 10);
      const service = match[2];
      const version = match[3]?.trim() || '';

      result.openPorts.push(port);
      result.services.push({
        port,
        protocol: 'tcp',
        state: 'open',
        service,
        version,
      });
    }

    // Extract OS guess (if available)
    const osMatch = output.match(/OS details: (.+)/);
    if (osMatch) {
      result.osGuess = osMatch[1];
    }

    return result;
  } catch {
    logger.error('Failed to parse NMAP output');
    return {
      status: 'error',
      error: 'Failed to parse output',
      rawOutput: output.substring(0, 500), // First 500 chars
    };
  }
}
