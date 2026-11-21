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

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decode the five predefined XML entities in a single pass (no double decoding). */
function decodeXmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_m, name: string) => XML_ENTITIES[name]);
}

/** The only attributes the extractor reads; everything else in nmap's XML is ignored. */
interface XmlAttributes {
  state?: string;
  protocol?: string;
  portid?: string;
  name?: string;
  product?: string;
  version?: string;
  extrainfo?: string;
}

const WANTED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'state', 'protocol', 'portid', 'name', 'product', 'version', 'extrainfo',
]);

/** Read `name="value"` pairs from the attribute text of one start tag. */
function parseAttributes(attributeText: string): XmlAttributes {
  const attributes: XmlAttributes = {};
  const attributeRegex = /([\w:.-]+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attributeRegex.exec(attributeText)) !== null) {
    if (WANTED_ATTRIBUTES.has(match[1])) {
      attributes[match[1] as keyof XmlAttributes] = decodeXmlEntities(match[2]);
    }
  }
  return attributes;
}

/**
 * Attribute list of a start tag: quoted values may contain a literal `>`, so the
 * tag end is only recognised outside quotes.
 */
const ATTR_LIST = '((?:\\s+[\\w:.-]+="[^"]*")*)\\s*';

function firstTag(xml: string, name: string): XmlAttributes | null {
  const match = new RegExp(`<${name}${ATTR_LIST}\\/?>`).exec(xml);
  return match ? parseAttributes(match[1]) : null;
}

/** Error result: same shape as a scan result, no ports, plus the first 500 characters of output. */
function parseFailure(output: string): any {
  return {
    status: 'error',
    error: 'Failed to parse output',
    openPorts: [],
    services: [],
    osGuess: null,
    rawOutput: output.substring(0, 500),
  };
}

/**
 * Parse `nmap -oX -` output. nmap emits a fixed element set, so a strict
 * extractor is used instead of an XML dependency. Output that is not nmap XML
 * (for example the plain-text format) is reported as `error`, never as a clean
 * "nothing open".
 */
function parseNmapOutput(output: string): any {
  const result: any = {
    status: 'unknown',
    openPorts: [],
    services: [],
    osGuess: null,
  };

  try {
    if (!/<nmaprun[\s>]/.test(output)) {
      return parseFailure(output);
    }

    // Comments and host hints can repeat element names (`<status>`, `<port`).
    const xml = output
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<hosthint\b[\s\S]*?<\/hosthint>/g, '');

    const status = firstTag(xml, 'status')?.state;
    if (status === 'up') {
      result.status = 'up';
    } else if (status === 'down') {
      result.status = 'down';
      return result;
    }

    const portRegex = new RegExp(`<port${ATTR_LIST}>([\\s\\S]*?)<\\/port>`, 'g');
    let match: RegExpExecArray | null;

    while ((match = portRegex.exec(xml)) !== null) {
      const portAttrs = parseAttributes(match[1]);
      const body = match[2];

      if (firstTag(body, 'state')?.state !== 'open') continue;
      if (portAttrs.protocol !== 'tcp' && portAttrs.protocol !== 'udp') continue;
      if (!/^\d{1,5}$/.test(portAttrs.portid ?? '')) continue;
      const port = Number(portAttrs.portid);
      if (port < 1 || port > 65535) continue;

      const serviceAttrs = firstTag(body, 'service') ?? {};
      const version = [serviceAttrs.product, serviceAttrs.version, serviceAttrs.extrainfo]
        .filter((part): part is string => !!part)
        .join(' ');

      result.openPorts.push(port);
      result.services.push({
        port,
        protocol: portAttrs.protocol,
        state: 'open',
        service: serviceAttrs.name ?? '',
        version,
      });
    }

    const osName = firstTag(xml, 'osmatch')?.name;
    if (osName) {
      result.osGuess = osName;
    }

    return result;
  } catch {
    logger.error('Failed to parse NMAP output');
    return parseFailure(output);
  }
}
