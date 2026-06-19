# GraphQL API for CMDB Platform

This directory contains the complete GraphQL implementation for the HappyCMDB platform, providing a powerful and flexible query interface for configuration items and their relationships.

## Architecture Overview

```
graphql/
├── schema/
│   ├── typeDefs.ts       # GraphQL schema definitions
│   └── index.ts          # Schema exports
├── resolvers/
│   └── index.ts          # Query, Mutation, and Type resolvers
├── dataloaders/
│   └── ci-loader.ts      # DataLoader for batching and caching
├── server.ts             # Apollo Server configuration
├── example-queries.graphql # Example queries and mutations
└── README.md            # This file
```

## Features

### Query Capabilities
- **getCIs**: Fetch all CIs with filtering, pagination
- **getCI**: Get single CI by ID with relationships
- **searchCIs**: Full-text search across CIs
- **getCIRelationships**: Get relationships (incoming/outgoing/both)
- **getCIDependencies**: Recursive dependency resolution
- **getImpactAnalysis**: Analyze what depends on a CI

### Mutation Capabilities
- **createCI**: Create new configuration items
- **updateCI**: Update existing CIs
- **deleteCI**: Remove CIs and their relationships
- **createRelationship**: Link two CIs
- **deleteRelationship**: Remove relationships

### Performance Optimizations
- **DataLoader Integration**: Batches and caches database queries to prevent N+1 problems
- **Request-scoped Caching**: Fresh cache per request, prevents stale data
- **Batch Queries**: Efficient bulk operations for related CIs

## Getting Started

### Installation

Ensure all dependencies are installed:

```bash
npm install
# or
pnpm install
```

### Starting the Server

```typescript
import { startGraphQLServer } from './graphql/server';

// Start on default port (4000)
const server = await startGraphQLServer();

// Or specify custom port
const server = await startGraphQLServer(8080);
```

### Integration with Express

```typescript
import express from 'express';
import { createGraphQLServer } from './graphql/server';

const app = express();

// Add your custom middleware
app.use(cors());
app.use(json());

// Integrate GraphQL
await createGraphQLServer(app);

// Start server
app.listen(4000, () => {
  console.log('Server running at http://localhost:4000/graphql');
});
```

## GraphQL Playground

When running in development mode, GraphQL Playground is available at:
```
http://localhost:4000/graphql
```

Features include:
- Interactive query builder
- Schema documentation browser
- Query history
- Variable editor
- Response inspector

## Example Queries

### Basic CI Query

```graphql
query GetCI {
  getCI(id: "server-001") {
    id
    name
    type
    status
    environment
    metadata
  }
}
```

### Query with Relationships

```graphql
query GetCIWithRelationships {
  getCI(id: "server-001") {
    id
    name
    type
    relationships {
      type
      ci {
        id
        name
        type
      }
      properties
    }
  }
}
```

### Search with Filters

```graphql
query SearchServers {
  searchCIs(
    query: "web"
    filter: {
      type: SERVER
      status: ACTIVE
      environment: PRODUCTION
    }
    limit: 50
  ) {
    id
    name
    type
    status
  }
}
```

### Impact Analysis

```graphql
query ImpactAnalysis {
  getImpactAnalysis(id: "database-001", depth: 5) {
    ci {
      id
      name
      type
    }
    distance
  }
}
```

## Example Mutations

### Create CI

```graphql
mutation CreateServer {
  createCI(
    input: {
      id: "server-001"
      externalId: "i-1234567890"
      name: "Production Web Server"
      type: SERVER
      status: ACTIVE
      environment: PRODUCTION
      metadata: {
        "ip": "10.0.1.100"
        "region": "us-east-1"
      }
    }
  ) {
    id
    name
    createdAt
  }
}
```

### Create Relationship

```graphql
mutation CreateDependency {
  createRelationship(
    input: {
      fromId: "app-001"
      toId: "database-001"
      type: DEPENDS_ON
      properties: {
        "port": 5432
        "protocol": "tcp"
      }
    }
  )
}
```

### Update CI

```graphql
mutation UpdateServer {
  updateCI(
    id: "server-001"
    input: {
      status: MAINTENANCE
      metadata: {
        "maintenance_window": "2024-01-20T02:00:00Z"
      }
    }
  ) {
    id
    status
    updatedAt
  }
}
```

## GraphQL Schema Types

### CI Type
```graphql
type CI {
  id: ID!
  externalId: String
  name: String!
  type: CIType!
  status: CIStatus!
  environment: Environment
  createdAt: String!
  updatedAt: String!
  discoveredAt: String!
  metadata: JSON
  relationships: [RelatedCI!]!
  dependents: [RelatedCI!]!
  dependencies: [CI!]!
}
```

### Enums
- **CIType**: SERVER, VIRTUAL_MACHINE, CONTAINER, APPLICATION, SERVICE, DATABASE, NETWORK_DEVICE, STORAGE, LOAD_BALANCER, CLOUD_RESOURCE
- **CIStatus**: ACTIVE, INACTIVE, MAINTENANCE, DECOMMISSIONED
- **Environment**: PRODUCTION, STAGING, DEVELOPMENT, TEST
- **RelationshipType**: DEPENDS_ON, HOSTS, CONNECTS_TO, USES, OWNED_BY, PART_OF, DEPLOYED_ON, BACKED_UP_BY

## Error Handling

The API uses standard GraphQL error codes:

- **BAD_USER_INPUT**: Invalid input data (400)
- **NOT_FOUND**: Resource not found (404)
- **INTERNAL_SERVER_ERROR**: Server error (500)

Example error response:
```json
{
  "errors": [
    {
      "message": "CI not found",
      "extensions": {
        "code": "NOT_FOUND"
      },
      "path": ["getCI"]
    }
  ],
  "data": {
    "getCI": null
  }
}
```

## DataLoader Implementation

DataLoaders prevent N+1 query problems by batching multiple requests:

```typescript
// Instead of:
// Query 1: Get CI
// Query 2: Get relationships for CI
// Query 3: Get each related CI (N queries)

// DataLoader batches:
// Query 1: Get CI
// Query 2: Get relationships for CI
// Query 3: Batch get all related CIs (1 query)
```

### Available DataLoaders
- **ciLoader**: Batch load CIs by ID
- **relationshipLoader**: Batch load outgoing relationships
- **dependentLoader**: Batch load incoming relationships

## Context

Each GraphQL request receives a context object:

```typescript
interface GraphQLContext {
  neo4jClient: Neo4jClient;
  loaders: {
    ciLoader: DataLoader<string, CI | null>;
    relationshipLoader: DataLoader<string, any[]>;
    dependentLoader: DataLoader<string, any[]>;
  };
}
```

## Performance Best Practices

1. **Use DataLoaders**: Always access related data through context loaders
2. **Limit Depth**: Avoid deeply nested recursive queries
3. **Pagination**: Use limit/offset for large result sets
4. **Field Selection**: Only query fields you need
5. **Batch Operations**: Combine multiple queries in one request

## Testing

Example test using GraphQL client:

```typescript
import { ApolloServer } from '@apollo/server';
import { typeDefs } from './schema/typeDefs';
import { resolvers } from './resolvers';

describe('GraphQL Resolvers', () => {
  let server: ApolloServer;

  beforeAll(() => {
    server = new ApolloServer({ typeDefs, resolvers });
  });

  it('should get CI by ID', async () => {
    const result = await server.executeOperation({
      query: 'query { getCI(id: "test-001") { id name type } }',
    });

    expect(result.data.getCI).toBeDefined();
    expect(result.data.getCI.id).toBe('test-001');
  });
});
```

## Security Considerations

1. **Input Validation**: All inputs are validated before processing
2. **Error Sanitization**: Internal errors are sanitized in production
3. **Query Complexity**: Consider adding query complexity limits for production
4. **Rate Limiting**: Implement rate limiting at the HTTP layer
5. **Authentication**: Add authentication middleware as needed

## Environment Variables

```bash
# Neo4j Configuration
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=password

# Server Configuration
NODE_ENV=development  # or production
PORT=4000

# CORS Configuration
CORS_ORIGIN=http://localhost:3000
```

## Monitoring and Logging

All GraphQL errors are logged with context:

```typescript
logger.error('GraphQL Error:', {
  message: error.message,
  code: error.extensions?.code,
  path: error.path,
  originalError: error.originalError
});
```

## Future Enhancements

- [ ] Add authentication and authorization
- [ ] Implement subscriptions for real-time updates
- [ ] Add query complexity analysis and limiting
- [ ] Implement field-level caching with Redis
- [ ] Add metrics and tracing (OpenTelemetry)
- [ ] Add GraphQL federation for microservices

## References

- [Apollo Server Documentation](https://www.apollographql.com/docs/apollo-server/)
- [GraphQL Specification](https://spec.graphql.org/)
- [DataLoader GitHub](https://github.com/graphql/dataloader)
- [Neo4j GraphQL Integration](https://neo4j.com/developer/graphql/)
