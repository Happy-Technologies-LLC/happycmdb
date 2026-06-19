// ============================================
// HappyCMDB v3.0 - Sample Data
// ============================================
// This file creates sample business entities to demonstrate the v3.0 unified data model.
// It builds upon the existing CI data from v2.0.
//
// Prerequisites: The init-neo4j.cypher script must be run first to create
// the base CI infrastructure data.

// ============================================
// BUSINESS SERVICES
// ============================================

MERGE (bs1:BusinessService {id: 'bs-ecommerce-platform'})
SET bs1.name = 'E-Commerce Platform',
    bs1.description = 'Complete online shopping and order management system',
    bs1.operational_status = 'active',
    bs1.itil_attributes = '{
      "service_owner": "Jane Smith",
      "service_manager": "John Doe",
      "criticality": "critical",
      "sla_target": "99.95%",
      "incident_priority": "P1",
      "change_category": "standard"
    }',
    bs1.tbm_attributes = '{
      "annual_cost": 1200000,
      "cost_center": "CC-2001",
      "business_unit": "Sales & Marketing",
      "budget_code": "OPEX-2024-ECOM"
    }',
    bs1.bsm_attributes = '{
      "business_owner": "VP of Sales",
      "revenue_impact": "critical",
      "customer_facing": true,
      "revenue_per_month": 5000000,
      "customer_count": 50000
    }',
    bs1.created_at = datetime(),
    bs1.updated_at = datetime();

MERGE (bs2:BusinessService {id: 'bs-customer-support'})
SET bs2.name = 'Customer Support Service',
    bs2.description = 'Multi-channel customer support and ticketing system',
    bs2.operational_status = 'active',
    bs2.itil_attributes = '{
      "service_owner": "Sarah Johnson",
      "service_manager": "Mike Wilson",
      "criticality": "high",
      "sla_target": "99.5%",
      "incident_priority": "P2",
      "change_category": "normal"
    }',
    bs2.tbm_attributes = '{
      "annual_cost": 450000,
      "cost_center": "CC-3001",
      "business_unit": "Customer Success",
      "budget_code": "OPEX-2024-SUPPORT"
    }',
    bs2.bsm_attributes = '{
      "business_owner": "VP of Customer Success",
      "revenue_impact": "medium",
      "customer_facing": true,
      "tickets_per_month": 2500,
      "avg_resolution_hours": 4
    }',
    bs2.created_at = datetime(),
    bs2.updated_at = datetime();

MERGE (bs3:BusinessService {id: 'bs-inventory-management'})
SET bs3.name = 'Inventory Management Service',
    bs3.description = 'Real-time inventory tracking and warehouse management',
    bs3.operational_status = 'active',
    bs3.itil_attributes = '{
      "service_owner": "Tom Brown",
      "service_manager": "Lisa Chen",
      "criticality": "high",
      "sla_target": "99.9%",
      "incident_priority": "P2"
    }',
    bs3.tbm_attributes = '{
      "annual_cost": 320000,
      "cost_center": "CC-4001",
      "business_unit": "Operations",
      "budget_code": "OPEX-2024-INV"
    }',
    bs3.bsm_attributes = '{
      "business_owner": "COO",
      "revenue_impact": "medium",
      "customer_facing": false,
      "sku_count": 15000,
      "warehouse_count": 8
    }',
    bs3.created_at = datetime(),
    bs3.updated_at = datetime();

MERGE (bs4:BusinessService {id: 'bs-payment-processing'})
SET bs4.name = 'Payment Processing Service',
    bs4.description = 'Secure payment gateway and fraud detection',
    bs4.operational_status = 'active',
    bs4.itil_attributes = '{
      "service_owner": "Emily Davis",
      "service_manager": "Robert Martinez",
      "criticality": "critical",
      "sla_target": "99.99%",
      "incident_priority": "P1",
      "compliance": "PCI-DSS"
    }',
    bs4.tbm_attributes = '{
      "annual_cost": 850000,
      "cost_center": "CC-2001",
      "business_unit": "Finance",
      "budget_code": "OPEX-2024-PAY"
    }',
    bs4.bsm_attributes = '{
      "business_owner": "CFO",
      "revenue_impact": "critical",
      "customer_facing": true,
      "transactions_per_month": 150000,
      "avg_transaction_value": 125
    }',
    bs4.created_at = datetime(),
    bs4.updated_at = datetime();

MERGE (bs5:BusinessService {id: 'bs-analytics-reporting'})
SET bs5.name = 'Business Analytics & Reporting',
    bs5.description = 'Enterprise-wide analytics and business intelligence',
    bs5.operational_status = 'active',
    bs5.itil_attributes = '{
      "service_owner": "David Lee",
      "service_manager": "Anna White",
      "criticality": "medium",
      "sla_target": "99.0%",
      "incident_priority": "P3"
    }',
    bs5.tbm_attributes = '{
      "annual_cost": 280000,
      "cost_center": "CC-5001",
      "business_unit": "Finance & Strategy",
      "budget_code": "OPEX-2024-BI"
    }',
    bs5.bsm_attributes = '{
      "business_owner": "CFO",
      "revenue_impact": "low",
      "customer_facing": false,
      "report_count": 150,
      "user_count": 300
    }',
    bs5.created_at = datetime(),
    bs5.updated_at = datetime();

// ============================================
// APPLICATION SERVICES
// ============================================

MERGE (as1:ApplicationService {id: 'as-web-frontend'})
SET as1.name = 'Web Frontend Application',
    as1.description = 'React-based customer-facing web application',
    as1.application_type = 'web',
    as1.tbm_attributes = '{
      "development_cost": 150000,
      "maintenance_cost": 45000,
      "hosting_cost": 12000,
      "vendor": "Internal Development"
    }',
    as1.itil_attributes = '{
      "technical_owner": "Frontend Engineering Team",
      "change_advisory_board": "CAB-DEV",
      "deployment_frequency": "weekly",
      "last_deployment": "2024-01-15"
    }',
    as1.quality_metrics = '{
      "availability": 99.92,
      "performance_score": 4.5,
      "incident_count_30d": 1,
      "mttr_hours": 2.5,
      "code_coverage": 85
    }',
    as1.created_at = datetime(),
    as1.updated_at = datetime();

MERGE (as2:ApplicationService {id: 'as-api-backend'})
SET as2.name = 'API Backend Service',
    as2.description = 'Node.js REST API and GraphQL backend',
    as2.application_type = 'api',
    as2.tbm_attributes = '{
      "development_cost": 200000,
      "maintenance_cost": 60000,
      "hosting_cost": 24000,
      "vendor": "Internal Development"
    }',
    as2.itil_attributes = '{
      "technical_owner": "Backend Engineering Team",
      "change_advisory_board": "CAB-DEV",
      "deployment_frequency": "bi-weekly",
      "last_deployment": "2024-01-20"
    }',
    as2.quality_metrics = '{
      "availability": 99.95,
      "performance_score": 4.7,
      "incident_count_30d": 0,
      "mttr_hours": 1.8,
      "code_coverage": 92
    }',
    as2.created_at = datetime(),
    as2.updated_at = datetime();

MERGE (as3:ApplicationService {id: 'as-payment-gateway'})
SET as3.name = 'Payment Gateway Integration',
    as3.description = 'Stripe payment processing integration',
    as3.application_type = 'saas',
    as3.tbm_attributes = '{
      "license_cost": 50000,
      "support_cost": 15000,
      "transaction_fees": 75000,
      "vendor": "Stripe"
    }',
    as3.itil_attributes = '{
      "technical_owner": "Payment Integration Team",
      "change_advisory_board": "CAB-PROD",
      "sla_provider": "Stripe",
      "contract_renewal": "2024-12-31"
    }',
    as3.quality_metrics = '{
      "availability": 99.99,
      "performance_score": 4.9,
      "incident_count_30d": 0,
      "mttr_hours": 0.5,
      "success_rate": 99.8
    }',
    as3.created_at = datetime(),
    as3.updated_at = datetime();

MERGE (as4:ApplicationService {id: 'as-crm-system'})
SET as4.name = 'Salesforce CRM',
    as4.description = 'Customer relationship management system',
    as4.application_type = 'saas',
    as4.tbm_attributes = '{
      "license_cost": 120000,
      "support_cost": 30000,
      "customization_cost": 25000,
      "vendor": "Salesforce"
    }',
    as4.itil_attributes = '{
      "technical_owner": "CRM Administration Team",
      "change_advisory_board": "CAB-BIZ",
      "user_count": 250,
      "contract_renewal": "2024-06-30"
    }',
    as4.quality_metrics = '{
      "availability": 99.95,
      "performance_score": 4.3,
      "incident_count_30d": 2,
      "mttr_hours": 3.0,
      "user_satisfaction": 4.1
    }',
    as4.created_at = datetime(),
    as4.updated_at = datetime();

MERGE (as5:ApplicationService {id: 'as-warehouse-management'})
SET as5.name = 'Warehouse Management System',
    as5.description = 'Custom-built WMS for inventory tracking',
    as5.application_type = 'custom',
    as5.tbm_attributes = '{
      "development_cost": 300000,
      "maintenance_cost": 80000,
      "hosting_cost": 18000,
      "vendor": "Internal Development"
    }',
    as5.itil_attributes = '{
      "technical_owner": "Operations Engineering Team",
      "change_advisory_board": "CAB-OPS",
      "deployment_frequency": "monthly",
      "last_deployment": "2024-01-10"
    }',
    as5.quality_metrics = '{
      "availability": 99.88,
      "performance_score": 4.2,
      "incident_count_30d": 3,
      "mttr_hours": 4.5,
      "code_coverage": 78
    }',
    as5.created_at = datetime(),
    as5.updated_at = datetime();

MERGE (as6:ApplicationService {id: 'as-analytics-platform'})
SET as6.name = 'Tableau Analytics Platform',
    as6.description = 'Business intelligence and data visualization',
    as6.application_type = 'saas',
    as6.tbm_attributes = '{
      "license_cost": 95000,
      "support_cost": 22000,
      "training_cost": 8000,
      "vendor": "Tableau/Salesforce"
    }',
    as6.itil_attributes = '{
      "technical_owner": "BI Team",
      "change_advisory_board": "CAB-BIZ",
      "user_count": 300,
      "contract_renewal": "2024-09-30"
    }',
    as6.quality_metrics = '{
      "availability": 99.90,
      "performance_score": 4.4,
      "incident_count_30d": 1,
      "mttr_hours": 2.0,
      "user_satisfaction": 4.6
    }',
    as6.created_at = datetime(),
    as6.updated_at = datetime();

// ============================================
// BUSINESS CAPABILITIES
// ============================================

MERGE (bc1:BusinessCapability {id: 'bc-order-fulfillment'})
SET bc1.name = 'Order Fulfillment',
    bc1.description = 'Process customer orders from placement to delivery',
    bc1.capability_type = 'core',
    bc1.tbm_attributes = '{
      "investment_priority": "high",
      "maturity_level": 4,
      "annual_investment": 500000
    }',
    bc1.value_attributes = '{
      "strategic_importance": "critical",
      "competitive_advantage": true,
      "customer_impact": "direct"
    }',
    bc1.created_at = datetime(),
    bc1.updated_at = datetime();

MERGE (bc2:BusinessCapability {id: 'bc-customer-engagement'})
SET bc2.name = 'Customer Engagement',
    bc2.description = 'Build and maintain customer relationships',
    bc2.capability_type = 'core',
    bc2.tbm_attributes = '{
      "investment_priority": "high",
      "maturity_level": 3,
      "annual_investment": 350000
    }',
    bc2.value_attributes = '{
      "strategic_importance": "critical",
      "competitive_advantage": true,
      "customer_impact": "direct"
    }',
    bc2.created_at = datetime(),
    bc2.updated_at = datetime();

MERGE (bc3:BusinessCapability {id: 'bc-payment-collection'})
SET bc3.name = 'Payment Collection',
    bc3.description = 'Securely collect and process customer payments',
    bc3.capability_type = 'core',
    bc3.tbm_attributes = '{
      "investment_priority": "critical",
      "maturity_level": 5,
      "annual_investment": 200000
    }',
    bc3.value_attributes = '{
      "strategic_importance": "critical",
      "competitive_advantage": false,
      "customer_impact": "direct",
      "regulatory_compliance": "PCI-DSS"
    }',
    bc3.created_at = datetime(),
    bc3.updated_at = datetime();

MERGE (bc4:BusinessCapability {id: 'bc-inventory-optimization'})
SET bc4.name = 'Inventory Optimization',
    bc4.description = 'Optimize inventory levels across all locations',
    bc4.capability_type = 'supporting',
    bc4.tbm_attributes = '{
      "investment_priority": "medium",
      "maturity_level": 3,
      "annual_investment": 180000
    }',
    bc4.value_attributes = '{
      "strategic_importance": "high",
      "competitive_advantage": true,
      "customer_impact": "indirect"
    }',
    bc4.created_at = datetime(),
    bc4.updated_at = datetime();

MERGE (bc5:BusinessCapability {id: 'bc-data-driven-insights'})
SET bc5.name = 'Data-Driven Business Insights',
    bc5.description = 'Analyze data to drive strategic decisions',
    bc5.capability_type = 'supporting',
    bc5.tbm_attributes = '{
      "investment_priority": "medium",
      "maturity_level": 3,
      "annual_investment": 150000
    }',
    bc5.value_attributes = '{
      "strategic_importance": "high",
      "competitive_advantage": true,
      "customer_impact": "indirect"
    }',
    bc5.created_at = datetime(),
    bc5.updated_at = datetime();

// ============================================
// VALUE STREAMS
// ============================================

MERGE (vs1:ValueStream {id: 'vs-order-to-cash'})
SET vs1.name = 'Order to Cash',
    vs1.description = 'Complete customer journey from browsing to payment receipt',
    vs1.value_attributes = '{
      "customer_segment": "B2C",
      "cycle_time_days": 3,
      "conversion_rate": 0.18,
      "revenue_per_order": 125,
      "orders_per_month": 45000
    }',
    vs1.created_at = datetime(),
    vs1.updated_at = datetime();

MERGE (vs2:ValueStream {id: 'vs-customer-support'})
SET vs2.name = 'Customer Issue Resolution',
    vs2.description = 'Journey from customer issue to successful resolution',
    vs2.value_attributes = '{
      "customer_segment": "All",
      "cycle_time_days": 0.5,
      "resolution_rate": 0.92,
      "customer_satisfaction": 4.3,
      "tickets_per_month": 2500
    }',
    vs2.created_at = datetime(),
    vs2.updated_at = datetime();

MERGE (vs3:ValueStream {id: 'vs-product-discovery'})
SET vs3.name = 'Product Discovery to Purchase',
    vs3.description = 'Customer journey from product discovery to purchase decision',
    vs3.value_attributes = '{
      "customer_segment": "B2C",
      "cycle_time_days": 7,
      "conversion_rate": 0.15,
      "avg_cart_value": 145,
      "visitors_per_month": 250000
    }',
    vs3.created_at = datetime(),
    vs3.updated_at = datetime();

// ============================================
// v3.0 RELATIONSHIPS
// ============================================

// ApplicationService -> BusinessService (ENABLES)
MATCH (as:ApplicationService {id: 'as-web-frontend'})
MATCH (bs:BusinessService {id: 'bs-ecommerce-platform'})
MERGE (as)-[:ENABLES {created_at: datetime(), criticality: 'critical', dependency_type: 'primary'}]->(bs);

MATCH (as:ApplicationService {id: 'as-api-backend'})
MATCH (bs:BusinessService {id: 'bs-ecommerce-platform'})
MERGE (as)-[:ENABLES {created_at: datetime(), criticality: 'critical', dependency_type: 'primary'}]->(bs);

MATCH (as:ApplicationService {id: 'as-payment-gateway'})
MATCH (bs:BusinessService {id: 'bs-payment-processing'})
MERGE (as)-[:ENABLES {created_at: datetime(), criticality: 'critical', dependency_type: 'primary'}]->(bs);

MATCH (as:ApplicationService {id: 'as-crm-system'})
MATCH (bs:BusinessService {id: 'bs-customer-support'})
MERGE (as)-[:ENABLES {created_at: datetime(), criticality: 'high', dependency_type: 'primary'}]->(bs);

MATCH (as:ApplicationService {id: 'as-warehouse-management'})
MATCH (bs:BusinessService {id: 'bs-inventory-management'})
MERGE (as)-[:ENABLES {created_at: datetime(), criticality: 'critical', dependency_type: 'primary'}]->(bs);

MATCH (as:ApplicationService {id: 'as-analytics-platform'})
MATCH (bs:BusinessService {id: 'bs-analytics-reporting'})
MERGE (as)-[:ENABLES {created_at: datetime(), criticality: 'medium', dependency_type: 'primary'}]->(bs);

// BusinessService -> BusinessCapability (DELIVERS)
MATCH (bs:BusinessService {id: 'bs-ecommerce-platform'})
MATCH (bc:BusinessCapability {id: 'bc-order-fulfillment'})
MERGE (bs)-[:DELIVERS {created_at: datetime(), capability_level: 'full'}]->(bc);

MATCH (bs:BusinessService {id: 'bs-payment-processing'})
MATCH (bc:BusinessCapability {id: 'bc-payment-collection'})
MERGE (bs)-[:DELIVERS {created_at: datetime(), capability_level: 'full'}]->(bc);

MATCH (bs:BusinessService {id: 'bs-customer-support'})
MATCH (bc:BusinessCapability {id: 'bc-customer-engagement'})
MERGE (bs)-[:DELIVERS {created_at: datetime(), capability_level: 'full'}]->(bc);

MATCH (bs:BusinessService {id: 'bs-inventory-management'})
MATCH (bc:BusinessCapability {id: 'bc-inventory-optimization'})
MERGE (bs)-[:DELIVERS {created_at: datetime(), capability_level: 'full'}]->(bc);

MATCH (bs:BusinessService {id: 'bs-analytics-reporting'})
MATCH (bc:BusinessCapability {id: 'bc-data-driven-insights'})
MERGE (bs)-[:DELIVERS {created_at: datetime(), capability_level: 'full'}]->(bc);

// BusinessCapability -> ValueStream (CONTRIBUTES_TO)
MATCH (bc:BusinessCapability {id: 'bc-order-fulfillment'})
MATCH (vs:ValueStream {id: 'vs-order-to-cash'})
MERGE (bc)-[:CONTRIBUTES_TO {created_at: datetime(), contribution_level: 'critical', sequence_order: 2}]->(vs);

MATCH (bc:BusinessCapability {id: 'bc-payment-collection'})
MATCH (vs:ValueStream {id: 'vs-order-to-cash'})
MERGE (bc)-[:CONTRIBUTES_TO {created_at: datetime(), contribution_level: 'critical', sequence_order: 3}]->(vs);

MATCH (bc:BusinessCapability {id: 'bc-customer-engagement'})
MATCH (vs:ValueStream {id: 'vs-customer-support'})
MERGE (bc)-[:CONTRIBUTES_TO {created_at: datetime(), contribution_level: 'critical', sequence_order: 1}]->(vs);

MATCH (bc:BusinessCapability {id: 'bc-order-fulfillment'})
MATCH (vs:ValueStream {id: 'vs-product-discovery'})
MERGE (bc)-[:CONTRIBUTES_TO {created_at: datetime(), contribution_level: 'high', sequence_order: 2}]->(vs);

// ValueStream -> BusinessCapability (REQUIRES)
MATCH (vs:ValueStream {id: 'vs-order-to-cash'})
MATCH (bc:BusinessCapability {id: 'bc-order-fulfillment'})
MERGE (vs)-[:REQUIRES {created_at: datetime(), requirement_type: 'mandatory'}]->(bc);

MATCH (vs:ValueStream {id: 'vs-order-to-cash'})
MATCH (bc:BusinessCapability {id: 'bc-payment-collection'})
MERGE (vs)-[:REQUIRES {created_at: datetime(), requirement_type: 'mandatory'}]->(bc);

MATCH (vs:ValueStream {id: 'vs-customer-support'})
MATCH (bc:BusinessCapability {id: 'bc-customer-engagement'})
MERGE (vs)-[:REQUIRES {created_at: datetime(), requirement_type: 'mandatory'}]->(bc);

// ApplicationService -> CI (RUNS_ON) - linking to existing v2.0 CIs
MATCH (as:ApplicationService {id: 'as-web-frontend'})
MATCH (ci:CI:Server {id: 'srv-prod-web-01'})
MERGE (as)-[:RUNS_ON {created_at: datetime(), deployment_type: 'containerized'}]->(ci);

MATCH (as:ApplicationService {id: 'as-api-backend'})
MATCH (ci:CI:Server {id: 'srv-prod-api-01'})
MERGE (as)-[:RUNS_ON {created_at: datetime(), deployment_type: 'containerized'}]->(ci);

MATCH (as:ApplicationService {id: 'as-warehouse-management'})
MATCH (ci:CI:Server {id: 'srv-prod-api-01'})
MERGE (as)-[:RUNS_ON {created_at: datetime(), deployment_type: 'containerized'}]->(ci);

// CI -> BusinessService (SUPPORTS) - direct infrastructure support
MATCH (ci:CI:Database {id: 'db-neo4j-prod'})
MATCH (bs:BusinessService {id: 'bs-ecommerce-platform'})
MERGE (ci)-[:SUPPORTS {created_at: datetime(), support_type: 'data-storage', criticality: 'critical'}]->(bs);

MATCH (ci:CI:Database {id: 'db-postgres-datamart'})
MATCH (bs:BusinessService {id: 'bs-analytics-reporting'})
MERGE (ci)-[:SUPPORTS {created_at: datetime(), support_type: 'data-storage', criticality: 'critical'}]->(bs);

MATCH (ci:CI:Database {id: 'db-redis-cache'})
MATCH (bs:BusinessService {id: 'bs-ecommerce-platform'})
MERGE (ci)-[:SUPPORTS {created_at: datetime(), support_type: 'caching', criticality: 'high'}]->(bs);

MATCH (ci:CI:NetworkDevice {id: 'net-lb-prod-01'})
MATCH (bs:BusinessService {id: 'bs-ecommerce-platform'})
MERGE (ci)-[:SUPPORTS {created_at: datetime(), support_type: 'load-balancing', criticality: 'critical'}]->(bs);

// ============================================
// VERIFICATION
// ============================================

// Show counts of all v3.0 entities
MATCH (bs:BusinessService) WITH count(bs) as bs_count
MATCH (as:ApplicationService) WITH bs_count, count(as) as as_count
MATCH (bc:BusinessCapability) WITH bs_count, as_count, count(bc) as bc_count
MATCH (vs:ValueStream) WITH bs_count, as_count, bc_count, count(vs) as vs_count
RETURN
  bs_count as BusinessServices,
  as_count as ApplicationServices,
  bc_count as BusinessCapabilities,
  vs_count as ValueStreams;

// Show counts of all v3.0 relationships
MATCH ()-[r:ENABLES]->() WITH count(r) as enables_count
MATCH ()-[r:DELIVERS]->() WITH enables_count, count(r) as delivers_count
MATCH ()-[r:CONTRIBUTES_TO]->() WITH enables_count, delivers_count, count(r) as contributes_count
MATCH ()-[r:RUNS_ON]->() WITH enables_count, delivers_count, contributes_count, count(r) as runs_on_count
MATCH ()-[r:SUPPORTS]->() WITH enables_count, delivers_count, contributes_count, runs_on_count, count(r) as supports_count
MATCH ()-[r:REQUIRES]->() WITH enables_count, delivers_count, contributes_count, runs_on_count, supports_count, count(r) as requires_count
RETURN
  enables_count as ENABLES,
  delivers_count as DELIVERS,
  contributes_count as CONTRIBUTES_TO,
  runs_on_count as RUNS_ON,
  supports_count as SUPPORTS,
  requires_count as REQUIRES;
