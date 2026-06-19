# Page Title

Brief introduction to the topic (1-2 paragraphs). Explain what this page covers and why it's important.

## Overview

Provide a high-level overview of the topic.

## Prerequisites

List any prerequisites needed before following this guide:

- Prerequisite 1
- Prerequisite 2
- Prerequisite 3

## Main Content Section

### Subsection 1

Detailed content here.

#### Code Example

```typescript
// Example TypeScript code
interface Example {
  id: string;
  name: string;
}

const example: Example = {
  id: '123',
  name: 'HappyCMDB'
};
```

### Subsection 2

More content here.

#### Command Example

```bash
# Example bash command
npm install @cmdb/cli
```

## Best Practices

::: tip Best Practice
Use tips for best practices and helpful information.
:::

::: warning Important
Use warnings for important information that needs attention.
:::

::: danger Critical
Use danger blocks for critical information or warnings about destructive operations.
:::

## Common Issues

### Issue 1: Description

**Problem**: Describe the problem

**Solution**: Provide the solution

```bash
# Solution command
npm run fix
```

### Issue 2: Description

**Problem**: Another problem

**Solution**: Another solution

## Configuration Examples

### Example 1

```yaml
# YAML configuration example
apiVersion: v1
kind: Service
metadata:
  name: happycmdb
spec:
  type: ClusterIP
  ports:
    - port: 4000
```

### Example 2

```json
{
  "apiVersion": "v1",
  "kind": "ConfigMap",
  "metadata": {
    "name": "happycmdb-config"
  },
  "data": {
    "database.host": "localhost"
  }
}
```

## API Reference (if applicable)

### Endpoint Name

**Method**: `POST`
**Path**: `/api/v1/resource`
**Authentication**: Required

**Request Body**:
```json
{
  "field1": "value1",
  "field2": "value2"
}
```

**Response**:
```json
{
  "id": "123",
  "status": "success"
}
```

## Tables (if needed)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Resource name |
| `type` | string | Yes | Resource type |
| `enabled` | boolean | No | Enable flag (default: true) |

## Diagrams (optional)

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│     API     │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Database   │
└─────────────┘
```

## Related Resources

Links to related documentation:

- [Related Topic 1](./related-1)
- [Related Topic 2](./related-2)
- [External Resource](https://example.com)

## Next Steps

- [ ] Task 1 to complete
- [ ] Task 2 to complete
- [ ] Task 3 to complete

## Additional Resources

- [Official Documentation](https://example.com)
- [GitHub Repository](https://github.com/example/repo)
- [Community Forum](https://forum.example.com)

---

**Last Updated**: 2025-10-04
**Maintainer**: HappyCMDB Team
