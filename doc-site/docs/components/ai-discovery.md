# AI-Powered Discovery

**AI Discovery** is HappyCMDB's intelligent infrastructure discovery system that uses Large Language Models (LLMs) to automatically discover, identify, and classify configuration items without predefined connectors.

## Overview

Traditional discovery requires writing custom connectors for each target system. AI Discovery eliminates this limitation by using LLMs to understand and extract infrastructure information on-the-fly. The system learns from successful discoveries and compiles them into reusable patterns for faster execution.

### Key Features

- **Multi-Provider LLM Support** - Works with Anthropic Claude, OpenAI, or custom/self-hosted models
- **Hybrid Discovery** - Combines pattern matching with AI fallback for optimal performance and cost
- **Pattern Learning** - Automatically compiles successful discoveries into reusable patterns
- **Cost Controls** - Monthly budgets and per-session limits prevent runaway costs
- **Real-time Updates** - WebSocket-based notifications for pattern updates and discoveries

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Discovery Request                          │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Hybrid Discovery Orchestrator                   │
│  ┌──────────────┐                  ┌──────────────┐         │
│  │Pattern       │  Match? ──Yes──▶ │Execute       │         │
│  │Matcher       │                  │Pattern       │         │
│  └──────────────┘                  └──────────────┘         │
│         │                                  │                 │
│         │ No match                         │                 │
│         ▼                                  │                 │
│  ┌──────────────┐                         │                 │
│  │LLM Discovery │                         │                 │
│  │Engine        │                         │                 │
│  └──────────────┘                         │                 │
│         │                                  │                 │
│         └──────────────┬───────────────────┘                 │
│                        │                                     │
└────────────────────────┼─────────────────────────────────────┘
                         │
                         ▼
           ┌─────────────────────────┐
           │Pattern Learning Pipeline│
           │(Compile new patterns)   │
           └─────────────────────────┘
```

## How It Works

### 1. Pattern Matching (Fast Path)

When a discovery request arrives, the system first checks if any compiled patterns match the target:

```typescript
// Scan target to collect indicators
const scanResult = {
  openPorts: [80, 443, 22],
  services: ['nginx', 'sshd'],
  headers: { 'Server': 'nginx/1.18.0' }
};

// Match against patterns
const match = await patternMatcher.match(scanResult);

if (match && match.confidence >= 0.9) {
  // Execute pre-compiled pattern (fast, no LLM cost)
  const cis = await patternMatcher.executePattern(match.patternId, context);
}
```

**Benefits:**
- ⚡ **10x faster** than AI discovery
- 💰 **Zero LLM cost** for matched targets
- 📈 **High confidence** (0.9+ typical)

### 2. AI Discovery (Fallback)

If no pattern matches (or confidence is low), the system falls back to AI discovery:

```typescript
// LLM-powered discovery
const result = await llmDiscoveryEngine.discover({
  targetHost: '10.0.1.50',
  targetPort: 443,
  scanResult: scanResult,
  credentials: sshCredentials
});

// Result includes discovered CIs and usage metadata
console.log(result.discoveredCIs);    // [{ ci_type: 'web-server', ... }]
console.log(result.cost);             // 0.0234 USD
console.log(result.tokensUsed);       // { input: 1243, output: 567 }
```

**Benefits:**
- 🤖 **Universal discovery** - Works with any infrastructure
- 🎯 **High accuracy** - Uses latest LLM reasoning capabilities
- 📊 **Contextual understanding** - Identifies relationships and dependencies

### 3. Pattern Learning

After successful AI discoveries, the system analyzes sessions to compile patterns:

```typescript
// Triggered manually or automatically
await patternCompiler.compilePatterns({
  minSessions: 3,              // Require 3+ successful discoveries
  minConfidence: 0.85,         // 85% success rate minimum
  autoApprove: true            // Auto-approve high-confidence patterns
});
```

Compiled patterns include:
- **Detection logic** - How to identify this target type
- **Discovery logic** - How to extract configuration items
- **Test cases** - Validation scenarios
- **Metadata** - Success rate, average execution time

## Configuration

### Environment Variables

Add these to your `.env` file:

```bash
# Enable AI Discovery
AI_DISCOVERY_ENABLED=true

# LLM Provider Configuration
AI_DISCOVERY_PROVIDER=anthropic        # anthropic | openai | custom
AI_DISCOVERY_MODEL=claude-sonnet-4-20250514

# Provider API Keys
ANTHROPIC_API_KEY=your-anthropic-api-key-here
OPENAI_API_KEY=your-openai-api-key-here

# Custom LLM Configuration (for vLLM, Ollama, LocalAI)
AI_DISCOVERY_BASE_URL=http://localhost:8000/v1
AI_DISCOVERY_CUSTOM_MODEL=llama-3-70b

# Cost Controls
AI_DISCOVERY_MONTHLY_BUDGET=100.00     # USD
AI_DISCOVERY_MAX_COST_PER_SESSION=0.50 # USD

# Pattern Learning
AI_PATTERN_LEARNING_ENABLED=true
AI_PATTERN_MIN_SESSIONS=3              # Min sessions before compiling
AI_PATTERN_AUTO_APPROVAL_ENABLED=true
AI_PATTERN_AUTO_APPROVAL_MIN_SESSIONS=5
AI_PATTERN_AUTO_APPROVAL_MIN_CONFIDENCE=0.9

# Hybrid Discovery
AI_HYBRID_DISCOVERY_ENABLED=true
AI_PATTERN_CONFIDENCE_THRESHOLD=0.9
AI_ENABLE_LEGACY_FALLBACK=true

# Security & Timeouts
AI_DISCOVERY_TIMEOUT_MS=30000          # 30 seconds
AI_DISCOVERY_MAX_RETRIES=2
```

### Supported LLM Providers

#### Anthropic Claude (Recommended)
- **Models**: `claude-sonnet-4-20250514`, `claude-3-5-sonnet-20241022`
- **Best for**: Complex infrastructure, relationship mapping
- **Cost**: ~$3/million tokens (input), ~$15/million tokens (output)

```bash
AI_DISCOVERY_PROVIDER=anthropic
AI_DISCOVERY_MODEL=claude-sonnet-4-20250514
ANTHROPIC_API_KEY=sk-ant-...
```

#### OpenAI
- **Models**: `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo`
- **Best for**: General-purpose discovery
- **Cost**: ~$10/million tokens (GPT-4)

```bash
AI_DISCOVERY_PROVIDER=openai
AI_DISCOVERY_MODEL=gpt-4-turbo
OPENAI_API_KEY=sk-...
```

#### Custom/Self-Hosted
- **Engines**: vLLM, Ollama, LocalAI, LM Studio
- **Models**: Llama 3, Mistral, Qwen, custom fine-tuned models
- **Best for**: Data privacy, cost control, custom domains

```bash
AI_DISCOVERY_PROVIDER=custom
AI_DISCOVERY_BASE_URL=http://localhost:8000/v1
AI_DISCOVERY_CUSTOM_MODEL=llama-3-70b
```

## Database Schema

AI Discovery requires these PostgreSQL tables:

```bash
# Deploy schema
./scripts/deploy-ai-discovery-db.sh
```

This creates:
- `ai_discovery_patterns` - Compiled patterns
- `ai_discovery_sessions` - Discovery session history
- `ai_pattern_usage` - Pattern execution metrics

## Usage

### 1. Create Discovery Definition

```bash
curl -X POST http://localhost:3000/api/v1/discovery/definitions \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Unknown Web Servers",
    "description": "Discover unknown web servers using AI",
    "discovery_method": "ai",
    "schedule": "0 2 * * *",
    "ai_provider": "anthropic",
    "ai_model": "claude-sonnet-4-20250514",
    "enable_pattern_matching": true,
    "config": {
      "targetHost": "10.0.1.50",
      "targetPort": 443
    }
  }'
```

**Discovery Methods:**
- `connector` - Use traditional connectors
- `ai` - Use AI discovery only
- `hybrid` - Try pattern matching first, fallback to AI (recommended)
- `agent` - Use discovery agents (NMAP, SSH, etc.)

### 2. Trigger Discovery

```bash
curl -X POST http://localhost:3000/api/v1/discovery/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "ai",
    "config": {
      "targetHost": "10.0.1.50",
      "targetPort": 443,
      "credentials": {...}
    }
  }'
```

### 3. View Results

**Via API:**
```bash
GET /api/v1/ai/sessions
GET /api/v1/ai/sessions/{sessionId}
GET /api/v1/ai/patterns
```

**Via Web UI:**
- Navigate to **AI Pattern Learning** page
- View **Discovery Sessions** tab for AI discovery history
- View **Pattern Library** tab for compiled patterns
- View **Cost Analytics** for budget tracking

## Pattern Management

### Pattern Lifecycle

1. **Draft** - Pattern created but not validated
2. **Review** - Submitted for approval
3. **Approved** - Validated and ready for use
4. **Active** - Currently being used for discovery
5. **Deprecated** - No longer recommended

### Pattern Operations

**Approve Pattern:**
```bash
POST /api/v1/ai/patterns/{patternId}/approve
{
  "approvedBy": "admin@example.com",
  "notes": "Validated against 10 web servers"
}
```

**Activate Pattern:**
```bash
POST /api/v1/ai/patterns/{patternId}/activate
{
  "activatedBy": "admin@example.com"
}
```

**Deactivate Pattern:**
```bash
POST /api/v1/ai/patterns/{patternId}/deactivate
{
  "deactivatedBy": "admin@example.com",
  "reason": "Better pattern available"
}
```

## Performance Optimizations

### Redis Caching
- **Pattern Cache** - 1-hour TTL for individual patterns
- **Pattern List Cache** - 10-minute TTL for active patterns
- **Match Result Cache** - 5-minute TTL for scan results

**Expected Performance:**
- Pattern loading: **10x faster**
- Pattern matching: **5x faster**
- Database queries: **10-50x faster** (with indexes)

### Database Indexes
Comprehensive indexes are automatically created:
- Partial indexes for active patterns
- Composite indexes for common queries
- Performance indexes for session and usage tracking

### Real-time Updates
WebSocket-based notifications for:
- Pattern updates
- Pattern approvals
- New patterns learned
- Discovery session completion
- Cost alerts

**Connection:**
```javascript
ws://localhost:3000/ws
```

## Cost Management

### Budget Controls

**Monthly Budget:**
```bash
AI_DISCOVERY_MONTHLY_BUDGET=100.00  # Alert when 80% reached
```

**Per-Session Limit:**
```bash
AI_DISCOVERY_MAX_COST_PER_SESSION=0.50  # Abort if exceeded
```

### Cost Tracking

**View Current Usage:**
```bash
GET /api/v1/ai/analytics/cost-summary
```

**Response:**
```json
{
  "currentMonth": {
    "totalCost": 42.35,
    "sessionCount": 127,
    "avgCostPerSession": 0.33
  },
  "budget": {
    "monthlyLimit": 100.00,
    "remaining": 57.65,
    "percentUsed": 42.35
  },
  "alerts": [
    {
      "type": "warning",
      "message": "80% of monthly budget reached"
    }
  ]
}
```

### Cost Optimization Tips

1. **Enable pattern matching** - Reduces AI calls by 80-95%
2. **Use cheaper models for simple tasks** - GPT-3.5 for basic discovery
3. **Batch discoveries** - Group similar targets together
4. **Set conservative budgets** - Start low and increase based on needs
5. **Monitor pattern hit rate** - High hit rate = low costs

## Industry Patterns

HappyCMDB ships with 9 pre-built industry patterns:

1. **Nginx Web Server** - Detects Nginx installations
2. **Apache Web Server** - Identifies Apache HTTP servers
3. **PostgreSQL Database** - Discovers PostgreSQL instances
4. **MySQL Database** - Identifies MySQL/MariaDB servers
5. **Redis Cache** - Detects Redis servers
6. **MongoDB Database** - Identifies MongoDB instances
7. **Docker Container Host** - Discovers Docker hosts
8. **Kubernetes Cluster** - Identifies K8s control planes
9. **Jenkins CI/CD** - Detects Jenkins servers

**Load patterns:**
```bash
./scripts/deploy-ai-discovery-db.sh  # Includes industry patterns
```

## Best Practices

### 1. Start with Hybrid Discovery
```bash
AI_HYBRID_DISCOVERY_ENABLED=true
```
This uses pattern matching when possible (fast, free) and falls back to AI when needed.

### 2. Set Conservative Budgets Initially
```bash
AI_DISCOVERY_MONTHLY_BUDGET=50.00
AI_DISCOVERY_MAX_COST_PER_SESSION=0.25
```
Monitor usage for a month, then adjust based on actual needs.

### 3. Enable Auto-Approval for High-Confidence Patterns
```bash
AI_PATTERN_AUTO_APPROVAL_ENABLED=true
AI_PATTERN_AUTO_APPROVAL_MIN_SESSIONS=5
AI_PATTERN_AUTO_APPROVAL_MIN_CONFIDENCE=0.9
```
Patterns with 90%+ success rate over 5+ sessions are automatically approved.

### 4. Use Appropriate Models
- **Complex infrastructure**: Claude Sonnet 4
- **General discovery**: GPT-4 Turbo
- **Simple/budget**: GPT-3.5 Turbo
- **Data privacy**: Self-hosted Llama 3 70B

### 5. Monitor Pattern Hit Rates
Check the Pattern Library dashboard regularly. Aim for:
- **80%+ pattern hit rate** - Good coverage
- **<20% AI fallback** - Cost-effective
- **90%+ pattern success rate** - High quality

## Troubleshooting

### Discovery Fails with "Budget Exceeded"

**Cause**: Monthly or per-session budget limit reached

**Solution:**
```bash
# Check current usage
GET /api/v1/ai/analytics/cost-summary

# Increase budget if justified
AI_DISCOVERY_MONTHLY_BUDGET=200.00
```

### Pattern Not Matching Expected Targets

**Cause**: Pattern detection logic too specific

**Solution:**
1. View pattern details in Pattern Library
2. Check detection code requirements
3. Edit pattern or create new variant
4. Submit for re-approval

### High AI Discovery Costs

**Cause**: Low pattern hit rate

**Solution:**
1. Enable pattern learning: `AI_PATTERN_LEARNING_ENABLED=true`
2. Lower confidence threshold: `AI_PATTERN_CONFIDENCE_THRESHOLD=0.85`
3. Compile patterns more frequently
4. Review and activate approved patterns

### WebSocket Not Connecting

**Cause**: WebSocket service not initialized

**Solution:**
```bash
# Check API server logs
docker logs cmdb-api-server | grep WebSocket

# Verify WebSocket endpoint
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  http://localhost:3000/ws
```

## API Reference

See [AI Pattern API Reference](/api/rest/ai-patterns) for complete endpoint documentation.

## Related Documentation

- [Pattern Learning Guide](/components/pattern-learning) - Deep dive into pattern compilation
- [Discovery Definitions](/components/discovery-definitions) - Configure discovery jobs
- [Cost Analytics](/operations/cost-analytics) - Monitor and optimize AI discovery costs
- [Environment Variables](/configuration/environment-variables) - Complete configuration reference

## Performance Metrics

**Typical Performance** (after pattern library is established):

| Metric | Pattern Match | AI Discovery |
|--------|--------------|--------------|
| Execution Time | 50-200ms | 2-10s |
| Cost | $0.00 | $0.10-$0.50 |
| Accuracy | 95%+ | 90-95% |
| Coverage | 80-90% | 100% |

**Combined (Hybrid Discovery):**
- **Average Cost**: $0.02-$0.10 per discovery
- **Average Time**: 200-500ms
- **Accuracy**: 93-97%
- **Coverage**: 100%

## Next Steps

1. **Deploy database schema**: `./scripts/deploy-ai-discovery-db.sh`
2. **Configure LLM provider**: Add API keys to `.env`
3. **Create discovery definition**: Use UI or API
4. **Run initial discoveries**: Build pattern library
5. **Enable auto-approval**: Let the system learn automatically
6. **Monitor costs**: Review analytics dashboard regularly

---

**Need help?** See [Troubleshooting](/troubleshooting/ai-discovery) or check the [FAQ](/reference/faq#ai-discovery).
