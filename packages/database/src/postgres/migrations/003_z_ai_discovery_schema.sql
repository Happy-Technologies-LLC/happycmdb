-- 003_z_ai_discovery_schema.sql
--
-- Canonical base schema for AI discovery. This migration must run before
-- 004_run_logs_and_pattern_review.sql, whose review-history table references
-- ai_discovery_patterns(pattern_id).

-- ==================================================================
-- AI Discovery Patterns
-- ==================================================================

CREATE TABLE IF NOT EXISTS ai_discovery_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  version VARCHAR(50) NOT NULL,
  category VARCHAR(100) NOT NULL,
  detection_code TEXT NOT NULL,
  discovery_code TEXT NOT NULL,
  description TEXT,
  author VARCHAR(255) DEFAULT 'ai-compiler',
  license VARCHAR(50) DEFAULT 'MIT',
  confidence_score FLOAT DEFAULT 0.0 CHECK (confidence_score >= 0 AND confidence_score <= 1),
  usage_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  avg_execution_time_ms INTEGER,
  learned_from_sessions JSONB,
  ai_model VARCHAR(100),
  status VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'approved', 'active', 'deprecated')),
  is_active BOOLEAN DEFAULT false,
  registry_url VARCHAR(500),
  community_upvotes INTEGER DEFAULT 0,
  community_downvotes INTEGER DEFAULT 0,
  test_cases JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  approved_at TIMESTAMP,
  approved_by VARCHAR(255),
  CONSTRAINT unique_pattern_version UNIQUE (pattern_id, version),
  CONSTRAINT valid_confidence CHECK (confidence_score >= 0 AND confidence_score <= 1),
  CONSTRAINT valid_counts CHECK (
    usage_count >= 0 AND
    success_count >= 0 AND
    failure_count >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_patterns_category ON ai_discovery_patterns(category);
CREATE INDEX IF NOT EXISTS idx_patterns_status ON ai_discovery_patterns(status);
CREATE INDEX IF NOT EXISTS idx_patterns_active ON ai_discovery_patterns(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_patterns_usage ON ai_discovery_patterns(usage_count DESC);
CREATE INDEX IF NOT EXISTS idx_patterns_confidence ON ai_discovery_patterns(confidence_score DESC);
CREATE INDEX IF NOT EXISTS idx_patterns_created ON ai_discovery_patterns(created_at DESC);

-- ==================================================================
-- AI Discovery Sessions
-- ==================================================================

CREATE TABLE IF NOT EXISTS ai_discovery_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id VARCHAR(255) UNIQUE NOT NULL,
  target_host VARCHAR(255) NOT NULL,
  target_port INTEGER NOT NULL,
  scan_result JSONB,
  status VARCHAR(50) NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  duration_ms INTEGER,
  ai_model VARCHAR(100) NOT NULL,
  total_tokens INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  estimated_cost DECIMAL(10, 6),
  discovered_cis JSONB,
  confidence_score FLOAT CHECK (confidence_score >= 0 AND confidence_score <= 1),
  tool_calls JSONB NOT NULL,
  ai_reasoning TEXT,
  pattern_matched VARCHAR(255),
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT valid_port CHECK (target_port > 0 AND target_port <= 65535),
  CONSTRAINT valid_confidence_session CHECK (
    confidence_score IS NULL OR
    (confidence_score >= 0 AND confidence_score <= 1)
  ),
  CONSTRAINT valid_duration CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON ai_discovery_sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_target ON ai_discovery_sessions(target_host, target_port);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON ai_discovery_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_model ON ai_discovery_sessions(ai_model);
CREATE INDEX IF NOT EXISTS idx_sessions_pattern ON ai_discovery_sessions(pattern_matched);
CREATE INDEX IF NOT EXISTS idx_sessions_confidence ON ai_discovery_sessions(confidence_score DESC) WHERE confidence_score IS NOT NULL;

-- ==================================================================
-- AI Pattern Usage
-- ==================================================================

CREATE TABLE IF NOT EXISTS ai_pattern_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id VARCHAR(255) NOT NULL,
  session_id VARCHAR(255) NOT NULL,
  success BOOLEAN NOT NULL,
  execution_time_ms INTEGER NOT NULL CHECK (execution_time_ms >= 0),
  confidence_score FLOAT CHECK (confidence_score >= 0 AND confidence_score <= 1),
  error_message TEXT,
  error_type VARCHAR(100),
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pattern FOREIGN KEY (pattern_id)
    REFERENCES ai_discovery_patterns(pattern_id) ON DELETE CASCADE,
  CONSTRAINT fk_session FOREIGN KEY (session_id)
    REFERENCES ai_discovery_sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_usage_pattern ON ai_pattern_usage(pattern_id);
CREATE INDEX IF NOT EXISTS idx_usage_session ON ai_pattern_usage(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON ai_pattern_usage(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_usage_success ON ai_pattern_usage(success);

-- ==================================================================
-- Helper functions and views
-- ==================================================================

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

DROP TRIGGER IF EXISTS trigger_update_pattern_stats ON ai_pattern_usage;
CREATE TRIGGER trigger_update_pattern_stats
AFTER INSERT ON ai_pattern_usage
FOR EACH ROW
EXECUTE FUNCTION update_pattern_stats();

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

COMMENT ON TABLE ai_discovery_patterns IS 'Stores discovery patterns learned from AI or manually created';
COMMENT ON TABLE ai_discovery_sessions IS 'Tracks individual AI-powered discovery operations';
COMMENT ON TABLE ai_pattern_usage IS 'Records pattern execution for performance tracking';
