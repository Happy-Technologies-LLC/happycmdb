-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- ============================================================================
-- Migration 031: business-service health counts only owned CIs
-- (HP1-S1, HAP-440; design v16 §2.7, "017", SEC9-02)
-- ============================================================================
--
-- v_business_service_health keeps 009's exact column list and order, so
-- cmdb.fn_business_service_health (010) keeps its row type. Only
-- supported_ci_count changes: a ci_business_service_mappings row counts only
-- when the mapped CI's current dim_ci version belongs to the service's own
-- organization and is not an 011 backfill. A mapping to another
-- organization's CI (or a legacy backfilled one) no longer inflates it.
-- 010's REVOKE SELECT ... FROM PUBLIC is re-asserted.
--
-- A later redefinition of this view (F2) must start from this text, not 009's.
-- Manual rollback: rollback/031_business_service_mapping_ownership.down.sql.

DO $hp1$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM set_config('statement_timeout', '10s', true);
  IF to_regclass('public.ci_criticality_scores') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'ci_criticality_scores'
                      AND column_name = 'organization_id') THEN
    RAISE EXCEPTION 'HP1 017 requires 014_drift_impact_org_provenance';
  END IF;
END
$hp1$;

-- V2 initdb does not ship 001's business-service tables or 009's view.
-- Record that branch as absent; never mask a name occupied by another kind.
DO $hp1$
BEGIN
  IF to_regclass('public.dim_business_services') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.dim_business_services') AND relkind IN ('r', 'p')) THEN
    RAISE EXCEPTION 'HP1 017 wrong object: dim_business_services must be a table';
  END IF;
  IF to_regclass('public.v_business_service_health') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.v_business_service_health') AND relkind = 'v') THEN
    RAISE EXCEPTION 'HP1 017 wrong object: v_business_service_health must be a view';
  END IF;
  IF to_regclass('public.dim_business_services') IS NULL
     OR to_regclass('public.v_business_service_health') IS NULL THEN
    IF to_regclass('public.dim_business_services') IS NOT NULL
       OR to_regclass('public.v_business_service_health') IS NOT NULL THEN
      RAISE EXCEPTION 'HP1 017 incomplete business-service schema';
    END IF;
    RAISE NOTICE 'HP1 017 business-service view absent on initdb; no view to replace';
    RETURN;
  END IF;
  EXECUTE $view$
CREATE OR REPLACE VIEW v_business_service_health AS
SELECT
    bs.organization_id,
    bs.service_id,
    bs.name,
    bs.service_classification,
    bs.tbm_tower,
    bs.business_criticality,
    bs.operational_status,
    ci.supported_ci_count,
    inc.incidents_last_30d,
    inc.sla_breaches_last_30d,
    inc.avg_mttr_minutes,
    chg.changes_last_30d,
    chg.failed_changes_last_30d,
    CASE
        WHEN inc.sla_breaches_last_30d = 0
         AND chg.failed_changes_last_30d = 0
         AND bs.operational_status = 'active'
        THEN 'healthy'
        WHEN inc.sla_breaches_last_30d > 5
          OR chg.failed_changes_last_30d > 3
        THEN 'critical'
        ELSE 'degraded'
    END as health_status
FROM dim_business_services bs
CROSS JOIN LATERAL (
    SELECT COUNT(DISTINCT csm.ci_id) as supported_ci_count
    FROM ci_business_service_mappings csm
    JOIN cmdb.dim_ci dc
      ON dc.ci_id = csm.ci_id
     AND dc.is_current
     AND NOT dc.org_backfilled
     AND dc.organization_id = bs.organization_id
    WHERE csm.service_id = bs.service_id
) ci
CROSS JOIN LATERAL (
    SELECT
        COALESCE(SUM(f.incident_count), 0)::INT as incidents_last_30d,
        COALESCE(SUM(f.sla_breaches), 0)::INT as sla_breaches_last_30d,
        (SUM(f.mttr_minutes * f.incident_count)
          / NULLIF(SUM(f.incident_count) FILTER (WHERE f.mttr_minutes IS NOT NULL), 0))::FLOAT as avg_mttr_minutes
    FROM fact_business_service_incidents f
    WHERE f.service_id = bs.service_id
      AND f.incident_date >= CURRENT_DATE - INTERVAL '30 days'
) inc
CROSS JOIN LATERAL (
    SELECT
        COALESCE(SUM(f.change_count), 0)::INT as changes_last_30d,
        COALESCE(SUM(f.failed_count), 0)::INT as failed_changes_last_30d
    FROM fact_business_service_changes f
    WHERE f.service_id = bs.service_id
      AND f.change_date >= CURRENT_DATE - INTERVAL '30 days'
) chg;
  $view$;
  REVOKE SELECT ON public.v_business_service_health FROM PUBLIC;
END
$hp1$;
