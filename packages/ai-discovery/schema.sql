-- AI Discovery Schema
-- Database tables for AI-powered discovery, patterns, and sessions

-- Drop existing tables (if any)
DROP TABLE IF EXISTS ai_pattern_usage CASCADE;
DROP TABLE IF EXISTS ai_discovery_sessions CASCADE;
DROP TABLE IF EXISTS ai_discovery_patterns CASCADE;

-- ==================================================================
-- AI Discovery Patterns
-- Stores learned and manually created discovery patterns
-- ==================================================================

CREATE TABLE ai_discovery_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  version VARCHAR(50) NOT NULL,
  category VARCHAR(100) NOT NULL,

  -- Pattern code (TypeScript/JavaScript as text)
  detection_code TEXT NOT NULL,
  discovery_code TEXT NOT NULL,

  -- Metadata
  description TEXT,
  author VARCHAR(255) DEFAULT 'ai-compiler',
  license VARCHAR(50) DEFAULT 'MIT',

  -- Quality metrics
  confidence_score FLOAT DEFAULT 0.0 CHECK (confidence_score >= 0 AND confidence_score <= 1),
  usage_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  avg_execution_time_ms INTEGER,

  -- Learning provenance
  learned_from_sessions JSONB, -- Array of session IDs that led to this pattern
  ai_model VARCHAR(100), -- AI model used to learn this pattern

  -- Lifecycle
  status VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'approved', 'active', 'deprecated')),
  is_active BOOLEAN DEFAULT false,

  -- Community (if synced from registry)
  registry_url VARCHAR(500),
  community_upvotes INTEGER DEFAULT 0,
  community_downvotes INTEGER DEFAULT 0,

  -- Validation
  test_cases JSONB, -- Array of test cases

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  approved_at TIMESTAMP,
  approved_by VARCHAR(255),

  -- Constraints
  CONSTRAINT unique_pattern_version UNIQUE (pattern_id, version),
  CONSTRAINT valid_confidence CHECK (confidence_score >= 0 AND confidence_score <= 1),
  CONSTRAINT valid_counts CHECK (
    usage_count >= 0 AND
    success_count >= 0 AND
    failure_count >= 0
  )
);

-- Indexes for patterns
CREATE INDEX idx_patterns_category ON ai_discovery_patterns(category);
CREATE INDEX idx_patterns_status ON ai_discovery_patterns(status);
CREATE INDEX idx_patterns_active ON ai_discovery_patterns(is_active) WHERE is_active = true;
CREATE INDEX idx_patterns_usage ON ai_discovery_patterns(usage_count DESC);
CREATE INDEX idx_patterns_confidence ON ai_discovery_patterns(confidence_score DESC);
CREATE INDEX idx_patterns_created ON ai_discovery_patterns(created_at DESC);

-- ==================================================================
-- AI Discovery Sessions
-- Tracks individual AI discovery operations
-- ==================================================================

CREATE TABLE ai_discovery_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id VARCHAR(255) UNIQUE NOT NULL,

  -- Discovery context
  target_host VARCHAR(255) NOT NULL,
  target_port INTEGER NOT NULL,
  scan_result JSONB, -- Initial scan data (from NMAP, etc.)

  -- Execution
  status VARCHAR(50) NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  duration_ms INTEGER,

  -- AI details
  ai_model VARCHAR(100) NOT NULL,
  total_tokens INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  estimated_cost DECIMAL(10, 6), -- Cost in USD

  -- Results
  discovered_cis JSONB, -- Array of CI IDs or CI data
  confidence_score FLOAT CHECK (confidence_score >= 0 AND confidence_score <= 1),

  -- Trace (for pattern learning)
  tool_calls JSONB NOT NULL, -- Array of tool calls with input/output
  ai_reasoning TEXT, -- LLM's reasoning text
  pattern_matched VARCHAR(255), -- If a pattern was used

  -- Error handling
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Constraints
  CONSTRAINT valid_port CHECK (target_port > 0 AND target_port <= 65535),
  CONSTRAINT valid_confidence_session CHECK (
    confidence_score IS NULL OR
    (confidence_score >= 0 AND confidence_score <= 1)
  ),
  CONSTRAINT valid_duration CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

-- Indexes for sessions
CREATE INDEX idx_sessions_status ON ai_discovery_sessions(status);
CREATE INDEX idx_sessions_target ON ai_discovery_sessions(target_host, target_port);
CREATE INDEX idx_sessions_started ON ai_discovery_sessions(started_at DESC);
CREATE INDEX idx_sessions_model ON ai_discovery_sessions(ai_model);
CREATE INDEX idx_sessions_pattern ON ai_discovery_sessions(pattern_matched);
CREATE INDEX idx_sessions_confidence ON ai_discovery_sessions(confidence_score DESC) WHERE confidence_score IS NOT NULL;

-- ==================================================================
-- AI Pattern Usage
-- Tracks pattern execution and performance
-- ==================================================================

CREATE TABLE ai_pattern_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id VARCHAR(255) NOT NULL,
  session_id VARCHAR(255) NOT NULL,

  -- Execution details
  success BOOLEAN NOT NULL,
  execution_time_ms INTEGER NOT NULL CHECK (execution_time_ms >= 0),
  confidence_score FLOAT CHECK (confidence_score >= 0 AND confidence_score <= 1),

  -- Error details (if failed)
  error_message TEXT,
  error_type VARCHAR(100),

  -- Timestamp
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Foreign keys
  CONSTRAINT fk_pattern FOREIGN KEY (pattern_id)
    REFERENCES ai_discovery_patterns(pattern_id) ON DELETE CASCADE,
  CONSTRAINT fk_session FOREIGN KEY (session_id)
    REFERENCES ai_discovery_sessions(session_id) ON DELETE CASCADE
);

-- Indexes for usage
CREATE INDEX idx_usage_pattern ON ai_pattern_usage(pattern_id);
CREATE INDEX idx_usage_session ON ai_pattern_usage(session_id);
CREATE INDEX idx_usage_timestamp ON ai_pattern_usage(timestamp DESC);
CREATE INDEX idx_usage_success ON ai_pattern_usage(success);

-- ==================================================================
-- Helper Functions
-- ==================================================================

-- Function to update pattern usage stats
CREATE OR REPLACE FUNCTION update_pattern_stats()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE ai_discovery_patterns
  SET
    usage_count = usage_count + 1,
    success_count = success_count + CASE WHEN NEW.success THEN 1 ELSE 0 END,
    failure_count = failure_count + CASE WHEN NOT NEW.success THEN 1 ELSE 0 END,
    avg_execution_time_ms = (
      SELECT AVG(execution_time_ms)::INTEGER
      FROM ai_pattern_usage
      WHERE pattern_id = NEW.pattern_id
    ),
    updated_at = CURRENT_TIMESTAMP
  WHERE pattern_id = NEW.pattern_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update pattern stats
CREATE TRIGGER trigger_update_pattern_stats
AFTER INSERT ON ai_pattern_usage
FOR EACH ROW
EXECUTE FUNCTION update_pattern_stats();

-- Function to calculate pattern success rate
CREATE OR REPLACE FUNCTION get_pattern_success_rate(p_pattern_id VARCHAR)
RETURNS FLOAT AS $$
DECLARE
  total_count INTEGER;
  success_count INTEGER;
BEGIN
  SELECT COUNT(*), SUM(CASE WHEN success THEN 1 ELSE 0 END)
  INTO total_count, success_count
  FROM ai_pattern_usage
  WHERE pattern_id = p_pattern_id;

  IF total_count = 0 THEN
    RETURN 0.0;
  END IF;

  RETURN success_count::FLOAT / total_count::FLOAT;
END;
$$ LANGUAGE plpgsql;

-- ==================================================================
-- Views
-- ==================================================================

-- View: Pattern performance summary
CREATE OR REPLACE VIEW v_pattern_performance AS
SELECT
  p.pattern_id,
  p.name,
  p.version,
  p.category,
  p.status,
  p.is_active,
  p.usage_count,
  p.success_count,
  p.failure_count,
  CASE
    WHEN p.usage_count > 0 THEN (p.success_count::FLOAT / p.usage_count::FLOAT)
    ELSE 0.0
  END AS success_rate,
  p.avg_execution_time_ms,
  p.confidence_score,
  p.community_upvotes,
  p.community_downvotes,
  p.created_at,
  p.updated_at
FROM ai_discovery_patterns p
ORDER BY p.usage_count DESC, p.confidence_score DESC;

-- View: Recent discovery sessions
CREATE OR REPLACE VIEW v_recent_discoveries AS
SELECT
  s.session_id,
  s.target_host,
  s.target_port,
  s.status,
  s.ai_model,
  s.confidence_score,
  s.duration_ms,
  s.estimated_cost,
  s.pattern_matched,
  jsonb_array_length(COALESCE(s.tool_calls, '[]'::jsonb)) AS tool_calls_count,
  jsonb_array_length(COALESCE(s.discovered_cis, '[]'::jsonb)) AS discovered_cis_count,
  s.started_at,
  s.completed_at
FROM ai_discovery_sessions s
ORDER BY s.started_at DESC
LIMIT 100;

-- View: AI discovery cost summary
CREATE OR REPLACE VIEW v_discovery_costs AS
SELECT
  DATE(started_at) AS discovery_date,
  ai_model,
  COUNT(*) AS session_count,
  SUM(estimated_cost) AS total_cost,
  AVG(estimated_cost) AS avg_cost_per_session,
  SUM(total_tokens) AS total_tokens,
  COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed_count
FROM ai_discovery_sessions
WHERE estimated_cost IS NOT NULL
GROUP BY DATE(started_at), ai_model
ORDER BY discovery_date DESC, total_cost DESC;

-- ==================================================================
-- Initial Data
-- ==================================================================

-- Example pattern (Spring Boot Actuator - manually created)
INSERT INTO ai_discovery_patterns (
  pattern_id,
  name,
  version,
  category,
  detection_code,
  discovery_code,
  description,
  author,
  status,
  is_active,
  confidence_score
) VALUES (
  'spring-boot-actuator',
  'Spring Boot Actuator Detection',
  '1.0.0',
  'java-frameworks',
  '
function detect(scanResult) {
  let confidence = 0;
  const indicators = [];

  // Check HTTP headers
  if (scanResult.http?.headers?.["X-Application-Context"]) {
    confidence += 0.4;
    indicators.push("spring-header");
  }

  // Check for actuator endpoints
  const endpoints = scanResult.http?.endpoints || [];
  if (endpoints.includes("/actuator/health") || endpoints.includes("/actuator")) {
    confidence += 0.6;
    indicators.push("actuator-endpoint");
  }

  return {
    matches: confidence >= 0.5,
    confidence: Math.min(confidence, 1.0),
    indicators
  };
}
  ',
  '
async function discover(context) {
  const { targetHost, targetPort } = context;
  const baseUrl = `http://${targetHost}:${targetPort}`;

  const ci = {
    _type: "application",
    name: `Spring Boot App on ${targetHost}:${targetPort}`,
    hostname: targetHost,
    metadata: {
      technology: "Spring Boot",
      framework: "Spring Framework"
    }
  };

  // Try to get actuator info
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
    // Ignore errors
  }

  return [ci];
}
  ',
  'Detects Spring Boot applications via Actuator endpoints',
  'happycmdb-team',
  'active',
  true,
  0.95
);

-- Grant permissions (adjust as needed for your setup)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cmdb_user;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cmdb_user;
-- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO cmdb_user;

COMMENT ON TABLE ai_discovery_patterns IS 'Stores discovery patterns learned from AI or manually created';
COMMENT ON TABLE ai_discovery_sessions IS 'Tracks individual AI-powered discovery operations';
COMMENT ON TABLE ai_pattern_usage IS 'Records pattern execution for performance tracking';
