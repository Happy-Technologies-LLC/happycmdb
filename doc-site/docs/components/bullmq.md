---
title: BullMQ Queue Management
description: Queue management, job orchestration, and worker configuration
---

# BullMQ Queue Management

Queue management system for job orchestration using BullMQ with Redis backend.

## Queue Names

These are the actual BullMQ queue names (`QUEUE_NAMES` in `@cmdb/common`) that the jobs CLI
and the `/api/v1/jobs/:queueName` routes take.

### Discovery Queues
- `discovery-aws` - AWS resource discovery
- `discovery-azure` - Azure resource discovery
- `discovery-gcp` - GCP resource discovery
- `discovery-ssh` - SSH-based server discovery
- `discovery-nmap` - Network mapping
- `discovery-active-directory` - Active Directory discovery (read-only through the jobs API)
- `discovery-snmp` - SNMP discovery (read-only through the jobs API)
- `discovery-ai` - AI discovery (read-only through the jobs API)

### ETL Queues
- `etl-sync` - Incremental Neo4j → PostgreSQL sync
- `etl-change-detection` - CI change detection
- `etl-reconciliation` - Data reconciliation
- `etl-full-refresh` - Full data refresh

## CLI Commands

### Worker Management

```bash
# Start all workers with schedulers
cmdb worker start all -s

# Start discovery workers only
cmdb worker start discovery

# Start ETL workers only
cmdb worker start etl

# Stop workers
cmdb worker stop all

# Check worker status
cmdb worker status

# Pause a worker
cmdb worker pause aws-discovery-worker

# Resume a worker
cmdb worker resume aws-discovery-worker
```

### Job Management

::: warning Jobs CLI tenant boundary
`cmdb jobs list`, `status`, `retry` and `cancel` only see and change jobs owned by your
organization, through the authenticated `/api/v1/jobs` routes. They need a JWT
(`--token <jwt>` or `CMDB_ACCESS_TOKEN`) or an API key (the global `--key <key>` option or
`CMDB_API_KEY`) and an actual queue name such as `discovery-nmap` or `etl-sync`; there is no
tokenless or `--all` listing, and raw worker results, progress, failure reasons, stack
traces and job configuration are never printed. `cmdb jobs stats` and `cmdb jobs run:etl`
exit nonzero with `Queue operations require the authenticated API; global operations
unavailable` until a separately authorized platform-operations API exists (HP1-S6/P-6).
See the repository README, "Jobs CLI tenant boundary", and the
[CLI commands reference](/quick-reference/cli-commands#job-management).
:::

```bash
# List your organization's jobs in a queue
cmdb jobs list discovery-nmap --token "$CMDB_ACCESS_TOKEN"
cmdb jobs list discovery-nmap -s failed -l 50 --token "$CMDB_ACCESS_TOKEN"

# Queue Nmap discovery for your organization
cmdb jobs run:discovery nmap --token "$CMDB_ACCESS_TOKEN"

# Check, retry or cancel one of your jobs
cmdb jobs status discovery-nmap <job-id> --token "$CMDB_ACCESS_TOKEN"
cmdb jobs retry discovery-nmap <job-id> --token "$CMDB_ACCESS_TOKEN"
cmdb jobs cancel discovery-nmap <job-id> --token "$CMDB_ACCESS_TOKEN"

# Unavailable: exit nonzero with the fixed refusal (HP1-S6/P-6)
cmdb jobs run:etl sync
cmdb jobs stats
```

## API Endpoints

### Trigger Jobs

**Discovery Job:**
```bash
POST /api/v1/jobs/discovery/:provider

curl -X POST http://localhost:3000/api/v1/jobs/discovery/aws \
  -H "Content-Type: application/json" \
  -d '{"config": {"regions": ["us-east-1"]}, "triggeredBy": "admin"}'
```

**ETL Job:**
```bash
POST /api/v1/jobs/etl/:type

curl -X POST http://localhost:3000/api/v1/jobs/etl/sync \
  -H "Content-Type: application/json" \
  -d '{"config": {"batchSize": 1000}, "triggeredBy": "admin"}'
```

### Job Status

**Get Job Status:**
```bash
GET /api/v1/jobs/:queueName/:jobId

curl http://localhost:3000/api/v1/jobs/discovery:aws/12345
```

**List Jobs:**
```bash
GET /api/v1/jobs/:queueName?state=waiting&start=0&end=99

curl http://localhost:3000/api/v1/jobs/discovery:aws?state=failed
```

### Job Management

**Retry Job:**
```bash
POST /api/v1/jobs/:queueName/:jobId/retry

curl -X POST http://localhost:3000/api/v1/jobs/discovery:aws/12345/retry
```

**Cancel Job:**
```bash
DELETE /api/v1/jobs/:queueName/:jobId

curl -X DELETE http://localhost:3000/api/v1/jobs/discovery:aws/12345
```

**Clean Queue:**
```bash
POST /api/v1/jobs/:queueName/clean

curl -X POST http://localhost:3000/api/v1/jobs/discovery:aws/clean \
  -H "Content-Type: application/json" \
  -d '{"grace": 3600000, "limit": 1000, "type": "completed"}'
```

### Queue Monitoring

**Get All Queue Stats:**
```bash
GET /api/v1/queues/stats

curl http://localhost:3000/api/v1/queues/stats
```

**Get Queue Metrics:**
```bash
GET /api/v1/queues/:queueName/metrics

curl http://localhost:3000/api/v1/queues/discovery:aws/metrics
```

**Get Worker Status:**
```bash
GET /api/v1/queues/workers/status

curl http://localhost:3000/api/v1/queues/workers/status
```

**Pause/Resume Queue:**
```bash
# Pause
POST /api/v1/queues/:queueName/pause
curl -X POST http://localhost:3000/api/v1/queues/discovery:aws/pause

# Resume
POST /api/v1/queues/:queueName/resume
curl -X POST http://localhost:3000/api/v1/queues/discovery:aws/resume
```

### Schedule Management

**Get Discovery Schedules:**
```bash
GET /api/v1/jobs/schedules/discovery

curl http://localhost:3000/api/v1/jobs/schedules/discovery
```

**Update Discovery Schedule:**
```bash
PUT /api/v1/jobs/schedules/discovery/:provider

curl -X PUT http://localhost:3000/api/v1/jobs/schedules/discovery/aws \
  -H "Content-Type: application/json" \
  -d '{"cronPattern": "*/30 * * * *"}'
```

## Programmatic Usage

### TypeScript/JavaScript

**Get Queue Manager:**
```typescript
import { getQueueManager, QUEUE_NAMES } from '@cmdb/common';

const queueManager = getQueueManager();
const queue = queueManager.getQueue(QUEUE_NAMES.DISCOVERY_AWS);
```

**Add Job:**
```typescript
import { getQueueManager, QUEUE_NAMES } from '@cmdb/common';
import type { DiscoveryJobData } from '@cmdb/common';

const queueManager = getQueueManager();

const jobData: DiscoveryJobData = {
  jobId: 'uuid-here',
  provider: 'aws',
  config: {
    regions: ['us-east-1'],
  },
  createdAt: new Date().toISOString(),
  triggeredBy: 'system',
};

const job = await queueManager.addJob(
  QUEUE_NAMES.DISCOVERY_AWS,
  'discovery-aws',
  jobData
);

console.log(`Job ${job.id} queued`);
```

**Get Job Status:**
```typescript
const job = await queueManager.getJob(QUEUE_NAMES.DISCOVERY_AWS, 'job-id');
const state = await job.getState();
const progress = job.progress;

console.log(`Job state: ${state}`);
console.log(`Progress: ${JSON.stringify(progress)}`);
```

**Start Workers:**
```typescript
import { getDiscoveryWorkerManager } from '@cmdb/discovery-engine';
import { getDiscoveryScheduler } from '@cmdb/discovery-engine';

const workerManager = getDiscoveryWorkerManager();
await workerManager.start();

const scheduler = getDiscoveryScheduler();
await scheduler.start();

console.log('Discovery workers and schedulers started');
```

## Cron Patterns

Common cron patterns for scheduling:

```
*/5 * * * *     - Every 5 minutes
*/15 * * * *    - Every 15 minutes
*/30 * * * *    - Every 30 minutes
0 * * * *       - Every hour
0 */2 * * *     - Every 2 hours
0 0 * * *       - Daily at midnight
0 2 * * *       - Daily at 2 AM
0 0 * * 0       - Weekly (Sunday midnight)
0 0 1 * *       - Monthly (1st at midnight)
```

## Job States

- `waiting` - Job queued, waiting to be processed
- `active` - Job currently being processed
- `completed` - Job finished successfully
- `failed` - Job failed (may retry)
- `delayed` - Job delayed (scheduled for future)
- `paused` - Queue/job paused

## Error Categories

### Transient Errors
- Network timeouts
- Temporary service unavailability
- **Action**: Retry with exponential backoff

### Permanent Errors
- Validation failures
- Authentication errors
- Resource not found
- **Action**: No retry, notify admin

### Resource Errors
- Rate limit exceeded
- Quota exceeded
- **Action**: Retry with longer backoff

### System Errors
- Database connection failures
- Service down
- **Action**: Retry, notify admin

## Monitoring Queries

### PostgreSQL

**Job success rate:**
```sql
SELECT
  queue_name,
  COUNT(*) FILTER (WHERE status = 'completed') * 100.0 / COUNT(*) as success_rate
FROM job_results
WHERE completed_at >= NOW() - INTERVAL '24 hours'
GROUP BY queue_name;
```

**Job performance:**
```sql
SELECT
  queue_name,
  AVG(duration_ms) as avg_duration,
  MIN(duration_ms) as min_duration,
  MAX(duration_ms) as max_duration
FROM job_results
WHERE completed_at >= NOW() - INTERVAL '24 hours'
GROUP BY queue_name;
```

**Failed jobs:**
```sql
SELECT
  job_id, queue_name, error, completed_at
FROM job_results
WHERE status = 'failed'
ORDER BY completed_at DESC
LIMIT 50;
```

### Redis (via redis-cli)

**Check queue length:**
```bash
redis-cli llen bull:discovery:aws:wait
```

**List active jobs:**
```bash
redis-cli lrange bull:discovery:aws:active 0 -1
```

**Get job data:**
```bash
redis-cli hgetall bull:discovery:aws:12345
```

## Troubleshooting

### Workers not starting
```bash
# Check Redis connection
redis-cli ping

# Check logs
tail -f /var/log/cmdb/worker.log

# Verify worker status
cmdb worker status
```

### Jobs stuck in waiting
```bash
# Check worker status
cmdb worker status

# List your organization's waiting jobs in the queue
cmdb jobs list discovery-nmap -s waiting --token "$CMDB_ACCESS_TOKEN"
```

Queue statistics, pause and resume are global operations: `cmdb jobs stats` refuses (see
above), and `/api/v1/queues/*/stats`, `/pause` and `/resume` return **403**
`Global queue operations unavailable` for every caller (HP1-S6/P-6).

### High failure rate
```bash
# List your organization's failed jobs
cmdb jobs list discovery-nmap -s failed --token "$CMDB_ACCESS_TOKEN"

# The API's failed-jobs listing (bounded start/end, caller-owned jobs only)
curl -H "Authorization: Bearer $CMDB_ACCESS_TOKEN" \
  "http://localhost:3000/api/v1/jobs/discovery-nmap/failed?start=0&end=49"
```

Failed jobs are returned without raw failure reasons, stack traces, results or job data
(the web UI shows the fixed text `Job failed`); investigate failure causes in the worker
logs.

### Memory issues

Cleaning a queue (`POST /api/v1/jobs/:queueName/clean`) and queue-depth statistics are
global operations and return **403** `Global queue operations unavailable` for every caller
(HP1-S6/P-6). Adjust concurrency in the worker configuration.

## Best Practices

1. **Always use schedulers in production** to ensure consistent job execution
2. **Monitor queue depths** to detect processing bottlenecks
3. **Set appropriate timeouts** based on job complexity
4. **Use rate limiting** to avoid overwhelming external services
5. **Clean old jobs regularly** to prevent memory issues
6. **Track job metrics** for performance optimization
7. **Set up alerts** for high failure rates
8. **Use job priorities** for critical jobs
9. **Implement idempotent jobs** for safe retries
10. **Log comprehensive job metadata** for debugging

## See Also

- [CLI Commands Reference](/quick-reference/cli-commands)
- [Troubleshooting Guide](/operations/troubleshooting)
- [Operations Guide](/operations/daily-operations)
