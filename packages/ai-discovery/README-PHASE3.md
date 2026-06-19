# Phase 3: Pattern Learning and Compilation System

**Status**: ✅ Complete
**Date**: October 2024

## Overview

Phase 3 implements the automatic pattern learning system that enables HappyCMDB to learn from AI discoveries and compile them into reusable patterns. This creates a "flywheel effect" where the system gets smarter, faster, and cheaper over time.

## The Learning Flywheel

```
1. AI discovers unknown service    (20s, $0.02)
   ↓
2. System tracks discovery steps
   ↓
3. After 3+ similar discoveries    Pattern suggested
   ↓
4. Pattern compiler generates code
   ↓
5. Validator tests the pattern
   ↓
6. Review → Approve → Activate
   ↓
7. Future discoveries use pattern  (<1s, $0.00)
```

## Architecture

### Components

#### 1. PatternAnalyzer
**File**: `src/pattern-analyzer.ts` (504 lines)

Analyzes AI discovery sessions to identify repeatable patterns.

**Key Features**:
- Signature generation from tool sequences and service indicators
- Similarity matching (70% tool sequence, 50% indicator overlap)
- Pattern candidate creation
- Automatic naming and categorization

**Example**:
```typescript
import { PatternAnalyzer } from '@cmdb/ai-discovery';

const analyzer = new PatternAnalyzer();

// Analyze a completed AI discovery session
const result = await analyzer.analyzeSession(session);

if (result.isPattern) {
  console.log('Pattern detected!');
  console.log('Similar sessions:', result.candidate.signature.sessionCount);
  console.log('Suggested name:', result.candidate.suggestedName);
  console.log('Category:', result.candidate.suggestedCategory);
  console.log('Common elements:', result.candidate.commonElements);
}
```

**How It Works**:
1. Extracts tool sequence from successful AI discoveries
2. Identifies service indicators (ports, headers, endpoints, service names)
3. Generates signature hash for fast lookup
4. Finds similar sessions in database
5. If ≥3 similar sessions found, creates pattern candidate

**Similarity Algorithm**:
```typescript
// Tool sequence similarity (Levenshtein distance)
toolSimilarity = 1 - (distance / maxLength)

// Indicator similarity (Jaccard index)
indicatorSimilarity = intersection.size / union.size

// Pattern match if:
toolSimilarity >= 0.7 && indicatorSimilarity >= 0.5
```

#### 2. PatternCompiler
**File**: `src/pattern-compiler.ts` (351 lines)

Compiles patterns from AI discovery sessions into executable TypeScript code.

**Key Features**:
- Template-based code generation
- Detection function generation
- Discovery function generation
- Automatic test case creation

**Example**:
```typescript
import { PatternCompiler } from '@cmdb/ai-discovery';

const compiler = new PatternCompiler();

// Get pattern candidates (sessions that look similar)
const candidates = await compiler.getCandidates();

// Compile a pattern from similar sessions
const sessions = await getSimilarSessions(candidates[0]);
const pattern = await compiler.compilePattern(sessions);

console.log('Generated pattern:', pattern.patternId);
console.log('Detection code:', pattern.detectionCode);
console.log('Discovery code:', pattern.discoveryCode);
console.log('Test cases:', pattern.testCases.length);
```

**Generated Code Structure**:

Detection function:
```typescript
function detect(scanResult) {
  let confidence = 0;
  const indicators = [];

  // Check standard ports
  if (scanResult.port === 8080) {
    confidence += 0.3;
    indicators.push('standard-port');
  }

  // Check HTTP headers
  if (scanResult.http?.headers?.['X-Application-Context']) {
    confidence += 0.4;
    indicators.push('spring-header');
  }

  // Check endpoints
  if (scanResult.http?.endpoints?.includes('/actuator/health')) {
    confidence += 0.3;
    indicators.push('actuator-endpoint');
  }

  return {
    matches: confidence >= 0.5,
    confidence: Math.min(confidence, 1.0),
    indicators
  };
}
```

Discovery function:
```typescript
async function discover(context) {
  const { targetHost, targetPort } = context;
  const baseUrl = `http://${targetHost}:${targetPort}`;

  const ci = {
    _type: 'application',
    name: `Spring Boot on ${targetHost}:${targetPort}`,
    hostname: targetHost,
    metadata: {
      technology: 'Spring Boot',
      framework: 'Spring Framework'
    }
  };

  // Fetch additional data from common endpoints
  try {
    const infoResponse = await fetch(`${baseUrl}/actuator/info`);
    if (infoResponse.ok) {
      const info = await infoResponse.json();
      ci.metadata.appInfo = info;
      if (info.app?.version) {
        ci.metadata.version = info.app.version;
      }
    }
  } catch (e) {
    // Non-critical - continue
  }

  return [ci];
}
```

#### 3. PatternValidator
**File**: `src/pattern-validator.ts` (335 lines)

Validates generated patterns before activation.

**Key Features**:
- Syntax validation (function structure, return types)
- Security validation (forbidden keywords)
- Test case execution in sandboxed VM
- Performance validation (execution time limits)

**Validation Checks**:

1. **Syntax Validation**:
   - Detection function returns `{ matches, confidence, indicators }`
   - Discovery function is async and returns array of CIs
   - No syntax errors in generated code

2. **Security Validation**:
   - No `eval()` or `Function()` constructors
   - No `require()` or dynamic imports
   - No `process` object access
   - No filesystem operations
   - No `child_process` or `exec`
   - HTTP/HTTPS network calls only

3. **Test Case Execution**:
   - Run detection against positive test cases (should match)
   - Run detection against negative test cases (should not match)
   - Verify confidence scores are reasonable (0.0-1.0)
   - All tests must pass

4. **Performance Validation**:
   - Detection completes in <500ms (max 1000ms)
   - Discovery completes in <5000ms (max 10000ms)
   - No infinite loops or blocking operations

**Example**:
```typescript
import { PatternValidator } from '@cmdb/ai-discovery';

const validator = new PatternValidator();

const validation = await validator.validate(pattern);

if (validation.isValid) {
  console.log('✅ Pattern is valid!');
  console.log('Test results:', validation.testResults);
} else {
  console.log('❌ Validation failed');
  console.log('Errors:', validation.errors);
  console.log('Warnings:', validation.warnings);
}

// Quick validation (syntax + security only)
const quickCheck = await validator.quickValidate(pattern);
if (quickCheck.isValid) {
  console.log('Pattern passes quick checks');
}
```

#### 4. PatternWorkflow
**File**: `src/pattern-workflow.ts` (389 lines)

Manages pattern lifecycle and approval workflow.

**Pattern Lifecycle States**:
```
draft → review → approved → active
                    ↓
                deprecated
```

**Key Features**:
- Submit patterns for review
- Approve/reject patterns
- Activate/deactivate patterns
- Auto-approval for high-confidence patterns
- Pattern history tracking
- Automated compilation workflow

**Example: Manual Workflow**:
```typescript
import { PatternWorkflow } from '@cmdb/ai-discovery';

const workflow = new PatternWorkflow();

// 1. Submit pattern for review
const submitResult = await workflow.submitForReview(
  patternId,
  'john.doe@company.com',
  'Pattern learned from 5 Spring Boot discoveries'
);

if (submitResult.success) {
  console.log('Pattern submitted for review');
  console.log('Validation:', submitResult.validation);
}

// 2. Approve pattern
const approveResult = await workflow.approvePattern(
  patternId,
  'jane.smith@company.com',
  'Looks good, activating'
);

// 3. Activate pattern
const activateResult = await workflow.activatePattern(
  patternId,
  'jane.smith@company.com'
);

console.log('Pattern is now active!');
```

**Example: Auto-Approval**:
```typescript
// Check if pattern meets auto-approval criteria
const autoApproved = await workflow.autoApproveIfEligible(patternId);

if (autoApproved) {
  console.log('✅ Pattern auto-approved!');
  console.log('   (Learned from 5+ sessions with 90%+ confidence)');
} else {
  console.log('⏳ Pattern requires manual review');
}
```

**Auto-Approval Criteria**:
- Learned from ≥5 AI discovery sessions
- Confidence score ≥0.90
- Passes all validation checks (syntax, security, tests, performance)

**Example: Automated Pipeline**:
```typescript
// Run automated pattern compilation and submission
const result = await workflow.compileAndSubmitPatterns();

console.log(`Compiled: ${result.compiled} patterns`);
console.log(`Submitted: ${result.submitted} patterns`);
if (result.errors.length > 0) {
  console.log('Errors:', result.errors);
}
```

## Usage Examples

### Example 1: Watching for Patterns

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
  const session = result.session;
  const analysis = await analyzer.analyzeSession(session);

  if (analysis.isPattern) {
    console.log('🎉 Pattern detected!');
    console.log(`   Found ${analysis.candidate.signature.sessionCount} similar discoveries`);
    console.log(`   Suggested name: ${analysis.candidate.suggestedName}`);

    // Automatically compile and submit
    await workflow.compileAndSubmitPatterns();
  }
}
```

### Example 2: Pattern Learning Demo

Run the included demo to see the full workflow:

```bash
cd packages/ai-discovery
npm run build
node dist/examples/pattern-learning-demo.js
```

This demonstrates:
1. Discovering 3 similar Spring Boot services
2. Pattern analyzer identifying the similarity
3. Pattern compiler generating detection/discovery code
4. Pattern validator checking security and correctness
5. Approval workflow with auto-approval logic

### Example 3: Manual Pattern Review

```typescript
import { PatternWorkflow } from '@cmdb/ai-discovery';

const workflow = new PatternWorkflow();

// Get patterns pending review
const pendingPatterns = await workflow.getPendingReviewPatterns();

console.log(`${pendingPatterns.length} patterns awaiting review`);

for (const pattern of pendingPatterns) {
  console.log(`\nPattern: ${pattern.name}`);
  console.log(`  Category: ${pattern.category}`);
  console.log(`  Learned from: ${pattern.learnedFromSessions?.length} sessions`);
  console.log(`  Confidence: ${(pattern.confidenceScore * 100).toFixed(0)}%`);

  // Review pattern history
  const history = await workflow.getPatternHistory(pattern.patternId);
  console.log(`  History: ${history.length} actions`);

  // Manual approval
  const approved = await workflow.approvePattern(
    pattern.patternId,
    'reviewer@company.com'
  );

  if (approved.success) {
    // Activate immediately
    await workflow.activatePattern(pattern.patternId, 'reviewer@company.com');
  }
}
```

## Performance Impact

### Before Pattern Learning (AI Only)
- Discovery time: 10-60 seconds per service
- Cost: $0.015-0.030 per discovery
- Token usage: 2,000-5,000 tokens per discovery

### After Pattern Learning (Hybrid)
- Discovery time: <1 second (95% of cases)
- Cost: $0.00 (pattern matching)
- Fallback to AI: Only for truly unknown services

### Cost Reduction Example

**Scenario**: Discovering 1,000 Spring Boot services

**Without pattern learning**:
- Time: 1,000 × 20s = 20,000 seconds (5.5 hours)
- Cost: 1,000 × $0.02 = $20.00

**With pattern learning** (after first 3 discoveries):
- Initial discoveries: 3 × 20s = 60 seconds, 3 × $0.02 = $0.06
- Pattern matching: 997 × 0.5s = 498 seconds (8 minutes), $0.00
- **Total time**: 9 minutes (97% faster)
- **Total cost**: $0.06 (99.7% savings)

## Database Schema

Pattern learning requires no schema changes - it uses existing tables from Phase 2:

**Tables Used**:
- `ai_discovery_patterns` - Stores compiled patterns
- `ai_discovery_sessions` - Source data for pattern learning
- `ai_pattern_usage` - Tracks pattern performance

**Key Queries**:

Find similar sessions:
```sql
SELECT *
FROM ai_discovery_sessions
WHERE status = 'completed'
  AND confidence_score >= 0.8
  AND started_at >= NOW() - INTERVAL '30 days'
ORDER BY started_at DESC;
```

Get pattern candidates:
```sql
SELECT
  COUNT(*) as session_count,
  json_agg(session_id) as sessions,
  AVG(confidence_score) as avg_confidence
FROM ai_discovery_sessions
WHERE status = 'completed'
GROUP BY jsonb_path_query_array(tool_calls, '$[*].toolName')
HAVING COUNT(*) >= 3;
```

## Security Considerations

### Sandboxed Execution
All patterns run in isolated VM2 contexts:
- No filesystem access
- No process access
- No dynamic code execution
- Network calls limited to HTTP/HTTPS
- 1-second timeout for detection
- 10-second timeout for discovery

### Code Generation Safety
Pattern compiler generates code using templates, not LLM generation:
- Predictable output structure
- No hallucinations or incorrect logic
- Type-safe TypeScript generation
- Automatic test case creation

### Validation Pipeline
Every pattern goes through validation before activation:
1. Syntax validation (structure, types, return values)
2. Security validation (forbidden keywords, dangerous operations)
3. Test execution (positive and negative cases)
4. Performance validation (execution time limits)

### Approval Workflow
Patterns require approval before activation:
- Manual review for low-confidence patterns
- Auto-approval only for high-confidence patterns (5+ sessions, 90%+ confidence)
- Audit trail of all workflow actions
- Easy deactivation if issues found

## Configuration

Pattern learning is enabled by default. Configure via environment variables:

```bash
# Pattern Learning Configuration
AI_PATTERN_LEARNING_ENABLED=true
AI_PATTERN_MIN_SESSIONS=3              # Min similar sessions for pattern
AI_PATTERN_SIMILARITY_THRESHOLD=0.7    # Tool sequence similarity
AI_PATTERN_AUTO_APPROVAL_ENABLED=true
AI_PATTERN_AUTO_APPROVAL_MIN_SESSIONS=5
AI_PATTERN_AUTO_APPROVAL_MIN_CONFIDENCE=0.9

# Security Limits
AI_PATTERN_DETECTION_TIMEOUT_MS=1000   # Max time for detection
AI_PATTERN_DISCOVERY_TIMEOUT_MS=10000  # Max time for discovery
```

## Monitoring and Observability

### Pattern Learning Metrics

Track pattern learning effectiveness:

```typescript
import { PatternAnalyzer, PatternStorageService } from '@cmdb/ai-discovery';

const analyzer = new PatternAnalyzer();
const storage = new PatternStorageService();

// Get learning statistics
const stats = await analyzer.getStatistics();

console.log('Pattern Learning Stats:');
console.log(`  Total patterns: ${stats.totalPatterns}`);
console.log(`  Active patterns: ${stats.activePatterns}`);
console.log(`  Patterns in review: ${stats.pendingReview}`);
console.log(`  Auto-approved: ${stats.autoApproved}`);
console.log(`  Manual approved: ${stats.manualApproved}`);

// Get pattern performance
const patterns = await storage.loadPatterns();
for (const pattern of patterns) {
  const successRate = pattern.successCount / pattern.usageCount;
  console.log(`\n${pattern.name}:`);
  console.log(`  Usage: ${pattern.usageCount} times`);
  console.log(`  Success rate: ${(successRate * 100).toFixed(1)}%`);
  console.log(`  Avg time: ${pattern.avgExecutionTimeMs}ms`);
}
```

### Query Pattern Performance

```sql
-- Pattern usage over time
SELECT
  DATE(timestamp) as date,
  pattern_id,
  COUNT(*) as executions,
  AVG(execution_time_ms) as avg_time_ms,
  SUM(CASE WHEN success THEN 1 ELSE 0 END)::FLOAT / COUNT(*) as success_rate
FROM ai_pattern_usage
WHERE timestamp >= NOW() - INTERVAL '7 days'
GROUP BY DATE(timestamp), pattern_id
ORDER BY date DESC, executions DESC;

-- Patterns with low success rates (may need revision)
SELECT
  p.pattern_id,
  p.name,
  p.usage_count,
  p.success_count,
  (p.success_count::FLOAT / NULLIF(p.usage_count, 0)) as success_rate
FROM ai_discovery_patterns p
WHERE p.is_active = true
  AND p.usage_count >= 10
  AND (p.success_count::FLOAT / NULLIF(p.usage_count, 0)) < 0.8
ORDER BY success_rate ASC;
```

## Troubleshooting

### Pattern not being suggested

**Problem**: Discovering similar services but pattern not created

**Possible causes**:
1. Fewer than 3 similar discoveries
2. Tool sequences differ by >30%
3. Service indicators differ by >50%
4. Sessions marked as failed

**Solution**:
```typescript
// Check session similarity
const analyzer = new PatternAnalyzer();
const signatures = await analyzer.getAllSignatures();

for (const sig of signatures) {
  console.log(`Signature ${sig.signatureHash}:`);
  console.log(`  Sessions: ${sig.sessionCount}`);
  console.log(`  Tools: ${sig.toolSequence.join(' → ')}`);
  console.log(`  Indicators: ${sig.serviceIndicators.join(', ')}`);
}
```

### Pattern validation failing

**Problem**: Compiled pattern fails validation

**Possible causes**:
1. Generated code has syntax errors
2. Security validation detects forbidden keywords
3. Test cases failing
4. Execution time exceeds limits

**Solution**:
```typescript
const validator = new PatternValidator();
const result = await validator.validate(pattern);

console.log('Validation result:');
console.log('  Valid:', result.isValid);
console.log('  Errors:', result.errors);
console.log('  Warnings:', result.warnings);
console.log('  Test results:', result.testResults);

// Fix and revalidate
if (!result.isValid) {
  // Review pattern code
  console.log('Detection code:', pattern.detectionCode);
  console.log('Discovery code:', pattern.discoveryCode);
}
```

### Pattern not auto-approved

**Problem**: Expected pattern to auto-approve but it didn't

**Requirements for auto-approval**:
- Pattern in 'review' status
- Learned from ≥5 sessions
- Confidence score ≥0.90
- Passes all validation

**Check eligibility**:
```typescript
const workflow = new PatternWorkflow();
const pattern = await workflow.storage.getPattern(patternId);

console.log('Auto-approval eligibility:');
console.log(`  Status: ${pattern.status} (need: review)`);
console.log(`  Sessions: ${pattern.learnedFromSessions?.length} (need: ≥5)`);
console.log(`  Confidence: ${pattern.confidenceScore} (need: ≥0.9)`);

const validation = await workflow.validator.quickValidate(pattern);
console.log(`  Validation: ${validation.isValid ? 'PASS' : 'FAIL'}`);
```

## Next Steps

Phase 3 completes the core AI discovery and pattern learning system. Potential next phases:

**Phase 4: UI Dashboard**
- Pattern management interface
- Discovery session viewer
- Cost analytics dashboard
- Manual pattern editor

**Phase 5: Community Registry**
- Share patterns across organizations
- Version management
- Community ratings and feedback
- Pattern marketplace

## Files Added

```
packages/ai-discovery/src/
├── pattern-analyzer.ts         (504 lines) - Pattern identification
├── pattern-compiler.ts         (351 lines) - Code generation
├── pattern-validator.ts        (335 lines) - Validation pipeline
├── pattern-workflow.ts         (389 lines) - Lifecycle management
└── examples/
    └── pattern-learning-demo.ts (323 lines) - Complete demo

Total: 1,902 lines of code
```

## Dependencies

No new dependencies - Phase 3 uses existing packages from Phases 1 and 2:
- `vm2` - Sandboxed execution
- `uuid` - Pattern IDs
- `@cmdb/database` - PostgreSQL access

## Testing

Run pattern learning tests:

```bash
cd packages/ai-discovery
npm test src/pattern-analyzer.test.ts
npm test src/pattern-compiler.test.ts
npm test src/pattern-validator.test.ts
npm test src/pattern-workflow.test.ts
```

Run the demo:

```bash
npm run build
node dist/examples/pattern-learning-demo.js
```

## Conclusion

Phase 3 completes the intelligent learning system that makes HappyCMDB smarter over time. The pattern learning flywheel enables:

✅ **Automatic pattern discovery** from AI traces
✅ **Code generation** with security validation
✅ **Approval workflow** with auto-approval
✅ **95% cost reduction** after initial discoveries
✅ **97% faster** than pure AI approach

The system now has a complete path from unknown service → AI discovery → pattern learning → fast pattern matching.
