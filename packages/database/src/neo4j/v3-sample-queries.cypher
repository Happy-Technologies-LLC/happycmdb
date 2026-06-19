// ============================================
// HappyCMDB v3.0 - Sample Cypher Queries
// ============================================
// This file contains sample queries demonstrating how to use the
// v3.0 unified data model with business entities.
//
// These queries showcase:
// - Traversing business-to-technical relationships
// - Impact analysis and blast radius calculations
// - Value stream mapping
// - Business service dependencies

// ============================================
// CREATING v3.0 ENTITIES
// ============================================

// Create a Business Service
CREATE (bs:BusinessService {
  id: 'bs-customer-onboarding',
  name: 'Customer Onboarding Service',
  description: 'End-to-end customer onboarding process',
  operational_status: 'active',
  itil_attributes: '{
    "service_owner": "Jane Smith",
    "service_manager": "John Doe",
    "criticality": "high",
    "sla_target": "99.9%"
  }',
  tbm_attributes: '{
    "annual_cost": 250000,
    "cost_center": "CC-1001",
    "business_unit": "Sales"
  }',
  bsm_attributes: '{
    "business_owner": "VP of Sales",
    "revenue_impact": "high",
    "customer_facing": true
  }',
  created_at: datetime(),
  updated_at: datetime()
});

// Create an Application Service
CREATE (as:ApplicationService {
  id: 'as-crm-system',
  name: 'CRM System',
  description: 'Salesforce CRM application',
  application_type: 'saas',
  tbm_attributes: '{
    "license_cost": 50000,
    "support_cost": 15000,
    "vendor": "Salesforce"
  }',
  itil_attributes: '{
    "technical_owner": "Engineering Team",
    "change_advisory_board": "CAB-001"
  }',
  quality_metrics: '{
    "availability": 99.95,
    "performance_score": 4.2,
    "incident_count_30d": 2
  }',
  created_at: datetime(),
  updated_at: datetime()
});

// Create a Business Capability
CREATE (bc:BusinessCapability {
  id: 'bc-lead-management',
  name: 'Lead Management',
  description: 'Ability to capture, qualify, and manage sales leads',
  capability_type: 'core',
  tbm_attributes: '{
    "investment_priority": "high",
    "maturity_level": 4
  }',
  value_attributes: '{
    "strategic_importance": "critical",
    "competitive_advantage": true
  }',
  created_at: datetime(),
  updated_at: datetime()
});

// Create a Value Stream
CREATE (vs:ValueStream {
  id: 'vs-customer-acquisition',
  name: 'Customer Acquisition',
  description: 'Journey from lead to paying customer',
  value_attributes: '{
    "customer_segment": "enterprise",
    "cycle_time_days": 45,
    "conversion_rate": 0.15
  }',
  created_at: datetime(),
  updated_at: datetime()
});

// ============================================
// CREATING v3.0 RELATIONSHIPS
// ============================================

// ApplicationService ENABLES BusinessService
MATCH (as:ApplicationService {id: 'as-crm-system'})
MATCH (bs:BusinessService {id: 'bs-customer-onboarding'})
CREATE (as)-[:ENABLES {
  created_at: datetime(),
  criticality: 'high',
  dependency_type: 'primary'
}]->(bs);

// BusinessService DELIVERS BusinessCapability
MATCH (bs:BusinessService {id: 'bs-customer-onboarding'})
MATCH (bc:BusinessCapability {id: 'bc-lead-management'})
CREATE (bs)-[:DELIVERS {
  created_at: datetime(),
  capability_level: 'full'
}]->(bc);

// BusinessCapability CONTRIBUTES_TO ValueStream
MATCH (bc:BusinessCapability {id: 'bc-lead-management'})
MATCH (vs:ValueStream {id: 'vs-customer-acquisition'})
CREATE (bc)-[:CONTRIBUTES_TO {
  created_at: datetime(),
  contribution_level: 'critical',
  sequence_order: 1
}]->(vs);

// ApplicationService RUNS_ON CI (existing CI from v2.0)
MATCH (as:ApplicationService {id: 'as-crm-system'})
MATCH (ci:CI:Server {id: 'srv-prod-api-01'})
CREATE (as)-[:RUNS_ON {
  created_at: datetime(),
  deployment_type: 'containerized'
}]->(ci);

// CI SUPPORTS BusinessService (direct infrastructure support)
MATCH (ci:CI:Database {id: 'db-postgres-datamart'})
MATCH (bs:BusinessService {id: 'bs-customer-onboarding'})
CREATE (ci)-[:SUPPORTS {
  created_at: datetime(),
  support_type: 'data-storage',
  criticality: 'high'
}]->(bs);

// ValueStream REQUIRES BusinessCapability
MATCH (vs:ValueStream {id: 'vs-customer-acquisition'})
MATCH (bc:BusinessCapability {id: 'bc-lead-management'})
CREATE (vs)-[:REQUIRES {
  created_at: datetime(),
  requirement_type: 'mandatory'
}]->(bc);

// ============================================
// QUERY 1: Find all CIs supporting a Business Service
// ============================================
// Use Case: Identify all infrastructure components that support a business service
// both directly (SUPPORTS) and indirectly (via ApplicationServices)

MATCH (bs:BusinessService {id: $serviceId})
OPTIONAL MATCH (bs)<-[:ENABLES]-(as:ApplicationService)-[:RUNS_ON]->(ci:CI)
OPTIONAL MATCH (bs)<-[:SUPPORTS]-(ci2:CI)
WITH bs, collect(DISTINCT ci) + collect(DISTINCT ci2) as all_cis
UNWIND all_cis as ci
RETURN DISTINCT
  ci.id as ci_id,
  ci.name as ci_name,
  ci.type as ci_type,
  ci.status as status,
  ci.environment as environment
ORDER BY ci.type, ci.name;

// Example execution:
// CALL {
//   MATCH (bs:BusinessService {name: 'Customer Onboarding Service'})
//   RETURN bs.id as serviceId
// }
// [then run the query above with $serviceId]

// ============================================
// QUERY 2: Calculate Blast Radius for CI Failure
// ============================================
// Use Case: Determine business impact if a CI fails
// Shows affected ApplicationServices, BusinessServices, and ultimately affected ValueStreams

MATCH (ci:CI {id: $ciId})
// Find dependent CIs (infrastructure dependencies)
OPTIONAL MATCH (ci)-[:HOSTS|DEPENDS_ON|CONNECTS_TO*1..3]->(dependent_ci:CI)
// Find ApplicationServices running on this CI or dependent CIs
OPTIONAL MATCH (as:ApplicationService)-[:RUNS_ON]->(affected_ci:CI)
WHERE affected_ci = ci OR affected_ci IN collect(dependent_ci)
// Find BusinessServices enabled by those ApplicationServices
OPTIONAL MATCH (as)-[:ENABLES]->(bs:BusinessService)
// Find BusinessCapabilities delivered by those BusinessServices
OPTIONAL MATCH (bs)-[:DELIVERS]->(bc:BusinessCapability)
// Find ValueStreams dependent on those BusinessCapabilities
OPTIONAL MATCH (bc)-[:CONTRIBUTES_TO]->(vs:ValueStream)
RETURN
  ci.name as failed_component,
  count(DISTINCT dependent_ci) as affected_ci_count,
  collect(DISTINCT as.name) as affected_applications,
  collect(DISTINCT bs.name) as affected_business_services,
  collect(DISTINCT bc.name) as affected_capabilities,
  collect(DISTINCT vs.name) as affected_value_streams;

// Example execution:
// MATCH (ci:CI {name: 'db-prod-01.happycmdb.local'})
// [use ci.id in the query above]

// ============================================
// QUERY 3: Value Stream to Infrastructure Mapping
// ============================================
// Use Case: Map a complete value stream down to supporting infrastructure
// Useful for cost allocation, planning, and impact analysis

MATCH (vs:ValueStream {id: $valueStreamId})
// Get required BusinessCapabilities
MATCH (vs)-[:REQUIRES]->(bc:BusinessCapability)
// Get BusinessServices delivering those capabilities
MATCH (bs:BusinessService)-[:DELIVERS]->(bc)
// Get ApplicationServices enabling those services
MATCH (as:ApplicationService)-[:ENABLES]->(bs)
// Get CIs running those applications
MATCH (as)-[:RUNS_ON]->(ci:CI)
RETURN
  vs.name as value_stream,
  bc.name as capability,
  bs.name as business_service,
  as.name as application_service,
  ci.name as infrastructure_component,
  ci.type as component_type,
  ci.environment as environment
ORDER BY bc.name, bs.name, as.name, ci.name;

// ============================================
// QUERY 4: Business Service Dependency Graph
// ============================================
// Use Case: Visualize complete dependency chain for a business service
// Shows ApplicationServices, CIs, and transitive CI dependencies

MATCH (bs:BusinessService {id: $serviceId})
// Get ApplicationServices enabling this business service
MATCH (bs)<-[:ENABLES]-(as:ApplicationService)
// Get CIs running those applications
MATCH (as)-[:RUNS_ON]->(ci:CI)
// Get transitive CI dependencies (databases, storage, network)
OPTIONAL MATCH (ci)-[:USES|DEPENDS_ON|CONNECTS_TO*1..2]->(dep_ci:CI)
RETURN
  bs.name as business_service,
  collect(DISTINCT {
    application: as.name,
    type: as.application_type,
    infrastructure: ci.name,
    dependencies: collect(DISTINCT dep_ci.name)
  }) as dependency_tree;

// ============================================
// QUERY 5: Find Business Services by Capability
// ============================================
// Use Case: Identify which business services deliver a specific capability

MATCH (bc:BusinessCapability {name: $capabilityName})
MATCH (bs:BusinessService)-[:DELIVERS]->(bc)
OPTIONAL MATCH (as:ApplicationService)-[:ENABLES]->(bs)
RETURN
  bc.name as capability,
  bs.name as business_service,
  bs.operational_status as status,
  collect(DISTINCT as.name) as supporting_applications
ORDER BY bs.name;

// ============================================
// QUERY 6: Cost Allocation by Value Stream
// ============================================
// Use Case: Calculate TBM costs allocated to a value stream
// Aggregates costs from BusinessServices and ApplicationServices

MATCH (vs:ValueStream {id: $valueStreamId})
MATCH (vs)-[:REQUIRES]->(bc:BusinessCapability)
MATCH (bs:BusinessService)-[:DELIVERS]->(bc)
MATCH (as:ApplicationService)-[:ENABLES]->(bs)
WITH vs, bs, as,
  toInteger(substring(bs.tbm_attributes,
    indexOf(bs.tbm_attributes, '"annual_cost":') + 14,
    indexOf(bs.tbm_attributes, ',', indexOf(bs.tbm_attributes, '"annual_cost":')) - indexOf(bs.tbm_attributes, '"annual_cost":') - 14
  )) as bs_cost,
  toInteger(substring(as.tbm_attributes,
    indexOf(as.tbm_attributes, '"license_cost":') + 15,
    indexOf(as.tbm_attributes, ',', indexOf(as.tbm_attributes, '"license_cost":')) - indexOf(as.tbm_attributes, '"license_cost":') - 15
  )) as as_cost
RETURN
  vs.name as value_stream,
  sum(bs_cost) as total_business_service_cost,
  sum(as_cost) as total_application_cost,
  sum(bs_cost) + sum(as_cost) as total_cost;

// Note: For production use, store costs as separate properties rather than parsing JSON

// ============================================
// QUERY 7: Application Health Impact on Business Services
// ============================================
// Use Case: Identify business services at risk due to poor application quality

MATCH (as:ApplicationService)
WHERE toFloat(substring(as.quality_metrics,
  indexOf(as.quality_metrics, '"availability":') + 15,
  5
)) < 99.5
MATCH (as)-[:ENABLES]->(bs:BusinessService)
RETURN
  as.name as application,
  as.quality_metrics as metrics,
  collect(bs.name) as at_risk_business_services
ORDER BY as.name;

// ============================================
// QUERY 8: Find Redundant Business Service Support
// ============================================
// Use Case: Identify if a business service has multiple ApplicationServices
// providing redundancy

MATCH (bs:BusinessService)
MATCH (as:ApplicationService)-[:ENABLES]->(bs)
WITH bs, count(as) as app_count, collect(as.name) as applications
WHERE app_count > 1
RETURN
  bs.name as business_service,
  app_count as redundant_apps,
  applications
ORDER BY app_count DESC;

// ============================================
// QUERY 9: CI Impact Score by Business Criticality
// ============================================
// Use Case: Prioritize CI maintenance based on business impact
// Higher score = more critical business services depend on this CI

MATCH (ci:CI)
OPTIONAL MATCH (as:ApplicationService)-[:RUNS_ON]->(ci)
OPTIONAL MATCH (as)-[:ENABLES]->(bs:BusinessService)
WITH ci, count(DISTINCT bs) as business_service_count,
  collect(DISTINCT bs.bsm_attributes) as bsm_attrs
RETURN
  ci.name as infrastructure,
  ci.type as type,
  business_service_count as impact_score,
  CASE
    WHEN business_service_count >= 5 THEN 'Critical'
    WHEN business_service_count >= 3 THEN 'High'
    WHEN business_service_count >= 1 THEN 'Medium'
    ELSE 'Low'
  END as priority
ORDER BY impact_score DESC
LIMIT 20;

// ============================================
// QUERY 10: Complete Business Context for a CI
// ============================================
// Use Case: Given a CI, show its complete business context
// Useful for change management and impact assessment

MATCH (ci:CI {id: $ciId})
// Find ApplicationServices running on this CI
OPTIONAL MATCH (as:ApplicationService)-[:RUNS_ON]->(ci)
// Find BusinessServices enabled by those applications
OPTIONAL MATCH (as)-[:ENABLES]->(bs:BusinessService)
// Find BusinessCapabilities delivered
OPTIONAL MATCH (bs)-[:DELIVERS]->(bc:BusinessCapability)
// Find ValueStreams impacted
OPTIONAL MATCH (bc)-[:CONTRIBUTES_TO]->(vs:ValueStream)
RETURN
  ci.name as infrastructure_component,
  ci.type as component_type,
  collect(DISTINCT {
    application: as.name,
    business_services: collect(DISTINCT bs.name),
    capabilities: collect(DISTINCT bc.name),
    value_streams: collect(DISTINCT vs.name)
  }) as business_context;

// ============================================
// VERIFICATION QUERIES
// ============================================

// Count all v3.0 entities
MATCH (bs:BusinessService) RETURN 'BusinessService' as entity_type, count(bs) as count
UNION
MATCH (as:ApplicationService) RETURN 'ApplicationService' as entity_type, count(as) as count
UNION
MATCH (bc:BusinessCapability) RETURN 'BusinessCapability' as entity_type, count(bc) as count
UNION
MATCH (vs:ValueStream) RETURN 'ValueStream' as entity_type, count(vs) as count;

// Count all v3.0 relationships
MATCH ()-[r:ENABLES]->() RETURN 'ENABLES' as rel_type, count(r) as count
UNION
MATCH ()-[r:DELIVERS]->() RETURN 'DELIVERS' as rel_type, count(r) as count
UNION
MATCH ()-[r:CONTRIBUTES_TO]->() RETURN 'CONTRIBUTES_TO' as rel_type, count(r) as count
UNION
MATCH ()-[r:RUNS_ON]->() RETURN 'RUNS_ON' as rel_type, count(r) as count
UNION
MATCH ()-[r:SUPPORTS]->() RETURN 'SUPPORTS' as rel_type, count(r) as count
UNION
MATCH ()-[r:REQUIRES]->() RETURN 'REQUIRES' as rel_type, count(r) as count;

// Verify schema constraints
SHOW CONSTRAINTS;

// Verify schema indexes
SHOW INDEXES;

// ============================================
// END OF SAMPLE QUERIES
// ============================================
