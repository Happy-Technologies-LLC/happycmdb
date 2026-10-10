// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiz Cloud Identities Extractor
 * Handles extraction of cloud identities from Wiz GraphQL API
 */

import { AxiosInstance } from 'axios';
import { logger } from '@cmdb/common';
import { ExtractedData } from '@cmdb/integration-framework';
import { GraphQLResponse } from '../types';
import { parseIdentity } from '../parsers/identity.parser';

export async function extractIdentities(
  client: AxiosInstance,
  config: any,
  resourceConfig?: Record<string, any>
): Promise<ExtractedData[]> {
  const extractedData: ExtractedData[] = [];
  const maxResults = resourceConfig?.max_results || 500;
  let hasNextPage = true;
  let endCursor: string | null = null;

  const cloudProviders = resourceConfig?.cloud_providers_filter ||
                         config.connection['identities']?.cloud_providers ||
                         ['AWS', 'Azure', 'GCP'];

  const identityTypes = resourceConfig?.identity_types_filter ||
                       config.connection['identities']?.identity_types ||
                       ['USER', 'SERVICE_ACCOUNT', 'ROLE'];

  logger.info('Extracting Wiz cloud identities');

  const query = `
    query GetIdentities($first: Int!, $after: String, $filters: IdentityFilters) {
      graphSearch(
        query: { type: [CLOUD_IDENTITY], where: $filters }
        first: $first
        after: $after
      ) {
        nodes {
          entities {
            id
            name
            type
            properties
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
      if (cloudProviders.length > 0) {
        filters.cloudPlatform = cloudProviders;
      }
      if (identityTypes.length > 0) {
        filters.type = identityTypes;
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

      const nodes = response.data.data?.graphSearch?.nodes || [];
      const pageInfo = response.data.data?.graphSearch?.pageInfo;

      for (const node of nodes) {
        const entities = node.entities || [];
        for (const entity of entities) {
          const identityData = parseIdentity(entity);
          extractedData.push({
            external_id: identityData.id,
            data: identityData,
            source_type: 'wiz',
            extracted_at: new Date(),
          });
        }
      }

      logger.info('Extracted batch of Wiz cloud identities', {
        batch_size: nodes.length,
        total_extracted: extractedData.length,
      });

      hasNextPage = pageInfo?.hasNextPage || false;
      endCursor = pageInfo?.endCursor || null;

      if (extractedData.length >= maxResults) {
        break;
      }

    } catch (error) {
      logger.error('Wiz cloud identity extraction failed');
      throw new Error('Connector extraction failed');
    }
  }

  logger.info('Wiz cloud identity extraction completed', {
    total_records: extractedData.length,
  });

  return extractedData;
}
