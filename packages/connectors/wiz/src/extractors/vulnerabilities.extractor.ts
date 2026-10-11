// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiz Vulnerabilities Extractor
 * Handles extraction of vulnerabilities from Wiz GraphQL API
 */

import { AxiosInstance } from 'axios';
import { logger } from '@cmdb/common';
import { ExtractedData } from '@cmdb/integration-framework';
import { WizVulnerability, GraphQLResponse } from '../types';

export async function extractVulnerabilities(
  client: AxiosInstance,
  config: any,
  resourceConfig?: Record<string, any>
): Promise<ExtractedData[]> {
  const extractedData: ExtractedData[] = [];
  const maxResults = resourceConfig?.max_results || 500;
  let hasNextPage = true;
  let endCursor: string | null = null;

  const severityFilter = resourceConfig?.severity_filter ||
                        config.connection['vulnerabilities']?.severity ||
                        ['CRITICAL', 'HIGH', 'MEDIUM'];

  const statusFilter = resourceConfig?.status_filter ||
                      config.connection['vulnerabilities']?.status ||
                      ['OPEN', 'IN_PROGRESS'];

  const hasExploitOnly = resourceConfig?.has_exploit_only ||
                        config.connection['vulnerabilities']?.has_exploit ||
                        false;

  logger.info('Extracting Wiz vulnerabilities');

  const query = `
    query GetVulnerabilities($first: Int!, $after: String, $filters: VulnerabilityFilters) {
      vulnerabilities(
        first: $first
        after: $after
        filterBy: $filters
      ) {
        nodes {
          id
          name
          detailedName
          description
          severity
          cvssScore
          vendorSeverity
          cveId
          exploitabilityScore
          hasExploit
          status
          resolution
          fixedVersion
          detectedAt
          resolvedAt
          affectedResource {
            id
            name
            type
          }
          packages {
            name
            version
            fixedVersion
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
        totalCount
      }
    }
  `;

  while (hasNextPage) {
    try {
      const filters: any = {};
      if (severityFilter.length > 0) {
        filters.severity = severityFilter;
      }
      if (statusFilter.length > 0) {
        filters.status = statusFilter;
      }
      if (hasExploitOnly) {
        filters.hasExploit = true;
      }

      const response = await client.post<GraphQLResponse<any>>('', {
        query,
        variables: {
          first: Math.min(maxResults, 500),
          after: endCursor,
          filters: Object.keys(filters).length > 0 ? filters : undefined,
        },
      });

      if (response.data.errors) { throw new Error('Wiz GraphQL query failed'); }

      const nodes = response.data.data?.vulnerabilities?.nodes || [];
      const pageInfo = response.data.data?.vulnerabilities?.pageInfo;

      for (const vuln of nodes) {
        extractedData.push({
          external_id: vuln.id,
          data: vuln as WizVulnerability,
          source_type: 'wiz',
          extracted_at: new Date(),
        });
      }

      logger.info('Extracted batch of Wiz vulnerabilities', {
        batch_size: nodes.length,
        total_extracted: extractedData.length,
      });

      hasNextPage = pageInfo?.hasNextPage || false;
      endCursor = pageInfo?.endCursor || null;

      if (extractedData.length >= maxResults) {
        break;
      }

    } catch (error) {
      logger.error('Wiz vulnerability extraction failed');
      throw new Error('Connector extraction failed');
    }
  }

  logger.info('Wiz vulnerability extraction completed', {
    total_records: extractedData.length,
  });

  return extractedData;
}
