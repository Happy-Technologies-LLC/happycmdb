// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { ApolloClient, ApolloLink, InMemoryCache, Observable, createHttpLink, from } from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { onError } from '@apollo/client/link/error';
import { gql } from '@apollo/client';
import { logClientError, logger } from '@/utils/logger';
import { getToken, removeToken } from '@/utils/token';
import { refreshSession } from '@/lib/session';

// HTTP Link
const httpLink = createHttpLink({
  uri: import.meta.env.VITE_GRAPHQL_URL || '/graphql',
});

// Auth Link - the in-memory access token (HAP-1211 H2), kept fresh by AuthContext's timed renewal
const authLink = setContext((_, { headers }) => {
  const token = getToken();
  return {
    headers: {
      ...headers,
      authorization: token ? `Bearer ${token}` : '',
    },
  };
});

// Session link - a 401 renews the session once from the refresh cookie and replays the operation once, like the
// REST interceptor (attachSession in lib/session.ts); a refused renewal or a second 401 signs out to /login.
// Sits before authLink so the replay carries the renewed in-memory token.
const isUnauthorized = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: unknown }).statusCode === 401;

export const sessionLink = new ApolloLink((operation, forward) =>
  new Observable((observer) => {
    let subscription: { unsubscribe(): void } | undefined;
    let closed = false;

    const signOut = (error: unknown) => {
      removeToken();
      window.location.href = '/login';
      observer.error(error);
    };

    const run = (replayed: boolean) => {
      subscription = forward(operation).subscribe({
        next: (result) => observer.next(result),
        complete: () => observer.complete(),
        error: (error) => {
          if (!isUnauthorized(error)) return observer.error(error);
          if (replayed) return signOut(error);
          void refreshSession().then(
            () => !closed && run(true),
            () => !closed && signOut(error),
          );
        },
      });
    };

    run(false);
    return () => {
      closed = true;
      subscription?.unsubscribe();
    };
  }),
);

// Error Link - log errors
const errorLink = onError(({ graphQLErrors, networkError }) => {
  if (graphQLErrors) {
    graphQLErrors.forEach(() => logger.error('GraphQL error'));
  }

  if (networkError) {
    logClientError('GraphQL network error', networkError);
  }
});

// Apollo Client
export const apolloClient = new ApolloClient({
  link: from([errorLink, sessionLink, authLink, httpLink]),
  cache: new InMemoryCache({
    typePolicies: {
      Query: {
        fields: {
          cis: {
            keyArgs: ['filters', 'sort'],
            merge(existing = { data: [], total: 0 }, incoming) {
              return incoming;
            },
          },
        },
      },
    },
  }),
  defaultOptions: {
    watchQuery: {
      fetchPolicy: 'cache-and-network',
      errorPolicy: 'all',
    },
    query: {
      fetchPolicy: 'network-only',
      errorPolicy: 'all',
    },
    mutate: {
      errorPolicy: 'all',
    },
  },
});

// Common GraphQL Queries
export const GET_CIS = gql`
  query GetCIs(
    $filters: CIFilters
    $sort: SortOptions
    $pagination: PaginationOptions
  ) {
    cis(filters: $filters, sort: $sort, pagination: $pagination) {
      data {
        ci_id
        name
        type
        status
        environment
        description
        ip_address
        hostname
        os
        version
        location
        owner
        tags
        discovered_at
        last_seen
        confidence_score
        created_at
        updated_at
      }
      total
      page
      limit
      total_pages
    }
  }
`;

export const GET_CI_BY_ID = gql`
  query GetCIById($ciId: ID!) {
    ci(ci_id: $ciId) {
      ci_id
      name
      type
      status
      environment
      description
      ip_address
      hostname
      os
      version
      location
      cost_center
      owner
      tags
      metadata
      discovered_at
      last_seen
      confidence_score
      created_at
      updated_at
    }
  }
`;

export const GET_CI_RELATIONSHIPS = gql`
  query GetCIRelationships($ciId: ID!) {
    ciRelationships(ci_id: $ciId) {
      relationship_id
      from_ci_id
      to_ci_id
      relationship_type
      properties
      created_at
      fromCI {
        ci_id
        name
        type
        status
      }
      toCI {
        ci_id
        name
        type
        status
      }
    }
  }
`;

export const GET_CI_DEPENDENCY_GRAPH = gql`
  query GetCIDependencyGraph($ciId: ID!, $depth: Int) {
    ciDependencyGraph(ci_id: $ciId, depth: $depth) {
      nodes {
        id
        label
        type
        status
        metadata
      }
      edges {
        id
        from
        to
        label
        type
      }
    }
  }
`;

export const SEARCH_CIS = gql`
  query SearchCIs($query: String!, $limit: Int) {
    searchCIs(query: $query, limit: $limit) {
      ci_id
      name
      type
      status
      environment
      ip_address
      hostname
      description
    }
  }
`;

export const GET_DASHBOARD_STATS = gql`
  query GetDashboardStats {
    dashboardStats {
      total_cis
      cis_by_type
      cis_by_status
      cis_by_environment
      recent_discoveries
      health_score
    }
  }
`;

export const GET_DISCOVERY_JOBS = gql`
  query GetDiscoveryJobs($pagination: PaginationOptions) {
    discoveryJobs(pagination: $pagination) {
      data {
        job_id
        provider
        status
        started_at
        completed_at
        cis_discovered
        error_message
      }
      total
      page
      limit
    }
  }
`;

// Common GraphQL Mutations
export const CREATE_CI = gql`
  mutation CreateCI($input: CreateCIInput!) {
    createCI(input: $input) {
      ci_id
      name
      type
      status
      environment
      created_at
    }
  }
`;

export const UPDATE_CI = gql`
  mutation UpdateCI($ciId: ID!, $input: UpdateCIInput!) {
    updateCI(ci_id: $ciId, input: $input) {
      ci_id
      name
      type
      status
      environment
      updated_at
    }
  }
`;

export const DELETE_CI = gql`
  mutation DeleteCI($ciId: ID!) {
    deleteCI(ci_id: $ciId) {
      success
      message
    }
  }
`;

export const CREATE_RELATIONSHIP = gql`
  mutation CreateRelationship($input: CreateRelationshipInput!) {
    createRelationship(input: $input) {
      relationship_id
      from_ci_id
      to_ci_id
      relationship_type
      created_at
    }
  }
`;

export const DELETE_RELATIONSHIP = gql`
  mutation DeleteRelationship($relationshipId: ID!) {
    deleteRelationship(relationship_id: $relationshipId) {
      success
      message
    }
  }
`;

export const TRIGGER_DISCOVERY = gql`
  mutation TriggerDiscovery($provider: String!, $config: JSONObject) {
    triggerDiscovery(provider: $provider, config: $config) {
      job_id
      provider
      status
      started_at
    }
  }
`;

// Export all
export default apolloClient;
