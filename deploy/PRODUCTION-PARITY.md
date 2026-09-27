# Production parity reference

Production behavior is defined by the API and web production Dockerfile stages, the API production deployment, Kubernetes ingress policies, and the runtime configuration schema/loader. Staging MUST preserve those production settings. Only secrets, data, hostnames/origins, and scale may differ.

| Setting | Production reference | Build01 staging | Reason for permitted difference |
| --- | --- | --- | --- |
| API runtime | Dockerfile.api production stage: Node 20 Alpine, non-root [0mnodejs[0m, dumb-init; [0mNODE_ENV=production[0m | Same image build and [0mNODE_ENV=production[0m | Identical runtime behavior |
| Web runtime | Dockerfile.web production stage: built static React bundle served by non-root nginx, dumb-init | Same production Dockerfile and static nginx server | Production artifact parity |
| API config | Loader selects environment config and schema defaults; production mode and explicit runtime configuration | Set [0mNODE_ENV=production[0m; explicitly provide config/security env | Avoid development defaults |
| Authentication | JWT sign and verify both enforce configured issuer and audience; secret is externally supplied | Same issuer/audience and secret-required configuration | Secret differs only |
| CORS | Explicit trusted production origin; credentials policy remains production-safe | Origin is supplied as [0mSTAGING_PUBLIC_URL[0m and restricted to staging hostname | Hostname/origin differs |
| Rate limiting | Production ingress policy: 100 requests, 10 requests/sec; runtime rate limiting remains enabled | Preserve runtime limits; loopback ingress/proxy is staging topology | Scale/edge topology differs, not policy |
| Logging/security | Production logging level, security headers, input validation, and monitoring config | Explicit production config defaults; no dev bypass | Same controls |
| Database | PostgreSQL/Timescale, Neo4j, Redis; production uses TLS/cluster endpoints and credentials from Kubernetes secrets | Same engines and application configuration; local compose service DNS, staging data, TLS disabled only for private internal container network | Data, secrets, topology differ |
| Kafka | Production deployment provides brokers | Empty broker list (documented optional; startup remains degraded/healthy) | Staging scale intentionally omits optional service |
| Scale | API 3 replicas with rolling strategy/resources; clustered stateful services | One compose instance with bounded local volumes | Scale differs |
| Exposure | HTTPS ingress, TLS redirect, ingress limits | Published ports bind 127.0.0.1 only behind approved host proxy | Staging hostname/network topology differs |

Production reference files: [0minfrastructure/docker/Dockerfile.api[0m, [0minfrastructure/docker/Dockerfile.web[0m, [0minfrastructure/kubernetes/deployments/api-server-deployment.yaml[0m, [0minfrastructure/kubernetes/ingress/api-ingress.yaml[0m, and [0mpackages/common/src/config/config.schema.ts[0m. Compose settings must remain production-equivalent except for the listed environment-specific differences.
