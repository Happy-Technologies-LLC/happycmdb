import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'HappyCMDB',
  description: 'Open-source enterprise Configuration Management Database platform',

  // Base URL for deployment (adjust for production)
  base: '/',

  // Clean URLs (removes .html extension)
  cleanUrls: true,

  // Last updated timestamp
  lastUpdated: true,

  // Ignore dead links (some pages not yet created)
  ignoreDeadLinks: true,

  // Head tags for SEO and branding
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/favicon.png' }],
    ['meta', { name: 'theme-color', content: '#0ea5e9' }],
    ['meta', { name: 'og:type', content: 'website' }],
    ['meta', { name: 'og:locale', content: 'en' }],
    ['meta', { name: 'og:site_name', content: 'HappyCMDB Documentation' }],
    ['meta', { name: 'og:image', content: '/logos/og-image.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],

  // Theme configuration
  themeConfig: {
    // Site logo (using copied app logo)
    logo: '/logos/logo.svg',

    // Site title in nav
    siteTitle: 'HappyCMDB',

    // Navigation bar
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Getting Started', link: '/getting-started/overview' },
      { text: 'Architecture', link: '/architecture/system-overview' },
      { text: 'Deployment', link: '/deployment/kubernetes' },
      {
        text: 'Guides',
        items: [
          { text: 'AI Discovery', link: '/components/ai-discovery' },
          { text: 'Pattern Learning', link: '/components/pattern-learning' },
          { text: 'BullMQ Integration', link: '/components/bullmq' },
          { text: 'Event Streaming', link: '/components/event-streaming' },
          { text: 'Credentials Management', link: '/components/credentials' },
          { text: 'Discovery Agents', link: '/components/discovery-agents' },
          { text: 'Operations', link: '/operations/daily-operations' }
        ]
      },
      {
        text: 'User Guides',
        items: [
          { text: 'Executive Dashboard', link: '/user-guides/executive-dashboard' },
          { text: 'FinOps Dashboard', link: '/user-guides/finops-dashboard' },
          { text: 'ITSM Operations', link: '/user-guides/itsm-operations' },
          { text: 'Migrating to v3.0', link: '/getting-started/migrating-to-v3' }
        ]
      },
      {
        text: 'v3.0 Features',
        items: [
          { text: 'Unified Framework', link: '/components/unified-framework' },
          { text: 'BSM Impact Engine', link: '/components/bsm-impact-engine' },
          { text: 'TBM Cost Engine', link: '/components/tbm-cost-engine' },
          { text: 'ITIL Service Manager', link: '/components/itil-service-manager' },
          { text: 'AI/ML Engine', link: '/components/ai-ml-engine' },
          { text: 'Event Streaming', link: '/components/event-streaming' },
          { text: 'Metabase BI', link: '/components/metabase' },
          { text: 'Business Insights Dashboards', link: '/components/business-dashboards' }
        ]
      },
      {
        text: 'API Reference',
        items: [
          { text: 'API Overview', link: '/api/overview' },
          { text: 'Authentication API', link: '/api/authentication' },
          { text: 'Discovery API', link: '/api/rest/discovery' },
          { text: 'Unified Credentials API', link: '/api/rest/unified' },
          { text: 'Financial Management API', link: '/api/rest/financial' }
        ]
      }
    ],

    // Sidebar navigation
    sidebar: {
      // Getting Started section
      '/getting-started/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Overview', link: '/getting-started/overview' },
            { text: 'Quick Start', link: '/getting-started/quick-start' },
            { text: 'Installation', link: '/getting-started/installation' },
            { text: 'Project Structure', link: '/getting-started/project-structure' },
            { text: 'Key Concepts', link: '/getting-started/key-concepts' },
            { text: 'Discovery Guide', link: '/getting-started/discovery-guide' },
            { text: 'Migrating to v3.0', link: '/getting-started/migrating-to-v3' }
          ]
        }
      ],

      // Architecture section
      '/architecture/': [
        {
          text: 'Architecture',
          items: [
            { text: 'System Overview', link: '/architecture/system-overview' },
            { text: 'Connector Framework', link: '/architecture/connector-framework' },
            { text: 'Version History', link: '/architecture/version-history' },
            { text: 'Technology Stack', link: '/architecture/technology-stack' },
            { text: 'Data Flow', link: '/architecture/data-flow' },
            { text: 'Design Decisions', link: '/architecture/design-decisions' }
          ]
        },
        {
          text: 'Backend Architecture',
          items: [
            { text: 'Backend Overview', link: '/architecture/backend/overview' },
            { text: 'Microservices', link: '/architecture/backend/microservices' },
            { text: 'API Layer', link: '/architecture/backend/api-layer' },
            { text: 'Discovery Engine', link: '/architecture/backend/discovery-engine' },
            { text: 'ETL Processor', link: '/architecture/backend/etl-processor' }
          ]
        },
        {
          text: 'Frontend Architecture',
          items: [
            { text: 'Frontend Overview', link: '/architecture/frontend/overview' },
            { text: 'React Application', link: '/architecture/frontend/react-app' },
            { text: 'State Management', link: '/architecture/frontend/state-management' },
            { text: 'Component Library', link: '/architecture/frontend/components' }
          ]
        },
        {
          text: 'Database Architecture',
          items: [
            { text: 'Database Overview', link: '/architecture/database/overview' },
            { text: 'Neo4j Graph Database', link: '/architecture/database/neo4j' },
            { text: 'PostgreSQL Data Mart', link: '/architecture/database/postgresql' },
            { text: 'Redis Cache', link: '/architecture/database/redis' },
            { text: 'Schema Design', link: '/architecture/database/schema-design' }
          ]
        },
        {
          text: 'Job Scheduling',
          items: [
            { text: 'BullMQ Overview', link: '/architecture/scheduling/bullmq' },
            { text: 'Queue Management', link: '/architecture/scheduling/queues' },
            { text: 'Worker Patterns', link: '/architecture/scheduling/workers' }
          ]
        }
      ],

      // Component Guides section
      '/components/': [
        {
          text: 'Component Guides',
          items: [
            { text: 'Overview', link: '/components/overview' }
          ]
        },
        {
          text: 'Core Components',
          items: [
            { text: 'BullMQ Integration', link: '/components/bullmq' },
            { text: 'Event Streaming (Kafka)', link: '/components/event-streaming' },
            { text: 'Web UI', link: '/components/web-ui' },
            { text: 'Data Mart', link: '/components/data-mart' },
            { text: 'Authentication', link: '/components/authentication' },
            { text: 'Discovery Agents', link: '/components/discovery-agents' }
          ]
        },
        {
          text: 'Discovery & Integration',
          items: [
            { text: 'AI Discovery', link: '/components/ai-discovery' },
            { text: 'Pattern Learning', link: '/components/pattern-learning' },
            { text: 'Unified Credentials', link: '/components/credentials' },
            { text: 'Discovery Agents', link: '/components/discovery-agents' },
            { text: 'Discovery Definitions', link: '/components/discovery-definitions' },
            { text: 'Connector Registry', link: '/components/connector-registry' }
          ]
        },
        {
          text: 'Service Components',
          items: [
            { text: 'API Server', link: '/components/api-server' },
            { text: 'Discovery Engine', link: '/components/discovery-engine' },
            { text: 'ETL Processor', link: '/components/etl-processor' },
            { text: 'CLI Tools', link: '/components/cli' }
          ]
        },
        {
          text: 'v3.0 Features',
          items: [
            { text: 'Unified Framework Integration', link: '/components/unified-framework' },
            { text: 'BSM Impact Engine', link: '/components/bsm-impact-engine' },
            { text: 'TBM Cost Engine', link: '/components/tbm-cost-engine' },
            { text: 'ITIL Service Manager', link: '/components/itil-service-manager' },
            { text: 'AI/ML Engine', link: '/components/ai-ml-engine' },
            { text: 'Event Streaming', link: '/components/event-streaming' },
            { text: 'Metabase BI', link: '/components/metabase' },
            { text: 'Business Insights Dashboards', link: '/components/business-dashboards' }
          ]
        }
      ],

      // Deployment section
      '/deployment/': [
        {
          text: 'Deployment',
          items: [
            { text: 'Quick Start', link: '/deployment/quick-start' },
            { text: 'Prerequisites', link: '/deployment/prerequisites' },
            { text: 'Environment Setup', link: '/deployment/environment-setup' }
          ]
        },
        {
          text: 'Deployment Methods',
          items: [
            { text: 'Docker Compose', link: '/deployment/docker-compose' },
            { text: 'Kubernetes', link: '/deployment/kubernetes' },
            { text: 'Cloud Deployment', link: '/deployment/cloud' },
            { text: 'Bare Metal', link: '/deployment/bare-metal' }
          ]
        },
        {
          text: 'Production Deployment',
          collapsed: false,
          items: [
            { text: 'Production Configuration', link: '/deployment/PRODUCTION_CONFIGURATION' },
            { text: 'Production Deployment Checklist', link: '/deployment/PRODUCTION_DEPLOYMENT_CHECKLIST' }
          ]
        },
        {
          text: 'Verification',
          items: [
            { text: 'Health Checks', link: '/deployment/health-checks' },
            { text: 'Smoke Tests', link: '/deployment/smoke-tests' },
            { text: 'Troubleshooting Deploy', link: '/deployment/troubleshooting' }
          ]
        }
      ],

      // Operations section
      '/operations/': [
        {
          text: 'Operations',
          items: [
            { text: 'Daily Operations', link: '/operations/daily-operations' },
            { text: 'Backup & Restore', link: '/operations/backup-restore' },
            { text: 'Troubleshooting', link: '/operations/troubleshooting' },
            { text: 'Quick Reference Card', link: '/operations/QUICK_REFERENCE_CARD' }
          ]
        },
        {
          text: 'Monitoring & Alerting',
          collapsed: false,
          items: [
            { text: 'Monitoring Setup', link: '/operations/MONITORING_SETUP_SUMMARY' },
            { text: 'Monitoring Dashboards', link: '/operations/monitoring-dashboards' }
          ]
        },
        {
          text: 'Operational Runbooks',
          collapsed: false,
          items: [
            { text: 'API Server Down', link: '/operations/runbooks/api-server-down' },
            { text: 'Database Connection Issues', link: '/operations/runbooks/database-connection-issues' },
            { text: 'Discovery Jobs Failing', link: '/operations/runbooks/discovery-jobs-failing' },
            { text: 'High Memory Usage', link: '/operations/runbooks/high-memory-usage' },
            { text: 'Performance Degradation', link: '/operations/runbooks/performance-degradation' },
            { text: 'Rate Limiting Issues', link: '/operations/runbooks/rate-limiting-issues' },
            { text: 'SSL Certificate Renewal', link: '/operations/runbooks/ssl-certificate-renewal' },
            { text: 'Backup Failure', link: '/operations/runbooks/backup-failure' }
          ]
        },
        {
          text: 'Incident Response',
          collapsed: true,
          items: [
            { text: 'Incident Report Template', link: '/operations/incident-response/incident-report-template' },
            { text: 'Communication Templates', link: '/operations/incident-response/communication-templates' },
            { text: 'Escalation Matrix', link: '/operations/incident-response/escalation-matrix' }
          ]
        },
        {
          text: 'On-Call',
          collapsed: true,
          items: [
            { text: 'On-Call Guide', link: '/operations/on-call/on-call-guide' },
            { text: 'Handoff Checklist', link: '/operations/on-call/handoff-checklist' }
          ]
        },
        {
          text: 'Backup & Recovery',
          items: [
            { text: 'Backup Strategy', link: '/operations/backup/strategy' },
            { text: 'Backup Procedures', link: '/operations/backup/procedures' },
            { text: 'Restore Procedures', link: '/operations/backup/restore' },
            { text: 'Disaster Recovery', link: '/operations/backup/disaster-recovery' }
          ]
        },
        {
          text: 'Scaling',
          items: [
            { text: 'Scaling Overview', link: '/operations/scaling/overview' },
            { text: 'Horizontal Scaling', link: '/operations/scaling/horizontal' },
            { text: 'Vertical Scaling', link: '/operations/scaling/vertical' },
            { text: 'Database Scaling', link: '/operations/scaling/database' }
          ]
        },
        {
          text: 'Maintenance',
          items: [
            { text: 'Maintenance Windows', link: '/operations/maintenance/windows' },
            { text: 'Updates & Patches', link: '/operations/maintenance/updates' },
            { text: 'Database Maintenance', link: '/operations/maintenance/database' }
          ]
        }
      ],

      // Monitoring section
      '/monitoring/': [
        {
          text: 'Monitoring',
          items: [
            { text: 'Monitoring Overview', link: '/monitoring/overview' },
            { text: 'Metrics', link: '/monitoring/metrics' },
            { text: 'Logging', link: '/monitoring/logging' }
          ]
        },
        {
          text: 'Dashboards',
          items: [
            { text: 'System Dashboard', link: '/monitoring/dashboards/system' },
            { text: 'Application Dashboard', link: '/monitoring/dashboards/application' },
            { text: 'Database Dashboard', link: '/monitoring/dashboards/database' },
            { text: 'Queue Dashboard', link: '/monitoring/dashboards/queues' }
          ]
        },
        {
          text: 'Alerting',
          items: [
            { text: 'Alert Configuration', link: '/monitoring/alerting/configuration' },
            { text: 'Alert Rules', link: '/monitoring/alerting/rules' },
            { text: 'Notification Channels', link: '/monitoring/alerting/notifications' }
          ]
        },
        {
          text: 'Observability',
          items: [
            { text: 'Distributed Tracing', link: '/monitoring/observability/tracing' },
            { text: 'Performance Monitoring', link: '/monitoring/observability/performance' },
            { text: 'Error Tracking', link: '/monitoring/observability/errors' }
          ]
        }
      ],

      // Configuration section
      '/configuration/': [
        {
          text: 'Configuration',
          items: [
            { text: 'Configuration Overview', link: '/configuration/overview' },
            { text: 'v3.0 Configuration Guide', link: '/configuration/v3-configuration-guide' },
            { text: 'Environment Variables', link: '/configuration/environment-variables' },
            { text: 'Configuration Files', link: '/configuration/config-files' }
          ]
        },
        {
          text: 'Security Configuration',
          collapsed: false,
          items: [
            { text: 'Security Overview', link: '/configuration/security/README' },
            { text: 'Security Hardening Checklist', link: '/configuration/security/SECURITY_HARDENING_CHECKLIST' },
            { text: 'Security Implementation', link: '/configuration/security/SECURITY_IMPLEMENTATION_SUMMARY' },
            { text: 'SQL Injection Prevention', link: '/configuration/security/SQL_INJECTION_PREVENTION' },
            { text: 'Injection Prevention', link: '/configuration/security/INJECTION_PREVENTION' },
            { text: 'Certificate Management', link: '/configuration/security/CERTIFICATE_MANAGEMENT' },
            { text: 'SSL Migration Guide', link: '/configuration/security/SSL_MIGRATION_GUIDE' },
            { text: 'Secret Rotation', link: '/configuration/security/SECRET_ROTATION' },
            { text: 'Incident Response Plan', link: '/configuration/security/INCIDENT_RESPONSE_PLAN' }
          ]
        },
        {
          text: 'Service Configuration',
          items: [
            { text: 'Neo4j Configuration', link: '/configuration/services/neo4j' },
            { text: 'PostgreSQL Configuration', link: '/configuration/services/postgresql' },
            { text: 'Redis Configuration', link: '/configuration/services/redis' },
            { text: 'API Server Configuration', link: '/configuration/services/api-server' }
          ]
        }
      ],

      // Integration section
      '/integration/': [
        {
          text: 'Integration Guides',
          items: [
            { text: 'Integration Overview', link: '/integration/overview' },
            { text: 'Cloud Providers', link: '/integration/cloud-providers' }
          ]
        },
        {
          text: 'Cloud Integrations',
          items: [
            { text: 'AWS Integration', link: '/integration/aws' },
            { text: 'Azure Integration', link: '/integration/azure' },
            { text: 'GCP Integration', link: '/integration/gcp' }
          ]
        },
        {
          text: 'Other Integrations',
          items: [
            { text: 'SSH Discovery', link: '/integration/ssh' },
            { text: 'Network Discovery', link: '/integration/network' },
            { text: 'Custom Integrations', link: '/integration/custom' }
          ]
        }
      ],

      // API Reference section
      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'API Overview', link: '/api/overview' },
            { text: 'Authentication', link: '/api/authentication' }
          ]
        },
        {
          text: 'REST API',
          items: [
            { text: 'REST API Overview', link: '/api/rest' },
            { text: 'Configuration Items', link: '/api/rest/configuration-items' },
            { text: 'Relationships', link: '/api/rest/relationships' },
            { text: 'Discovery API', link: '/api/rest/discovery' },
            { text: 'Unified Credentials API', link: '/api/rest/unified' },
            { text: 'Financial Management API', link: '/api/rest/financial' },
            { text: 'Reports', link: '/api/rest/reports' }
          ]
        },
        {
          text: 'GraphQL API',
          items: [
            { text: 'GraphQL Overview', link: '/api/graphql' },
            { text: 'Schema', link: '/api/graphql/schema' },
            { text: 'Queries', link: '/api/graphql/queries' },
            { text: 'Mutations', link: '/api/graphql/mutations' },
            { text: 'Subscriptions', link: '/api/graphql/subscriptions' }
          ]
        }
      ],

      // Troubleshooting section
      '/troubleshooting/': [
        {
          text: 'Troubleshooting',
          items: [
            { text: 'Troubleshooting Guide', link: '/troubleshooting/overview' },
            { text: 'Common Issues', link: '/troubleshooting/common-issues' },
            { text: 'Debug Mode', link: '/troubleshooting/debug-mode' }
          ]
        },
        {
          text: 'Component Issues',
          items: [
            { text: 'Database Issues', link: '/troubleshooting/database' },
            { text: 'API Server Issues', link: '/troubleshooting/api-server' },
            { text: 'Discovery Issues', link: '/troubleshooting/discovery' },
            { text: 'Queue Issues', link: '/troubleshooting/queues' },
            { text: 'UI Issues', link: '/troubleshooting/ui' }
          ]
        },
        {
          text: 'Performance Issues',
          items: [
            { text: 'Performance Tuning', link: '/troubleshooting/performance/tuning' },
            { text: 'Slow Queries', link: '/troubleshooting/performance/slow-queries' },
            { text: 'Memory Issues', link: '/troubleshooting/performance/memory' }
          ]
        }
      ],

      // Quick Reference section
      '/quick-reference/': [
        {
          text: 'Quick Reference',
          items: [
            { text: 'Cheat Sheet', link: '/quick-reference/cheat-sheet' },
            { text: 'CLI Commands', link: '/quick-reference/cli-commands' },
            { text: 'API Endpoints', link: '/quick-reference/api-endpoints' },
            { text: 'Configuration Options', link: '/quick-reference/config-options' },
            { text: 'Environment Variables', link: '/quick-reference/env-vars' },
            { text: 'Graph Queries', link: '/quick-reference/graph-queries' },
            { text: 'Troubleshooting Checklist', link: '/quick-reference/troubleshooting-checklist' }
          ]
        }
      ],

      // User Guides section
      '/user-guides/': [
        {
          text: 'User Guides',
          items: [
            { text: 'Executive Dashboard', link: '/user-guides/executive-dashboard' },
            { text: 'CIO Dashboard', link: '/user-guides/cio-dashboard' },
            { text: 'FinOps Dashboard', link: '/user-guides/finops-dashboard' },
            { text: 'ITSM Operations', link: '/user-guides/itsm-operations' },
            { text: 'Service Owner Guide', link: '/user-guides/service-owner-guide' },
            { text: 'Administrator Guide', link: '/user-guides/administrator-guide' }
          ]
        }
      ]
    },

    // Social links
    socialLinks: [
      { icon: 'github', link: 'https://github.com/happycmdb/happycmdb' }
    ],

    // Footer
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2025 HappyCMDB Project'
    },

    // Edit link
    editLink: {
      pattern: 'https://github.com/happycmdb/happycmdb/edit/main/doc-site/docs/:path',
      text: 'Edit this page on GitHub'
    },

    // Search configuration (uses built-in local search)
    search: {
      provider: 'local',
      options: {
        detailedView: true,
        miniSearch: {
          searchOptions: {
            fuzzy: 0.2,
            prefix: true,
            boost: {
              title: 4,
              text: 2,
              titles: 1
            }
          }
        }
      }
    },

    // Outline settings
    outline: {
      level: [2, 3],
      label: 'On this page'
    },

    // Carbon ads (optional - remove if not using)
    // carbonAds: {
    //   code: 'your-carbon-code',
    //   placement: 'your-carbon-placement'
    // }
  },

  // Markdown configuration
  markdown: {
    theme: {
      light: 'github-light',
      dark: 'github-dark'
    },
    lineNumbers: true,
    // Table of contents configuration
    toc: {
      level: [2, 3]
    }
  },

  // Build optimization
  vite: {
    build: {
      chunkSizeWarningLimit: 1000
    }
  }
})
