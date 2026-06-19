// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP Probe Tool
 * Allows AI to probe HTTP/HTTPS endpoints
 */

import axios, { AxiosError } from 'axios';
import { DiscoveryTool } from '../types';
import { logger } from '@cmdb/common';

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

    // Determine default port
    const defaultPort = protocol === 'https' ? 443 : 80;
    const targetPort = port || defaultPort;

    const url = `${protocol}://${host}:${targetPort}${path}`;

    logger.info(`Probing HTTP endpoint`, { url, method });

    try {
      const response = await axios({
        method,
        url,
        timeout: 10000, // 10 seconds
        maxRedirects: 0, // Don't follow redirects
        validateStatus: () => true, // Accept any status code
        headers: {
          'User-Agent': 'HappyCMDB-Discovery/2.0',
        },
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

      logger.info(`HTTP probe successful`, {
        url,
        status: result.status,
        contentType: result.contentType,
      });

      return result;
    } catch (error) {
      const axiosError = error as AxiosError;

      if (axiosError.response) {
        // Got response but with error status
        return {
          url,
          status: axiosError.response.status,
          statusText: axiosError.response.statusText,
          headers: axiosError.response.headers,
          error: axiosError.message,
        };
      } else if (axiosError.request) {
        // Request made but no response
        logger.warn('HTTP probe failed - no response', { url, error: axiosError.message });
        throw new Error(`No response from ${url}: ${axiosError.message}`);
      } else {
        // Request setup error
        logger.error('HTTP probe failed', { url, error });
        throw new Error(
          `HTTP probe failed: ${error instanceof Error ? error.message : String(error)}`
        );
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
