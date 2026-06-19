# Pattern Learning

Pattern Learning is HappyCMDB's system for automatically learning from successful AI discoveries and compiling them into reusable, high-performance discovery patterns.

## Overview

Every time the AI Discovery engine successfully discovers infrastructure, it records the session including:
- What indicators were detected
- How the system was identified
- What configuration items were extracted
- Token usage and cost

The Pattern Learning system analyzes these sessions to identify common patterns and compiles them into executable code that can discover similar systems **10x faster** and at **zero LLM cost**.

## Benefits

- **Performance**: Compiled patterns execute 10x faster than AI discovery
- **Cost Savings**: Zero LLM cost for pattern-matched discoveries (80-95% reduction)
- **Reliability**: Patterns have predictable execution time and behavior
- **Offline Capable**: Patterns don't require internet connectivity
- **Version Control**: Patterns are versioned and can be rolled back

## How Pattern Learning Works

### 1. Session Recording

When AI Discovery runs, all details are stored:

```typescript
interface AIDiscoverySession {
  sessionId: string;
  discoveryDefinitionId: string;
  targetHost: string;
  targetPort: number;

  // What was discovered
  discoveredCIs: DiscoveredCI[];

  // How it was discovered
  llmPrompt: string;
  llmResponse: string;

  // Performance metrics
  tokensUsed: { input: number; output: number };
  cost: number;
  executionTimeMs: number;

  // Status
  status: 'completed' | 'failed' | 'timeout';
  errorMessage?: string;
}
```

### 2. Pattern Compilation

The Pattern Compiler analyzes successful sessions and generates patterns:

```typescript
// Analyze sessions for a specific target type
const candidates = await findCompilationCandidates({
  minSessions: 3,           // Require at least 3 successful discoveries
  minConfidence: 0.85,      // 85% success rate minimum
  targetType: 'web-server'  // Optional: filter by CI type
});

// Compile patterns
for (const candidate of candidates) {
  const pattern = await compilePattern(candidate);

  // Pattern includes:
  // - Detection logic (how to identify this type)
  // - Discovery logic (how to extract CIs)
  // - Test cases (validation scenarios)
  // - Metadata (confidence, usage count, etc.)

  await savePattern(pattern);
}
```

### 3. Pattern Structure

A compiled pattern consists of:

```typescript
interface DiscoveryPattern {
  patternId: string;              // Unique identifier
  name: string;                   // Human-readable name
  version: string;                // Semantic version
  category: string;               // e.g., 'web-server', 'database'

  // Detection Function (runs first)
  detectionCode: string;          // JavaScript function

  // Discovery Function (runs if detected)
  discoveryCode: string;          // JavaScript function

  // Metadata
  description: string;
  author: string;
  license: string;
  confidenceScore: number;        // 0.0 - 1.0

  // Performance Metrics
  usageCount: number;
  successCount: number;
  failureCount: number;
  avgExecutionTimeMs: number;

  // Learning History
  learnedFromSessions: string[];  // Session IDs used to compile
  aiModel: string;                // Model that generated original discoveries

  // Status
  status: 'draft' | 'review' | 'approved' | 'active' | 'deprecated';
  isActive: boolean;

  // Testing
  testCases: PatternTestCase[];

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  approvedAt?: Date;
  approvedBy?: string;
}
```

### 4. Pattern Execution

When a discovery request arrives:

```typescript
// 1. Scan the target
const scanResult = {
  openPorts: [80, 443, 22],
  services: ['nginx', 'sshd'],
  headers: { 'Server': 'nginx/1.18.0' }
};

// 2. Match against patterns
for (const pattern of activePatterns) {
  const match = pattern.detect(scanResult);

  if (match.matches && match.confidence >= 0.9) {
    // 3. Execute pattern
    const cis = await pattern.discover(context);
    return cis;
  }
}

// 4. Fallback to AI discovery if no match
return await aiDiscovery.discover(context);
```

## Pattern Lifecycle

### 1. Draft

Pattern is created but not yet validated.

**Actions:**
- Edit detection/discovery code
- Add test cases
- Run validation tests

### 2. Review

Pattern is submitted for approval.

**Submission:**
```bash
POST /api/v1/ai/patterns/{patternId}/submit
{
  "submittedBy": "discoveryteam@example.com",
  "notes": "Tested against 5 Nginx servers, 100% success rate"
}
```

### 3. Approved

Pattern passed review and validation.

**Approval:**
```bash
POST /api/v1/ai/patterns/{patternId}/approve
{
  "approvedBy": "admin@example.com",
  "notes": "Validated against production fleet"
}
```

**Auto-Approval** (if configured):
```bash
AI_PATTERN_AUTO_APPROVAL_ENABLED=true
AI_PATTERN_AUTO_APPROVAL_MIN_SESSIONS=5
AI_PATTERN_AUTO_APPROVAL_MIN_CONFIDENCE=0.9
```

Patterns meeting criteria are automatically approved.

### 4. Active

Pattern is being used for discoveries.

**Activation:**
```bash
POST /api/v1/ai/patterns/{patternId}/activate
{
  "activatedBy": "admin@example.com"
}
```

### 5. Deprecated

Pattern is outdated or superseded.

**Deprecation:**
```bash
POST /api/v1/ai/patterns/{patternId}/deactivate
{
  "deactivatedBy": "admin@example.com",
  "reason": "Replaced by pattern nginx-v2"
}
```

## Configuration

### Environment Variables

```bash
# Enable Pattern Learning
AI_PATTERN_LEARNING_ENABLED=true

# Compilation Thresholds
AI_PATTERN_MIN_SESSIONS=3                  # Minimum successful sessions
AI_PATTERN_MIN_CONFIDENCE=0.85             # Minimum success rate (85%)

# Auto-Approval
AI_PATTERN_AUTO_APPROVAL_ENABLED=true
AI_PATTERN_AUTO_APPROVAL_MIN_SESSIONS=5    # More sessions = higher confidence
AI_PATTERN_AUTO_APPROVAL_MIN_CONFIDENCE=0.9 # 90% success rate

# Pattern Matching
AI_PATTERN_CONFIDENCE_THRESHOLD=0.9        # Min confidence to use pattern
```

## Using the Pattern Library

### Web UI

Navigate to **AI Pattern Learning** page:

#### Pattern Library Tab

View and manage all patterns:

**Features:**
- **Search** - Filter by name, category, or description
- **Status Filter** - Show only Active, Approved, Review, or Draft patterns
- **Category Filter** - Filter by infrastructure type
- **Pagination** - Handle large pattern libraries (10/25/50/100 per page)
- **Real-time Updates** - WebSocket-based notifications

**Actions:**
- **View Details** - Click any pattern to see full details
- **Approve** - Approve patterns in Review status
- **Activate** - Activate approved patterns
- **Deactivate** - Deactivate active patterns
- **Delete** - Remove draft patterns

#### Discovery Sessions Tab

View AI discovery session history:

**Columns:**
- Session ID and timestamp
- Target (host:port)
- Status (completed, failed, timeout)
- CIs discovered count
- Tokens used and cost
- Pattern used (if any)

**Actions:**
- **View Details** - See full session information
- **Compile Pattern** - Create pattern from successful session
- **Re-run** - Retry failed sessions

#### Cost Analytics Tab

Monitor AI discovery spending:

**Metrics:**
- Current month cost and budget
- Cost per session (average, min, max)
- Monthly trend chart
- Cost breakdown by pattern vs. AI
- Savings from pattern matching

### API

#### List Patterns

```bash
GET /api/v1/ai/patterns?status=active&category=web-server
```

**Response:**
```json
[
  {
    "patternId": "nginx-web-server-v1",
    "name": "Nginx Web Server",
    "version": "1.0.0",
    "category": "web-server",
    "confidenceScore": 0.95,
    "usageCount": 234,
    "successCount": 223,
    "failureCount": 11,
    "avgExecutionTimeMs": 127,
    "status": "active",
    "isActive": true
  }
]
```

#### Get Pattern Details

```bash
GET /api/v1/ai/patterns/nginx-web-server-v1
```

**Response:**
```json
{
  "patternId": "nginx-web-server-v1",
  "name": "Nginx Web Server",
  "description": "Detects and discovers Nginx web servers",
  "detectionCode": "function detect(scanResult) { ... }",
  "discoveryCode": "function discover(context) { ... }",
  "learnedFromSessions": ["session-123", "session-456", "session-789"],
  "aiModel": "claude-sonnet-4-20250514",
  "testCases": [...],
  "createdAt": "2025-01-05T10:00:00Z",
  "approvedAt": "2025-01-05T14:30:00Z",
  "approvedBy": "admin@example.com"
}
```

#### Compile Patterns

```bash
POST /api/v1/ai/patterns/compile
{
  "minSessions": 3,
  "minConfidence": 0.85,
  "autoApprove": false
}
```

**Response:**
```json
{
  "compiled": 3,
  "patterns": [
    {
      "patternId": "postgresql-db-v1",
      "sessionCount": 5,
      "confidence": 0.92
    },
    {
      "patternId": "jenkins-cicd-v1",
      "sessionCount": 4,
      "confidence": 0.88
    },
    {
      "patternId": "redis-cache-v1",
      "sessionCount": 3,
      "confidence": 0.87
    }
  ]
}
```

## Pattern Development

### Writing Custom Patterns

You can create patterns manually for specific use cases:

#### Detection Function

```javascript
function detect(scanResult) {
  // Check if this looks like an Nginx server
  const hasNginxPort = scanResult.openPorts.includes(80) ||
                       scanResult.openPorts.includes(443);
  const hasNginxService = scanResult.services?.some(s =>
                          s.toLowerCase().includes('nginx'));
  const hasNginxHeader = scanResult.headers?.Server?.includes('nginx');

  // Calculate confidence
  let confidence = 0;
  if (hasNginxPort) confidence += 0.3;
  if (hasNginxService) confidence += 0.4;
  if (hasNginxHeader) confidence += 0.3;

  return {
    matches: confidence >= 0.6,
    confidence: confidence,
    indicators: [
      hasNginxPort && 'nginx-port',
      hasNginxService && 'nginx-service',
      hasNginxHeader && 'nginx-header'
    ].filter(Boolean)
  };
}
```

#### Discovery Function

```javascript
async function discover(context) {
  const { targetHost, targetPort, credentials } = context;

  // Connect to server (example using HTTP)
  const response = await fetch(`https://${targetHost}:${targetPort}`);
  const version = response.headers.get('Server');

  // Extract configuration
  return [{
    ci_type: 'web-server',
    ci_name: `nginx-${targetHost}`,
    ci_status: 'active',
    ci_environment: 'production',
    metadata: {
      technology: 'nginx',
      version: version,
      host: targetHost,
      port: targetPort,
      protocol: 'https'
    }
  }];
}
```

#### Test Cases

```javascript
const testCases = [
  {
    name: 'Nginx on port 80',
    scanResult: {
      openPorts: [80, 22],
      services: ['nginx', 'sshd'],
      headers: { 'Server': 'nginx/1.18.0' }
    },
    expectedMatch: true,
    expectedConfidence: 1.0
  },
  {
    name: 'Apache (should not match)',
    scanResult: {
      openPorts: [80, 22],
      services: ['httpd', 'sshd'],
      headers: { 'Server': 'Apache/2.4.41' }
    },
    expectedMatch: false
  }
];
```

### Pattern Testing

**Validate Pattern:**
```bash
POST /api/v1/ai/patterns/{patternId}/validate
```

**Response:**
```json
{
  "isValid": true,
  "errors": [],
  "warnings": [
    "Detection function timeout is not set"
  ],
  "testResults": {
    "passed": 8,
    "failed": 0,
    "total": 8
  }
}
```

## Best Practices

### 1. Start with Quality Sessions

Only compile patterns from high-quality AI sessions:
- ✅ Successfully discovered all CIs
- ✅ Accurate identification
- ✅ Complete configuration extraction
- ❌ Don't use failed or timeout sessions

### 2. Require Multiple Sessions

```bash
AI_PATTERN_MIN_SESSIONS=5  # More sessions = more reliable pattern
```

Higher session count = more confident the pattern is generalizable.

### 3. Use Conservative Confidence Thresholds

```bash
AI_PATTERN_CONFIDENCE_THRESHOLD=0.9  # Only use patterns with 90%+ match confidence
```

Prevents false positives that could waste resources.

### 4. Test Patterns Thoroughly

Add comprehensive test cases:
- Positive cases (should match)
- Negative cases (should not match)
- Edge cases (partial matches)
- Different versions/configurations

### 5. Version Patterns

When updating patterns:
- Increment version number
- Document changes
- Keep old version active until new version is validated
- Gradually migrate traffic

### 6. Monitor Pattern Performance

Review Pattern Library metrics regularly:
- **Success Rate**: Should be 90%+
- **Average Execution Time**: Should be <500ms
- **Usage Count**: Higher = more battle-tested

### 7. Deprecate Outdated Patterns

When technology changes:
- Create new pattern for updated version
- Mark old pattern as deprecated
- Monitor usage of deprecated pattern
- Deactivate after migration period

## Performance Metrics

### Pattern vs. AI Discovery

| Metric | AI Discovery | Pattern Match | Improvement |
|--------|-------------|--------------|-------------|
| Execution Time | 2-10 seconds | 50-200ms | **10-50x faster** |
| Cost | $0.10-$0.50 | $0.00 | **100% savings** |
| Network | Requires internet | Offline capable | N/A |
| Predictability | Variable | Consistent | **High** |
| Token Usage | 1000-5000 | 0 | **100% reduction** |

### Real-World Impact

**Scenario**: 1000 discoveries per month

**Without Patterns (100% AI):**
- Cost: $300/month
- Time: 5000 seconds (83 minutes)

**With Patterns (90% hit rate):**
- Pattern matches: 900 × $0.00 = $0
- AI fallback: 100 × $0.30 = $30
- **Total cost: $30/month** (90% savings)
- **Total time: 500 seconds** (8 minutes, 94% faster)

## Troubleshooting

### Pattern Not Compiling

**Symptoms**: Sessions completed but no patterns generated

**Solutions:**
1. Check minimum session threshold:
   ```bash
   AI_PATTERN_MIN_SESSIONS=3  # Reduce if needed
   ```

2. Check minimum confidence:
   ```bash
   AI_PATTERN_MIN_CONFIDENCE=0.80  # Lower threshold
   ```

3. Verify sessions are successful:
   ```bash
   GET /api/v1/ai/sessions?status=completed
   ```

### Pattern Not Matching

**Symptoms**: AI discovery used when pattern should match

**Solutions:**
1. Check pattern confidence threshold:
   ```bash
   AI_PATTERN_CONFIDENCE_THRESHOLD=0.85  # Lower threshold
   ```

2. View pattern detection logic:
   ```bash
   GET /api/v1/ai/patterns/{patternId}
   ```

3. Test pattern manually:
   ```bash
   POST /api/v1/ai/patterns/{patternId}/test
   {
     "scanResult": {...}
   }
   ```

### High Pattern Failure Rate

**Symptoms**: Pattern active but many failures

**Solutions:**
1. Review pattern test cases
2. Check if target infrastructure changed
3. Update pattern detection logic
4. Create new version of pattern
5. Consider deprecating pattern

### Real-time Updates Not Working

**Symptoms**: Pattern changes don't appear in UI

**Solutions:**
1. Check WebSocket connection:
   ```javascript
   // Browser console
   ws://localhost:3000/ws
   ```

2. Verify WebSocket service:
   ```bash
   docker logs cmdb-api-server | grep WebSocket
   ```

3. Clear browser cache and reload

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/ai/patterns` | GET | List patterns |
| `/api/v1/ai/patterns/:id` | GET | Get pattern details |
| `/api/v1/ai/patterns` | POST | Create pattern |
| `/api/v1/ai/patterns/:id` | PUT | Update pattern |
| `/api/v1/ai/patterns/:id` | DELETE | Delete pattern |
| `/api/v1/ai/patterns/:id/submit` | POST | Submit for review |
| `/api/v1/ai/patterns/:id/approve` | POST | Approve pattern |
| `/api/v1/ai/patterns/:id/reject` | POST | Reject pattern |
| `/api/v1/ai/patterns/:id/activate` | POST | Activate pattern |
| `/api/v1/ai/patterns/:id/deactivate` | POST | Deactivate pattern |
| `/api/v1/ai/patterns/:id/validate` | POST | Validate pattern |
| `/api/v1/ai/patterns/:id/test` | POST | Test pattern |
| `/api/v1/ai/patterns/compile` | POST | Compile new patterns |
| `/api/v1/ai/patterns/categories` | GET | List categories |

## Related Documentation

- [AI Discovery](/components/ai-discovery) - Overview of AI-powered discovery
- [Discovery Sessions](/operations/discovery-sessions) - Managing and monitoring sessions
- [Cost Analytics](/operations/cost-analytics) - Tracking and optimizing costs
- [WebSocket API](/api/websocket) - Real-time update protocol

## Next Steps

1. **Enable pattern learning**: `AI_PATTERN_LEARNING_ENABLED=true`
2. **Run AI discoveries**: Build session history
3. **Compile patterns**: Manually or automatically
4. **Review and approve**: Via Web UI or API
5. **Activate patterns**: Start using for production discoveries
6. **Monitor performance**: Track success rates and cost savings

---

**Need help?** See [Troubleshooting](/troubleshooting/pattern-learning) or [FAQ](/reference/faq#pattern-learning).
