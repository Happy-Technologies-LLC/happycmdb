# Changelog

## Unreleased

- **Breaking:** Removed `ConnectorExecutor`, `getConnectorExecutor`, and `ExecutionOptions` package-root exports and deleted `src/executor/connector-executor` (including deep imports). That executor fetched configuration by ID without a verified organization and could surface raw errors. No known in-repository production consumers; external callers must use organization-scoped REST or verified integration-hub routes instead. No shim is provided.
- Stored credential references are rejected before lookup/decryption for every caller until credential organization ownership can be proven. Inline connection settings remain write-only and restricted to the parent organization; platform-operator access to historical NULL-organization configurations must be explicit.
