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

/** Most open ports/services one scan result carries to the model. */
export const NMAP_MAX_SERVICES = 256;
/** Longest scanner-supplied string (service, product, version, extrainfo, OS name) in a result. */
export const NMAP_MAX_FIELD_CHARS = 200;
/** Default number of nmap subprocesses running at once in this process. */
export const NMAP_DEFAULT_CONCURRENCY = 4;
/** Environment override for the process-wide nmap concurrency (integer 1-64). */
export const NMAP_CONCURRENCY_ENV = 'AI_DISCOVERY_NMAP_CONCURRENCY';

function nmapConcurrencyFromEnv(): number {
  const raw = process.env[NMAP_CONCURRENCY_ENV];
  if (raw === undefined || !/^\d{1,2}$/.test(raw.trim())) {
    return NMAP_DEFAULT_CONCURRENCY;
  }
  const limit = Number(raw);
  return limit >= 1 && limit <= 64 ? limit : NMAP_DEFAULT_CONCURRENCY;
}

/** FIFO counting semaphore: callers beyond the limit wait for a release. */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      // The slot is handed over directly, so `active` stays counted for the next holder.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next) {
        next();
      } else {
        this.active--;
      }
    }
  }
}

/** Process-wide: every concurrent AI session shares these slots. */
const nmapSlots = new Semaphore(nmapConcurrencyFromEnv());

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
      const { stdout, stderr } = await nmapSlots.run(() => execFileAsync('nmap', args, {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      }));

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

/**
 * Decode the five predefined XML entities and numeric character references in a
 * single pass (no double decoding). A reference to a code point XML cannot
 * carry is left as literal text. No other entity is ever expanded.
 */
function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(?:(amp|lt|gt|quot|apos)|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/g,
    (match, name?: string, decimal?: string, hex?: string) => {
      if (name) return XML_ENTITIES[name];
      const codePoint = decimal !== undefined ? Number(decimal) : parseInt(hex as string, 16);
      const valid = codePoint >= 1 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
      return valid ? String.fromCodePoint(codePoint) : match;
    },
  );
}

/** Text a scanned host controls: drop control characters, then cut at the field cap. */
function boundScannerText(value: string | undefined, limits: { truncated: boolean }): string | undefined {
  if (value === undefined) return undefined;
  let text = value.replace(/[\p{Cc}\u2028\u2029]/gu, '');
  if (text.length > NMAP_MAX_FIELD_CHARS) {
    limits.truncated = true;
    text = text.slice(0, NMAP_MAX_FIELD_CHARS);
    // Never end on half of a surrogate pair.
    if (/[\ud800-\udbff]$/.test(text)) {
      text = text.slice(0, -1);
    }
  }
  return text;
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

/** Error result: same shape as a scan result, no ports, and no scanner output. */
function parseFailure(): any {
  return {
    status: 'error',
    error: 'Failed to parse output',
    openPorts: [],
    services: [],
    osGuess: null,
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
  const limits = { truncated: false };

  try {
    if (!/<nmaprun[\s>]/.test(output)) {
      return parseFailure();
    }

    // Comments, a DOCTYPE (with any internal subset) and host hints can repeat
    // element names (`<status>`, `<port`); none of them is scan data.
    const xml = output
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<!DOCTYPE[^[>]*(?:\[[\s\S]*?\]\s*)?>/gi, '')
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

      if (result.services.length >= NMAP_MAX_SERVICES) {
        limits.truncated = true;
        break;
      }

      const serviceAttrs = firstTag(body, 'service') ?? {};
      const name = boundScannerText(serviceAttrs.name, limits);
      const version = [serviceAttrs.product, serviceAttrs.version, serviceAttrs.extrainfo]
        .map((part) => boundScannerText(part, limits))
        .filter((part): part is string => !!part)
        .join(' ');

      result.openPorts.push(port);
      result.services.push({
        port,
        protocol: portAttrs.protocol,
        state: 'open',
        service: name ?? '',
        version,
      });
    }

    const osName = boundScannerText(firstTag(xml, 'osmatch')?.name, limits);
    if (osName) {
      result.osGuess = osName;
    }

    if (limits.truncated) result.truncated = true;
    return result;
  } catch {
    logger.error('Failed to parse NMAP output');
    return parseFailure();
  }
}
