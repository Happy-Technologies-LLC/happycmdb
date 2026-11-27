// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP Probe Tool
 * Allows AI to probe HTTP/HTTPS endpoints
 */

import { DiscoveryTool } from '../types';
import { logger, DISCOVERY_TARGET_REFUSED } from '@cmdb/common';
import { DiscoveryHttpError, safeDiscoveryHttp } from './safe-http';

const HTTP_PROBE_METHODS: readonly string[] = ['GET', 'HEAD', 'POST', 'OPTIONS'];

export const httpProbeTool: DiscoveryTool = {
  targetScoped: true,
  name: 'http_probe',
  description:
    'Probe HTTP/HTTPS endpoints to check availability, headers, and content. Use this to identify web services, APIs, and application frameworks.',
  inputSchema: {
    type: 'object',
    properties: {
      host: {
        type: 'string',
        description: 'Target hostname or IP address',
      },
      port: {
        type: 'number',
        description: 'Port number (default: 80 for http, 443 for https)',
      },
      protocol: {
        type: 'string',
        enum: ['http', 'https'],
        description: 'Protocol to use (default: http)',
      },
      path: {
        type: 'string',
        description: 'URL path to probe (default: /)',
      },
      method: {
        type: 'string',
        enum: ['GET', 'HEAD', 'POST', 'OPTIONS'],
        description: 'HTTP method (default: GET)',
      },
    },
    required: ['host'],
  },
  execute: async (params: any) => {
    const {
      host,
      port,
      protocol = 'http',
      path = '/',
      method: requestedMethod = 'GET',
    } = params;
    // protocol, port, path and method are model text: each must stay in its own URL
    // component so the authority is exactly `host:port` (no `@`, `#` or `\` tricks),
    // and only the four documented methods may be sent.
    const method = typeof requestedMethod === 'string' ? requestedMethod.toUpperCase() : '';
    if ((protocol !== 'http' && protocol !== 'https') ||
      (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) ||
      typeof path !== 'string' || !path.startsWith('/') || /[\\\s]/.test(path) ||
      !HTTP_PROBE_METHODS.includes(method)) {
      throw new Error('Invalid HTTP probe parameters');
    }

    // Determine default port
    const defaultPort = protocol === 'https' ? 443 : 80;
    const targetPort = port || defaultPort;

    // An IPv6 literal needs brackets in the authority (the scope check accepts both forms).
    const urlHost = typeof host === 'string' && host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const url = `${protocol}://${urlHost}:${targetPort}${path}`;

    logger.info('Probing HTTP endpoint', { method });

    try {
      const response = await safeDiscoveryHttp(url, {
        method,
        timeout: 10000,
        validateStatus: () => true,
        headers: { 'User-Agent': 'HappyCMDB-Discovery/2.0' },
      });

      const result = {
        url,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        redirectLocation: response.headers['location'] || null,
        contentType: response.headers['content-type'] || null,
        server: response.headers['server'] || null,
        poweredBy: response.headers['x-powered-by'] || null,
        body:
          method === 'GET' && response.data
            ? truncateString(
                typeof response.data === 'string'
                  ? response.data
                  : JSON.stringify(response.data),
                2000
              )
            : null,
        responseTime: (response.config as any)?.responseTime || null,
      };

      logger.info('HTTP probe successful', { method, status: result.status });

      return result;
    } catch (error) {
      if (error instanceof Error && error.message === DISCOVERY_TARGET_REFUSED) throw error;

      if (error instanceof DiscoveryHttpError && error.response) {
        // Got response but with error status
        return {
          url,
          status: error.response.status,
          statusText: error.response.statusText,
          headers: error.response.headers,
          error: 'HTTP response error',
        };
      } else if (error instanceof DiscoveryHttpError) {
        // Request made but no response
        logger.warn('HTTP probe failed - no response', { method });
        throw new Error('No HTTP response');
      } else {
        // Setup errors may include the entire URL in their message.
        logger.error('HTTP probe failed', { method });
        throw new Error('HTTP probe failed');
      }
    }
  },
};

/**
 * Truncate string to max length
 */
function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength) + '... (truncated)';
}
