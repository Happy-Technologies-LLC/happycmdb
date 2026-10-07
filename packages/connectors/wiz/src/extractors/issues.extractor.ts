// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiz Security Issues Extractor
 * Handles extraction of security issues from Wiz GraphQL API
 */

import { AxiosInstance } from 'axios';
import { logger } from '@cmdb/common';
import { ExtractedData } from '@cmdb/integration-framework';
import { WizIssue, GraphQLResponse } from '../types';

export async function extractIssues(
  client: AxiosInstance,
  config: any,
  resourceConfig?: Record<string, any>
): Promise<ExtractedData[]> {
  const extractedData: ExtractedData[] = [];
  const maxResults = resourceConfig?.max_results || 500;
  let hasNextPage = true;
  let endCursor: string | null = null;

  const severityFilter = resourceConfig?.severity_filter ||
                        config.connection['issues']?.severity ||
                        ['CRITICAL', 'HIGH', 'MEDIUM'];

  const statusFilter = resourceConfig?.status_filter ||
                      config.connection['issues']?.status ||
                      ['OPEN', 'IN_PROGRESS'];

  logger.info('Extracting Wiz security issues');

  const query = `
    query GetIssues($first: Int!, $after: String, $filters: IssueFilters) {
      issues(
        first: $first
        after: $after
        filterBy: $filters
      ) {
        nodes {
          id
          type
          control {
            id
            name
            description
            severity
          }
          severity
          status
          createdAt
          updatedAt
          resolvedAt
          dueAt
          statusChangedAt
          entitySnapshot {
            id
            name
            type
            cloudPlatform
          }
          notes
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

      const response = await client.post<GraphQLResponse<any>>('', {
        query,
        variables: {
          first: Math.min(maxResults, 500),
          after: endCursor,
          filters: Object.keys(filters).length > 0 ? filters : undefined,
        },
      });

      if (response.data.errors) { throw new Error('Wiz GraphQL query failed'); }

      const nodes = response.data.data?.issues?.nodes || [];
      const pageInfo = response.data.data?.issues?.pageInfo;

      for (const issue of nodes) {
        extractedData.push({
          external_id: issue.id,
          data: issue as WizIssue,
          source_type: 'wiz',
          extracted_at: new Date(),
        });
      }

      logger.info('Extracted batch of Wiz security issues', {
        batch_size: nodes.length,
        total_extracted: extractedData.length,
      });

      hasNextPage = pageInfo?.hasNextPage || false;
      endCursor = pageInfo?.endCursor || null;

      if (extractedData.length >= maxResults) {
        break;
      }

    } catch (error) {
      logger.error('Wiz security issue extraction failed');
      throw new Error('Connector extraction failed');
    }
  }

  logger.info('Wiz security issue extraction completed', {
    total_records: extractedData.length,
  });

  return extractedData;
}
