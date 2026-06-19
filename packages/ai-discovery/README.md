# @cmdb/ai-discovery

AI-powered infrastructure discovery with support for multiple LLM providers.

## Features

✅ **Provider-Agnostic**: Works with Anthropic Claude, OpenAI, or any custom/private LLM
✅ **Tool Calling**: AI agents can use NMAP, HTTP probes, SSH commands to discover services
✅ **Pattern Learning**: Automatically learns patterns from AI discoveries for fast future lookups
✅ **Cost-Controlled**: Track and limit LLM API costs
✅ **TypeScript**: Fully typed for excellent IDE support

## Supported LLM Providers

### 1. Anthropic Claude
- Models: `claude-sonnet-4-20250514`, `claude-opus`, `claude-haiku`
- Best for: Accurate reasoning, tool calling
- Cost: ~$0.015-0.030 per discovery

### 2. OpenAI
- Models: `gpt-4-turbo-preview`, `gpt-4`, `gpt-3.5-turbo`
- Best for: Fast responses, good tool support
- Cost: ~$0.020-0.050 per discovery

### 3. Custom/Private LLMs
- Compatible with: vLLM, Ollama, LocalAI, Text Generation Inference
- Models: Llama-3, Mixtral, Mistral, Qwen, etc.
- Best for: Privacy, no API costs, air-gapped environments
- Cost: $0 (self-hosted)

## Installation

```bash
# Install dependencies
npm install

# Build the package
npm run build
```

## Database Setup

```bash
# Run the schema SQL file
psql -U cmdb_user -d cmdb -f packages/ai-discovery/schema.sql
```

This creates:
- `ai_discovery_patterns` - Stores learned/manual patterns
- `ai_discovery_sessions` - Tracks AI discovery operations
- `ai_pattern_usage` - Performance metrics

## Configuration

### Environment Variables

```bash
# LLM Provider Selection
AI_DISCOVERY_ENABLED=true
AI_DISCOVERY_PROVIDER=anthropic  # anthropic | openai | custom

# Provider-specific settings
ANTHROPIC_API_KEY=sk-ant-xxx
OPENAI_API_KEY=sk-xxx
AI_DISCOVERY_MODEL=claude-sonnet-4-20250514  # or gpt-4-turbo-preview

# For custom/private LLMs
AI_DISCOVERY_BASE_URL=http://localhost:8000/v1  # vLLM/Ollama endpoint
AI_DISCOVERY_API_KEY=optional-if-needed

# Discovery settings
AI_DISCOVERY_TEMPERATURE=0.1
AI_DISCOVERY_MAX_TOKENS=4096
AI_DISCOVERY_TIMEOUT_MS=60000

# Cost controls
AI_DISCOVERY_MAX_COST_PER_SESSION=0.50
AI_DISCOVERY_MONTHLY_BUDGET=100.00
```

## Usage Examples

### Example 1: Basic AI Discovery (Anthropic Claude)

```typescript
import { AIAgentCoordinator, getDefaultLLMConfig } from '@cmdb/ai-discovery';

// Create AI agent with default config (from environment)
const agent = new AIAgentCoordinator(getDefaultLLMConfig());

// Discover a service
const result = await agent.discover({
  targetHost: '10.0.1.50',
  targetPort: 8080,
  scanResult: {
    // Optional: Initial scan data from NMAP
    openPorts: [8080],
    services: [{ port: 8080, service: 'http', version: 'unknown' }]
  }
});

console.log('Discovered:', result.discoveredCIs);
console.log('Confidence:', result.confidence);
console.log('Cost:', result.cost);
console.log('AI Reasoning:', result.session.aiReasoning);
```

### Example 2: Using OpenAI

```typescript
import { AIAgentCoordinator, LLMProvider } from '@cmdb/ai-discovery';

const agent = new AIAgentCoordinator({
  provider: LLMProvider.OPENAI,
  model: 'gpt-4-turbo-preview',
  apiKey: process.env.OPENAI_API_KEY,
  temperature: 0.1,
  maxTokens: 4096
});

const result = await agent.discover({
  targetHost: 'api.example.com',
  targetPort: 443
});
```

### Example 3: Using Private/Self-Hosted LLM

```typescript
import { AIAgentCoordinator, LLMProvider } from '@cmdb/ai-discovery';

// Works with vLLM, Ollama, LocalAI, etc.
const agent = new AIAgentCoordinator({
  provider: LLMProvider.CUSTOM,
  model: 'llama-3-70b',  // Your model name
  baseURL: 'http://localhost:8000/v1',  // Your LLM endpoint
  apiKey: 'not-needed',  // Optional
  temperature: 0.1,
  maxTokens: 4096
});

const result = await agent.discover({
  targetHost: '192.168.1.100',
  targetPort: 3000
});

// No API costs for private models!
console.log('Cost:', result.cost);  // 0.0
```

### Example 4: With Credentials (SSH Discovery)

```typescript
import { AIAgentCoordinator, getDefaultLLMConfig } from '@cmdb/ai-discovery';

const agent = new AIAgentCoordinator(getDefaultLLMConfig());

const result = await agent.discover({
  targetHost: '10.0.1.50',
  targetPort: 22,
  credentials: {
    username: 'admin',
    password: 'secret',  // In production, load from credential service
  }
});

// AI can now use SSH tools to gather system info
```

### Example 5: Limited Tools (Read-only)

```typescript
import {
  AIAgentCoordinator,
  getDefaultLLMConfig,
  getBasicDiscoveryTools  // Only NMAP + HTTP, no SSH
} from '@cmdb/ai-discovery';

const agent = new AIAgentCoordinator(
  getDefaultLLMConfig(),
  getBasicDiscoveryTools()  // No SSH access
);

const result = await agent.discover({
  targetHost: 'public.example.com',
  targetPort: 443
});

// AI will only use safe, read-only tools
```

### Example 6: Test Connection

```typescript
import { testLLMConnection } from '@cmdb/ai-discovery';

// Test with default config
const connected = await testLLMConnection();
console.log('LLM connection:', connected ? 'OK' : 'FAILED');

// Test specific config
const customConnected = await testLLMConnection({
  provider: 'custom',
  baseURL: 'http://localhost:8000/v1',
  model: 'llama-3-70b'
});
```

## Discovery Tools

The AI has access to these tools:

### 1. `nmap_scan`
Scan network ports and detect services.

**Parameters:**
- `host` (string): Target hostname/IP
- `ports` (string): Port range (e.g., "80,443" or "1-1000")
- `scanType` (string): "quick" | "version" | "aggressive"

### 2. `http_probe`
Probe HTTP/HTTPS endpoints.

**Parameters:**
- `host` (string): Target hostname/IP
- `port` (number): Port (default: 80 or 443)
- `protocol` (string): "http" | "https"
- `path` (string): URL path (default: "/")
- `method` (string): "GET" | "HEAD" | "OPTIONS"

### 3. `ssh_execute`
Execute commands via SSH.

**Parameters:**
- `host` (string): Target hostname/IP
- `port` (number): SSH port (default: 22)
- `username` (string): SSH username
- `command` (string): Command to execute

### 4. `ssh_read_file`
Read file contents via SSH.

**Parameters:**
- `host` (string): Target hostname/IP
- `port` (number): SSH port
- `username` (string): SSH username
- `filePath` (string): File path to read
- `maxLines` (number): Max lines (default: 100)

## AI Discovery Flow

```
1. User initiates discovery
   ↓
2. AI analyzes target (host + port)
   ↓
3. AI decides which tools to use
   ↓
4. Tools execute (nmap, http_probe, ssh, etc.)
   ↓
5. AI analyzes tool results
   ↓
6. AI makes inference:
   - Service type
   - Technology & version
   - Dependencies
   - Confidence score
   ↓
7. Results returned to user
```

## Pattern Learning

The system automatically learns patterns from AI discoveries and compiles them into reusable code:

```typescript
import {
  HybridDiscoveryOrchestrator,
  PatternAnalyzer,
  PatternWorkflow
} from '@cmdb/ai-discovery';

const orchestrator = new HybridDiscoveryOrchestrator({
  aiEnabled: true,
  patternMatchingEnabled: true
});

const analyzer = new PatternAnalyzer();
const workflow = new PatternWorkflow();

// Perform discovery
const result = await orchestrator.discover({
  targetHost: '10.0.1.50',
  targetPort: 8080
});

// If AI was used, check if we found a pattern
if (result.method === 'ai') {
  const analysis = await analyzer.analyzeSession(result.session);

  if (analysis.isPattern) {
    console.log('🎉 Pattern detected!');
    console.log(`   Found ${analysis.candidate.signature.sessionCount} similar discoveries`);
    console.log(`   Suggested name: ${analysis.candidate.suggestedName}`);

    // Automatically compile and submit
    await workflow.compileAndSubmitPatterns();
  }
}
```

**The Learning Flywheel**:
1. AI discovers unknown service (20s, $0.02)
2. System tracks discovery steps
3. After 3+ similar discoveries → Pattern suggested
4. Pattern compiler generates detection/discovery code
5. Validator tests the pattern
6. Review → Approve → Activate
7. Future discoveries use pattern (<1s, $0.00)

**Performance Impact**:
- **First 3 discoveries**: 60 seconds, $0.06
- **Next 997 discoveries**: 8 minutes, $0.00
- **Savings**: 97% faster, 99.7% cost reduction

**See**: [Phase 3 Documentation](./README-PHASE3.md) for complete pattern learning guide

## Cost Management

Track and control LLM costs:

```typescript
const result = await agent.discover(context);

console.log(`
  Tokens used: ${result.session.totalTokens}
  - Prompt: ${result.session.promptTokens}
  - Completion: ${result.session.completionTokens}
  Cost: $${result.cost?.toFixed(4)}
`);

// Check monthly costs
// SELECT SUM(estimated_cost) FROM ai_discovery_sessions
// WHERE DATE(started_at) >= DATE_TRUNC('month', CURRENT_DATE);
```

## Private LLM Setup Examples

### vLLM (Recommended)

```bash
# Start vLLM server
python -m vllm.entrypoints.openai.api_server \
  --model meta-llama/Llama-3-70b-chat-hf \
  --host 0.0.0.0 \
  --port 8000 \
  --served-model-name llama-3-70b

# Configure HappyCMDB
AI_DISCOVERY_PROVIDER=custom
AI_DISCOVERY_BASE_URL=http://localhost:8000/v1
AI_DISCOVERY_MODEL=llama-3-70b
```

### Ollama

```bash
# Start Ollama
ollama serve

# Pull model
ollama pull llama3:70b

# Configure HappyCMDB
AI_DISCOVERY_PROVIDER=custom
AI_DISCOVERY_BASE_URL=http://localhost:11434/v1
AI_DISCOVERY_MODEL=llama3:70b
```

### LocalAI

```bash
# Start LocalAI
docker run -p 8080:8080 \
  -v $PWD/models:/models \
  localai/localai:latest

# Configure HappyCMDB
AI_DISCOVERY_PROVIDER=custom
AI_DISCOVERY_BASE_URL=http://localhost:8080/v1
AI_DISCOVERY_MODEL=your-model-name
```

## Security Considerations

### Credential Handling

**Never include credentials in AI prompts or logs!**

```typescript
// ✅ GOOD: Pass credentials separately
const result = await agent.discover({
  targetHost: 'server.local',
  targetPort: 22,
  credentials: await loadCredentialFromVault(credentialId)
});

// ❌ BAD: Don't include secrets in scan results
const result = await agent.discover({
  targetHost: 'server.local',
  targetPort: 22,
  scanResult: {
    password: 'secret123'  // Will be sent to LLM!
  }
});
```

### Tool Execution

- Tools run on the discovery server, not in the LLM
- AI only sees tool results, never executes code directly
- SSH commands are executed via your infrastructure
- Rate limiting and timeouts prevent abuse

### Private LLMs for Sensitive Environments

For maximum security, use self-hosted LLMs:
- Data never leaves your network
- No API keys or external dependencies
- Full control over model and infrastructure
- Compliance with data sovereignty requirements

## Troubleshooting

### "Connection refused" from LLM provider

```bash
# Test connection
node -e "require('@cmdb/ai-discovery').testLLMConnection().then(console.log)"

# Check environment variables
echo $AI_DISCOVERY_PROVIDER
echo $ANTHROPIC_API_KEY  # or OPENAI_API_KEY
echo $AI_DISCOVERY_BASE_URL  # for custom providers
```

### "Tool not found" errors

Make sure nmap is installed:
```bash
# Ubuntu/Debian
sudo apt-get install nmap

# macOS
brew install nmap

# Verify
nmap --version
```

### High costs

```bash
# Check spending
psql -d cmdb -c "
  SELECT
    DATE(started_at) as date,
    COUNT(*) as discoveries,
    SUM(estimated_cost) as total_cost
  FROM ai_discovery_sessions
  WHERE estimated_cost > 0
  GROUP BY DATE(started_at)
  ORDER BY date DESC
  LIMIT 7;
"

# Set budget limits in environment
AI_DISCOVERY_MAX_COST_PER_SESSION=0.50
AI_DISCOVERY_MONTHLY_BUDGET=100.00
```

## License

MIT - See main HappyCMDB LICENSE file
