-- Persist architecture optimization analyses produced by ai-ml-engine.
CREATE TABLE IF NOT EXISTS architecture_analyses (
  id UUID PRIMARY KEY,
  business_service_id VARCHAR(255),
  analyzed_at TIMESTAMPTZ NOT NULL,
  overall_score INTEGER NOT NULL CHECK (overall_score >= 0 AND overall_score <= 100),
  architecture_pattern VARCHAR(100),
  health_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  dependency_graph_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_architecture_analyses_service
  ON architecture_analyses(business_service_id);
CREATE INDEX IF NOT EXISTS idx_architecture_analyses_analyzed_at
  ON architecture_analyses(analyzed_at DESC);
