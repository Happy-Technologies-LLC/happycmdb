# Runbook: Rate Limiting Issues

**Alert Name**: `RateLimitViolations`, `CloudProviderRateLimited`
**Severity**: Warning
**Component**: api-server, discovery-engine, connectors
**Initial Response Time**: 15 minutes

## Symptoms

- High rate of 429 (Too Many Requests) errors
- Users unable to access API endpoints
- Discovery jobs failing with rate limit errors
- Cloud provider APIs rejecting requests
- Slow API response times due to throttling

## Impact

- **Users**: API access degraded or blocked, poor user experience
- **Discovery**: CI data not being updated, incomplete inventory
- **Operations**: Unable to make configuration changes via API
- **Integrations**: Third-party integrations failing

## Diagnosis

### 1. Identify Rate Limit Source

```bash
# Check application rate limiting (internal)
curl -s http://localhost:9090/api/v1/query?query=rate_limit_violations_total | jq

# Check API access logs for 429 responses
docker logs cmdb-api-server 2>&1 | grep " 429 "

# Identify top clients hitting rate limits
docker logs cmdb-api-server 2>&1 | grep " 429 " | awk '{print $1}' | sort | uniq -c | sort -rn | head -10
```

### 2. Check Cloud Provider Rate Limiting

```bash
# Check connector logs for cloud provider rate limiting
docker logs cmdb-discovery-engine 2>&1 | grep -i "rate limit\|throttle\|429\|quota"

# Check which connectors are being rate limited
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "SELECT connector_id, COUNT(*) as rate_limit_count
   FROM discovery_jobs
   WHERE error_message ILIKE '%rate%limit%'
   OR error_message ILIKE '%throttle%'
   OR error_message ILIKE '%429%'
   AND created_at > NOW() - INTERVAL '1 hour'
   GROUP BY connector_id
   ORDER BY rate_limit_count DESC;"

# Check rate limit metrics
curl -s http://localhost:9090/api/v1/query?query=connector_rate_limited_total | jq
```

### 3. Check Current Request Rates

```bash
# Overall API request rate
curl -s http://localhost:9090/api/v1/query?query=rate\(http_requests_total[1m]\) | jq

# Request rate by endpoint
curl -s http://localhost:9090/api/v1/query?query=rate\(http_requests_total[1m]\) by \(endpoint\) | jq

# Request rate by client IP
docker logs cmdb-api-server --since 5m | awk '{print $1}' | sort | uniq -c | sort -rn | head -20
```

### 4. Check Rate Limit Configuration

```bash
# View current rate limit settings
cat .env | grep -i "rate\|limit\|throttle"

# Check Redis rate limit counters
docker exec cmdb-redis redis-cli keys "rate_limit:*" | head -20
docker exec cmdb-redis redis-cli get "rate_limit:api:192.168.1.100"

# Check connector rate limit configs
cat packages/connectors/*/connector.json | jq '.rateLimits'
```

### 5. Identify Abusive Clients

```bash
# Top API consumers in last hour
docker logs cmdb-api-server --since 1h | awk '{print $1}' | sort | uniq -c | sort -rn | head -10

# Check for unusual patterns
docker logs cmdb-api-server --since 1h | grep -E "/api/v1" | awk '{print $7}' | sort | uniq -c | sort -rn | head -10

# Check user agent strings
docker logs cmdb-api-server --since 1h | grep "User-Agent" | sort | uniq -c | sort -rn
```

## Resolution Steps

### Step 1: Immediate Mitigation - Block Abusive Clients (if applicable)

```bash
# Identify top offender
ABUSIVE_IP=$(docker logs cmdb-api-server --since 5m | awk '{print $1}' | sort | uniq -c | sort -rn | head -1 | awk '{print $2}')

# Temporarily block the IP (if using nginx/firewall)
sudo iptables -A INPUT -s $ABUSIVE_IP -j DROP

# Or add to rate limit whitelist/blacklist
docker exec cmdb-redis redis-cli set "rate_limit:blocked:$ABUSIVE_IP" "1" EX 3600
```

### Step 2: Adjust Internal Rate Limits

Edit `.env` file to adjust rate limits:

```bash
# Increase rate limits if legitimate traffic
RATE_LIMIT_WINDOW_MS=60000           # 1 minute window
RATE_LIMIT_MAX_REQUESTS=200          # Increase from 100
RATE_LIMIT_SKIP_SUCCESSFUL_REQUESTS=false

# Per-endpoint limits
RATE_LIMIT_SEARCH_MAX=50            # Increase search endpoint limit
RATE_LIMIT_DISCOVERY_MAX=20         # Limit discovery job submission
```

Restart API server:

```bash
docker restart cmdb-api-server
```

### Step 3: Implement Exponential Backoff for Cloud Providers

For connectors hitting cloud provider rate limits, update connector configuration:

```json
{
  "rateLimits": {
    "requestsPerSecond": 5,
    "burstSize": 10,
    "backoff": {
      "type": "exponential",
      "initialDelay": 1000,
      "maxDelay": 60000,
      "multiplier": 2
    }
  }
}
```

Restart discovery engine:

```bash
docker restart cmdb-discovery-engine
```

### Step 4: Reduce Discovery Frequency

```bash
# Increase discovery intervals for rate-limited connectors
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "UPDATE discovery_definitions
   SET schedule_interval = schedule_interval * 2
   WHERE connector_id IN (
     SELECT id FROM connectors WHERE id IN (
       'aws', 'azure', 'gcp'  -- Adjust based on which are rate limited
     )
   );"

# Restart discovery engine to pick up new schedules
docker restart cmdb-discovery-engine
```

### Step 5: Request Higher Rate Limits from Cloud Providers

**AWS**:
```bash
# Request service quota increase via AWS Console or CLI
aws service-quotas request-service-quota-increase \
  --service-code ec2 \
  --quota-code L-1216C47A \
  --desired-value 5000

# Check current quotas
aws service-quotas list-service-quotas --service-code ec2
```

**Azure**:
```bash
# Submit quota increase request
az quota update \
  --resource-name standardNCFamily \
  --resource-type Microsoft.Compute/virtualMachines \
  --limit-value 100
```

**GCP**:
```bash
# Request quota increase
gcloud compute project-info describe --project PROJECT_ID
# Then increase via Google Cloud Console
```

### Step 6: Implement Request Batching

For connectors making many individual API calls, implement batching:

```typescript
// Example: Batch AWS EC2 describe calls
const instanceIds = [...]; // Large list
const batchSize = 100;

for (let i = 0; i < instanceIds.length; i += batchSize) {
  const batch = instanceIds.slice(i, i + batchSize);
  await ec2.describeInstances({ InstanceIds: batch });

  // Add delay between batches
  await new Promise(resolve => setTimeout(resolve, 1000));
}
```

### Step 7: Enable Caching

```bash
# Enable aggressive caching for frequently accessed endpoints
# Edit packages/api-server/src/middleware/cache.middleware.ts

# Increase cache TTL
docker exec cmdb-redis redis-cli config set maxmemory-policy allkeys-lru

# Set longer TTL for specific keys
docker exec cmdb-redis redis-cli config set "cache:ci:*" 3600  # 1 hour
```

### Step 8: Implement Circuit Breaker

Add circuit breaker to prevent cascading failures:

```typescript
// packages/common/src/utils/circuit-breaker.ts
class CircuitBreaker {
  private failureCount = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  async execute(fn: () => Promise<any>) {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > 60000) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
}
```

## Verification

After resolution:

1. **Rate Limit Errors**: <1% of requests returning 429
2. **API Response Time**: Normal response times (<500ms p95)
3. **Discovery Jobs**: Jobs completing without rate limit errors
4. **User Reports**: No complaints about API access
5. **Metrics**: `rate_limit_violations_total` stable or decreasing
6. **Cloud Provider Status**: No rate limit errors in connector logs

## Escalation

If issue persists after 1 hour:

1. **Escalate to**: Cloud Platform Team / Senior Backend Engineer
2. **Provide**:
   - Top clients by request volume
   - Endpoints most affected
   - Cloud provider error details
   - Current rate limit configuration
   - Request rate trends (last 24 hours)
3. **Consider**:
   - Emergency rate limit increase
   - Temporary service degradation
   - Client communication about rate limits
   - Premium cloud provider support

## Post-Incident Actions

1. **Client Education**: Notify clients about rate limits and best practices
2. **Documentation**: Update API docs with rate limit details
3. **Monitoring**: Add rate limit approach alerts (e.g., at 80% of limit)
4. **Architecture Review**: Consider API gateway with advanced rate limiting
5. **Load Testing**: Validate rate limits under realistic load
6. **Automation**: Implement auto-scaling of rate limits based on quota
7. **Client SDKs**: Provide SDKs with built-in rate limiting and retries

## Common Causes

| Cause | Frequency | Prevention |
|-------|-----------|------------|
| Misconfigured client (infinite loop) | High | Client SDK rate limiting, circuit breakers |
| Discovery jobs too aggressive | High | Connector rate limiting, backoff strategies |
| Legitimate traffic spike | Medium | Auto-scaling, dynamic rate limits |
| Cloud provider quota exceeded | Medium | Quota monitoring, request quota increases |
| Missing pagination in client | Low | Enforce pagination in API |
| DDoS attack | Low | WAF, IP-based blocking, Cloudflare |

## Related Runbooks

- [Discovery Jobs Failing](./discovery-jobs-failing.md)
- [Performance Degradation](./performance-degradation.md)
- [API Server Down](./api-server-down.md)

## Useful Commands

```bash
# View current rate limit violations
curl -s http://localhost:9090/api/v1/query?query=rate\(rate_limit_violations_total[5m]\) | jq

# Check Redis rate limit keys
docker exec cmdb-redis redis-cli --scan --pattern "rate_limit:*" | head -20

# Reset rate limits for specific IP
docker exec cmdb-redis redis-cli del "rate_limit:api:192.168.1.100"

# View rate limit configuration
cat .env | grep RATE_LIMIT

# Monitor real-time request rates
watch -n 5 "docker logs cmdb-api-server --since 1m | wc -l"

# Top 10 API consumers (last hour)
docker logs cmdb-api-server --since 1h | awk '{print $1}' | sort | uniq -c | sort -rn | head -10

# Check connector retry attempts
docker logs cmdb-discovery-engine 2>&1 | grep -i "retry\|backoff"
```

## Monitoring Queries

```promql
# Rate limit violation rate
rate(rate_limit_violations_total[5m])

# Rate limit violations by endpoint
rate(rate_limit_violations_total[5m]) by (endpoint)

# Connector rate limiting
rate(connector_rate_limited_total[5m])

# Request rate by status code
rate(http_requests_total[5m]) by (status)

# Percentage of rate limited requests
rate(http_requests_total{status="429"}[5m]) / rate(http_requests_total[5m])
```

## Rate Limit Headers

HappyCMDB API returns standard rate limit headers:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1678901234
Retry-After: 45
```

Clients should respect these headers and implement exponential backoff.
