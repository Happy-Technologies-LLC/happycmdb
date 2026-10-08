// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP Probe Tool
 * Allows AI to probe HTTP/HTTPS endpoints
 */

import { AxiosError } from 'axios';
import { DiscoveryTool } from '../types';
import { logger, DISCOVERY_TARGET_REFUSED } from '@cmdb/common';
import { safeDiscoveryHttp } from './safe-http';

export const httpProbeTool: DiscoveryTool = {
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
      method = 'GET',
    } = params;
    const methodLabel = ['GET', 'HEAD', 'POST', 'OPTIONS'].includes(method) ? method : 'OTHER';

    // Determine default port
    const defaultPort = protocol === 'https' ? 443 : 80;
    const targetPort = port || defaultPort;

    const url = `${protocol}://${host}:${targetPort}${path}`;

    logger.info('Probing HTTP endpoint', { method: methodLabel });

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

      logger.info('HTTP probe successful', { method: methodLabel, status: result.status });

      return result;
    } catch (error) {
      if (error instanceof Error && error.message === DISCOVERY_TARGET_REFUSED) throw error;
      const axiosError = error as AxiosError;

      if (axiosError.response) {
        // Got response but with error status
        return {
          url,
          status: axiosError.response.status,
          statusText: axiosError.response.statusText,
          headers: axiosError.response.headers,
          error: 'HTTP response error',
        };
      } else if (axiosError.request) {
        // Request made but no response
        logger.warn('HTTP probe failed - no response', { method: methodLabel });
        throw new Error('No HTTP response');
      } else {
        // Setup errors may include the entire URL in their message.
        logger.error('HTTP probe failed', { method: methodLabel });
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
