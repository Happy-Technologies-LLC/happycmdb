// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiz Cloud Resources Extractor
 * Handles extraction of cloud resources from Wiz GraphQL API
 */

import { AxiosInstance } from 'axios';
import { logger } from '@cmdb/common';
import { ExtractedData } from '@cmdb/integration-framework';
import { WizCloudResource, GraphQLResponse } from '../types';
import { parseCloudResource } from '../parsers/cloud-resource.parser';

export async function extractCloudResources(
  client: AxiosInstance,
  config: any,
  resourceConfig?: Record<string, any>
): Promise<ExtractedData[]> {
  const extractedData: ExtractedData[] = [];
  const maxResults = resourceConfig?.max_results || 500;
  let hasNextPage = true;
  let endCursor: string | null = null;

  const cloudProviders = resourceConfig?.cloud_providers_filter ||
                         config.connection['cloud_resources']?.cloud_providers ||
                         ['AWS', 'Azure', 'GCP'];

  const resourceTypes = resourceConfig?.resource_types_filter ||
                       config.connection['cloud_resources']?.resource_types ||
                       [];

  logger.info('Extracting Wiz cloud resources');

  const query = `
    query GetCloudResources($first: Int!, $after: String, $filters: CloudResourceFilters) {
      graphSearch(
        query: { type: [CLOUD_RESOURCE], where: $filters }
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
      if (resourceTypes.length > 0) {
        filters.type = resourceTypes;
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
          const resourceData = parseCloudResource(entity);
          extractedData.push({
            external_id: resourceData.id,
            data: resourceData,
            source_type: 'wiz',
            extracted_at: new Date(),
          });
        }
      }

      logger.info('Extracted batch of Wiz cloud resources', {
        batch_size: nodes.length,
        total_extracted: extractedData.length,
      });

      hasNextPage = pageInfo?.hasNextPage || false;
      endCursor = pageInfo?.endCursor || null;

      if (extractedData.length >= maxResults) {
        break;
      }

    } catch (error) {
      logger.error('Wiz cloud resource extraction failed');
      throw new Error('Connector extraction failed');
    }
  }

  logger.info('Wiz cloud resource extraction completed', {
    total_records: extractedData.length,
  });

  return extractedData;
}
