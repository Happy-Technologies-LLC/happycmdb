# Changelog

## Unreleased

- **Breaking:** Removed `ConnectorExecutor`, `getConnectorExecutor`, and `ExecutionOptions` package-root exports and deleted `src/executor/connector-executor` (including deep imports). That executor fetched configuration by ID without a verified organization and could surface raw errors. No known in-repository production consumers; external callers must use organization-scoped REST or verified integration-hub routes instead. No shim is provided.
- **Breaking:** Removed `IntegrationManager`, `getIntegrationManager`, and `ConnectorConfigurationRow` package-root exports. Trusted API/hub code imports the internal manager after verifying organization identity; its deep module path is not an auth boundary and must not be loaded into untrusted plugins/scripts. External callers must use verified REST or hub interfaces.
- Global connector install/update/verify/uninstall and registry refresh now fail with a fixed lifecycle-unavailable error for all HTTP/GraphQL/CLI identities (including verified platform operators) until P-6. Installation is deploy-time/operator-only.
- Stored credential references are rejected before lookup/decryption for every caller until credential organization ownership can be proven. Inline connection settings remain write-only and restricted to the parent organization; platform-operator access to historical NULL-organization configurations must be explicit.
- Startup schedules retain configuration IDs and owner organizations, not initialized connectors or cached inline secrets. Installer failures and logs omit raw download URLs and provider errors.
