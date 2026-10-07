# Integration framework

Connector registration and execution are mediated by organization-scoped services. A verified user organization (or the separately verified platform-operator legacy path) is required for configuration access and execution. Stored `credential_id` references currently refuse connection tests, validation, and runs before credential lookup because credential ownership cannot yet be proven; inline connection secrets remain write-only.

## Breaking API removal

`ConnectorExecutor`, `getConnectorExecutor`, and `ExecutionOptions` are no longer exported. The old `src/executor/connector-executor` implementation and deep import were deleted; there is no compatibility alias. It loaded configurations by ID without an organization boundary and could emit raw provider errors. No in-repository production consumer uses it; external consumers must migrate to the organization-scoped REST `/api/v1/connector-configs` or verified integration-hub `/api/v1/connectors` interfaces. The REST run endpoint currently records a queued run; it does not execute it without a consumer. The integration hub invokes the organization-checking manager for execution.
