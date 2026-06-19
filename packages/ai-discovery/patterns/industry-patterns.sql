-- Industry-Standard Discovery Patterns
-- Prebuilt patterns for common technologies and frameworks
-- Based on open industry data and standard detection methods

-- ==================================================================
-- Java / Spring Boot
-- ==================================================================

INSERT INTO ai_discovery_patterns (
  pattern_id, name, version, category,
  detection_code, discovery_code,
  description, author, status, is_active, confidence_score
) VALUES (
  'spring-boot-actuator',
  'Spring Boot Actuator',
  '1.0.0',
  'java-frameworks',
  -- Detection code
  $$
function detect(scanResult) {
  let confidence = 0;
  const indicators = [];

  // Check HTTP headers
  const headers = scanResult.http?.headers || {};
  if (headers['x-application-context'] || headers['X-Application-Context']) {
    confidence += 0.4;
    indicators.push('spring-header');
  }

  // Check for actuator endpoints
  const endpoints = scanResult.http?.endpoints || [];
  if (endpoints.some(e => e.includes('/actuator'))) {
    confidence += 0.6;
    indicators.push('actuator-endpoint');
  }

  // Check response body for Spring Boot indicators
  const body = scanResult.http?.body || '';
  if (body.includes('Spring Boot') || body.includes('spring-boot')) {
    confidence += 0.2;
    indicators.push('spring-body');
  }

  return {
    matches: confidence >= 0.5,
    confidence: Math.min(confidence, 1.0),
    indicators
  };
}
  $$,
  -- Discovery code
  $$
async function discover(context) {
  const { targetHost, targetPort } = context;
  const protocol = targetPort === 443 ? 'https' : 'http';
  const baseUrl = protocol + '://' + targetHost + ':' + targetPort;

  const ci = {
    _type: 'application',
    name: 'Spring Boot App on ' + targetHost + ':' + targetPort,
    hostname: targetHost,
    port: targetPort,
    metadata: {
      technology: 'Spring Boot',
      framework: 'Spring Framework',
      platform: 'Java'
    }
  };

  // Try /actuator/info
  try {
    const infoResp = await fetch(baseUrl + '/actuator/info');
    if (infoResp.ok) {
      const info = await infoResp.json();
      ci.metadata.appInfo = info;
      if (info.app && info.app.version) {
        ci.metadata.version = info.app.version;
        ci.metadata.appName = info.app.name;
      }
      if (info.build) {
        ci.metadata.buildInfo = info.build;
      }
    }
  } catch (e) {}

  // Try /actuator/env for dependencies
  try {
    const envResp = await fetch(baseUrl + '/actuator/env');
    if (envResp.ok) {
      const env = await envResp.json();
      const props = env.propertySources || [];

      // Extract database connection
      for (const source of props) {
        const properties = source.properties || {};
        if (properties['spring.datasource.url']) {
          ci.metadata.database = properties['spring.datasource.url'].value;
        }
        if (properties['spring.redis.host']) {
          ci.metadata.redis = properties['spring.redis.host'].value;
        }
        if (properties['spring.kafka.bootstrap-servers']) {
          ci.metadata.kafka = properties['spring.kafka.bootstrap-servers'].value;
        }
      }
    }
  } catch (e) {}

  // Try /actuator/health
  try {
    const healthResp = await fetch(baseUrl + '/actuator/health');
    if (healthResp.ok) {
      const health = await healthResp.json();
      ci.metadata.health = health.status;
    }
  } catch (e) {}

  return [ci];
}
  $$,
  'Detects Spring Boot applications via Actuator endpoints and extracts app info, dependencies',
  'happycmdb',
  'active',
  true,
  0.95
);

-- ==================================================================
-- Node.js / Express
-- ==================================================================

INSERT INTO ai_discovery_patterns (
  pattern_id, name, version, category,
  detection_code, discovery_code,
  description, author, status, is_active, confidence_score
) VALUES (
  'nodejs-express',
  'Node.js Express Application',
  '1.0.0',
  'nodejs-frameworks',
  -- Detection
  $$
function detect(scanResult) {
  let confidence = 0;
  const indicators = [];

  const headers = scanResult.http?.headers || {};
  const server = (headers.server || headers.Server || '').toLowerCase();
  const poweredBy = (headers['x-powered-by'] || headers['X-Powered-By'] || '').toLowerCase();

  // Check X-Powered-By header
  if (poweredBy.includes('express')) {
    confidence += 0.7;
    indicators.push('express-header');
  } else if (poweredBy.includes('node')) {
    confidence += 0.4;
    indicators.push('nodejs-header');
  }

  // Check for common Express error responses
  const body = scanResult.http?.body || '';
  if (body.includes('Cannot GET') || body.includes('Cannot POST')) {
    confidence += 0.3;
    indicators.push('express-error');
  }

  return {
    matches: confidence >= 0.4,
    confidence: Math.min(confidence, 1.0),
    indicators
  };
}
  $$,
  -- Discovery
  $$
async function discover(context) {
  const { targetHost, targetPort } = context;
  const protocol = targetPort === 443 ? 'https' : 'http';
  const baseUrl = protocol + '://' + targetHost + ':' + targetPort;

  const ci = {
    _type: 'application',
    name: 'Node.js App on ' + targetHost + ':' + targetPort,
    hostname: targetHost,
    port: targetPort,
    metadata: {
      technology: 'Node.js',
      framework: 'Express',
      platform: 'JavaScript'
    }
  };

  // Try common Node.js health/status endpoints
  const endpoints = ['/health', '/status', '/api/health', '/healthz'];
  for (const endpoint of endpoints) {
    try {
      const resp = await fetch(baseUrl + endpoint);
      if (resp.ok) {
        ci.metadata.healthEndpoint = endpoint;
        const data = await resp.json();
        ci.metadata.health = data;
        break;
      }
    } catch (e) {}
  }

  // Try to get package.json (if exposed - rare but happens)
  try {
    const pkgResp = await fetch(baseUrl + '/package.json');
    if (pkgResp.ok) {
      const pkg = await pkgResp.json();
      ci.metadata.packageInfo = pkg;
      ci.metadata.version = pkg.version;
    }
  } catch (e) {}

  return [ci];
}
  $$,
  'Detects Node.js Express applications via headers and common patterns',
  'happycmdb',
  'active',
  true,
  0.85
);

-- ==================================================================
-- PostgreSQL Database
-- ==================================================================

INSERT INTO ai_discovery_patterns (
  pattern_id, name, version, category,
  detection_code, discovery_code,
  description, author, status, is_active, confidence_score
) VALUES (
  'postgresql-database',
  'PostgreSQL Database',
  '1.0.0',
  'databases',
  -- Detection
  $$
function detect(scanResult) {
  let confidence = 0;
  const indicators = [];

  const services = scanResult.services || [];

  // Check for PostgreSQL on port 5432
  const pgService = services.find(s =>
    s.port === 5432 ||
    (s.service && s.service.toLowerCase().includes('postgres'))
  );

  if (pgService) {
    confidence += 0.8;
    indicators.push('postgres-port');

    if (pgService.version) {
      confidence += 0.2;
      indicators.push('version-detected');
    }
  }

  return {
    matches: confidence >= 0.5,
    confidence: Math.min(confidence, 1.0),
    indicators
  };
}
  $$,
  -- Discovery
  $$
async function discover(context) {
  const { targetHost, targetPort, scanResult } = context;

  const services = scanResult.services || [];
  const pgService = services.find(s => s.port === 5432 || s.port === targetPort);

  const ci = {
    _type: 'database',
    name: 'PostgreSQL on ' + targetHost,
    hostname: targetHost,
    port: targetPort || 5432,
    metadata: {
      technology: 'PostgreSQL',
      dbType: 'relational',
      platform: 'SQL'
    }
  };

  if (pgService && pgService.version) {
    ci.metadata.version = pgService.version;
  }

  return [ci];
}
  $$,
  'Detects PostgreSQL database servers on standard port 5432',
  'happycmdb',
  'active',
  true,
  0.90
);

-- ==================================================================
-- MongoDB
-- ==================================================================

INSERT INTO ai_discovery_patterns (
  pattern_id, name, version, category,
  detection_code, discovery_code,
  description, author, status, is_active, confidence_score
) VALUES (
  'mongodb-database',
  'MongoDB Database',
  '1.0.0',
  'databases',
  -- Detection
  $$
function detect(scanResult) {
  let confidence = 0;
  const indicators = [];

  const services = scanResult.services || [];

  const mongoService = services.find(s =>
    s.port === 27017 ||
    (s.service && s.service.toLowerCase().includes('mongo'))
  );

  if (mongoService) {
    confidence += 0.8;
    indicators.push('mongodb-port');

    if (mongoService.version) {
      confidence += 0.2;
      indicators.push('version-detected');
    }
  }

  return {
    matches: confidence >= 0.5,
    confidence: Math.min(confidence, 1.0),
    indicators
  };
}
  $$,
  -- Discovery
  $$
async function discover(context) {
  const { targetHost, targetPort, scanResult } = context;

  const services = scanResult.services || [];
  const mongoService = services.find(s => s.port === 27017 || s.port === targetPort);

  const ci = {
    _type: 'database',
    name: 'MongoDB on ' + targetHost,
    hostname: targetHost,
    port: targetPort || 27017,
    metadata: {
      technology: 'MongoDB',
      dbType: 'document',
      platform: 'NoSQL'
    }
  };

  if (mongoService && mongoService.version) {
    ci.metadata.version = mongoService.version;
  }

  return [ci];
}
  $$,
  'Detects MongoDB database servers on standard port 27017',
  'happycmdb',
  'active',
  true,
  0.90
);

-- ==================================================================
-- Redis Cache
-- ==================================================================

INSERT INTO ai_discovery_patterns (
  pattern_id, name, version, category,
  detection_code, discovery_code,
  description, author, status, is_active, confidence_score
) VALUES (
  'redis-cache',
  'Redis Cache',
  '1.0.0',
  'caching',
  -- Detection
  $$
function detect(scanResult) {
  let confidence = 0;
  const indicators = [];

  const services = scanResult.services || [];

  const redisService = services.find(s =>
    s.port === 6379 ||
    (s.service && s.service.toLowerCase().includes('redis'))
  );

  if (redisService) {
    confidence += 0.9;
    indicators.push('redis-port');

    if (redisService.version) {
      confidence += 0.1;
      indicators.push('version-detected');
    }
  }

  return {
    matches: confidence >= 0.7,
    confidence: Math.min(confidence, 1.0),
    indicators
  };
}
  $$,
  -- Discovery
  $$
async function discover(context) {
  const { targetHost, targetPort, scanResult } = context;

  const services = scanResult.services || [];
  const redisService = services.find(s => s.port === 6379 || s.port === targetPort);

  const ci = {
    _type: 'cache',
    name: 'Redis on ' + targetHost,
    hostname: targetHost,
    port: targetPort || 6379,
    metadata: {
      technology: 'Redis',
      cacheType: 'key-value',
      platform: 'In-Memory'
    }
  };

  if (redisService && redisService.version) {
    ci.metadata.version = redisService.version;
  }

  return [ci];
}
  $$,
  'Detects Redis cache servers on standard port 6379',
  'happycmdb',
  'active',
  true,
  0.95
);

-- ==================================================================
-- Nginx Web Server
-- ==================================================================

INSERT INTO ai_discovery_patterns (
  pattern_id, name, version, category,
  detection_code, discovery_code,
  description, author, status, is_active, confidence_score
) VALUES (
  'nginx-webserver',
  'Nginx Web Server',
  '1.0.0',
  'web-servers',
  -- Detection
  $$
function detect(scanResult) {
  let confidence = 0;
  const indicators = [];

  const headers = scanResult.http?.headers || {};
  const server = (headers.server || headers.Server || '').toLowerCase();

  if (server.includes('nginx')) {
    confidence += 0.9;
    indicators.push('nginx-header');

    // Try to extract version
    const versionMatch = server.match(/nginx\/([\d.]+)/);
    if (versionMatch) {
      confidence += 0.1;
      indicators.push('version-detected');
    }
  }

  return {
    matches: confidence >= 0.7,
    confidence: Math.min(confidence, 1.0),
    indicators
  };
}
  $$,
  -- Discovery
  $$
async function discover(context) {
  const { targetHost, targetPort, scanResult } = context;

  const headers = scanResult.http?.headers || {};
  const server = headers.server || headers.Server || '';

  const ci = {
    _type: 'web-server',
    name: 'Nginx on ' + targetHost,
    hostname: targetHost,
    port: targetPort,
    metadata: {
      technology: 'Nginx',
      serverType: 'web-server',
      platform: 'Linux'
    }
  };

  // Extract version
  const versionMatch = server.match(/nginx\/([\d.]+)/i);
  if (versionMatch) {
    ci.metadata.version = versionMatch[1];
  }

  return [ci];
}
  $$,
  'Detects Nginx web servers via Server header',
  'happycmdb',
  'active',
  true,
  0.95
);

-- ==================================================================
-- Docker Engine
-- ==================================================================

INSERT INTO ai_discovery_patterns (
  pattern_id, name, version, category,
  detection_code, discovery_code,
  description, author, status, is_active, confidence_score
) VALUES (
  'docker-engine',
  'Docker Engine',
  '1.0.0',
  'container-platforms',
  -- Detection
  $$
function detect(scanResult) {
  let confidence = 0;
  const indicators = [];

  const services = scanResult.services || [];

  // Docker API typically on 2375 (unencrypted) or 2376 (TLS)
  const dockerService = services.find(s =>
    s.port === 2375 || s.port === 2376 ||
    (s.service && s.service.toLowerCase().includes('docker'))
  );

  if (dockerService) {
    confidence += 0.8;
    indicators.push('docker-port');
  }

  // Check HTTP response for Docker API
  const body = scanResult.http?.body || '';
  if (body.includes('docker') || body.includes('Docker')) {
    confidence += 0.2;
    indicators.push('docker-api');
  }

  return {
    matches: confidence >= 0.6,
    confidence: Math.min(confidence, 1.0),
    indicators
  };
}
  $$,
  -- Discovery
  $$
async function discover(context) {
  const { targetHost, targetPort } = context;

  const ci = {
    _type: 'container-platform',
    name: 'Docker Engine on ' + targetHost,
    hostname: targetHost,
    port: targetPort,
    metadata: {
      technology: 'Docker',
      platform: 'Container'
    }
  };

  // Try to get Docker version via API
  try {
    const resp = await fetch('http://' + targetHost + ':' + targetPort + '/version');
    if (resp.ok) {
      const version = await resp.json();
      ci.metadata.version = version.Version;
      ci.metadata.apiVersion = version.ApiVersion;
      ci.metadata.os = version.Os;
      ci.metadata.arch = version.Arch;
    }
  } catch (e) {}

  return [ci];
}
  $$,
  'Detects Docker Engine via API port and endpoints',
  'happycmdb',
  'active',
  true,
  0.85
);

-- ==================================================================
-- Elasticsearch
-- ==================================================================

INSERT INTO ai_discovery_patterns (
  pattern_id, name, version, category,
  detection_code, discovery_code,
  description, author, status, is_active, confidence_score
) VALUES (
  'elasticsearch',
  'Elasticsearch',
  '1.0.0',
  'search-engines',
  -- Detection
  $$
function detect(scanResult) {
  let confidence = 0;
  const indicators = [];

  const services = scanResult.services || [];
  const esService = services.find(s => s.port === 9200 || s.port === 9300);

  if (esService) {
    confidence += 0.5;
    indicators.push('elastic-port');
  }

  // Check HTTP response
  const body = scanResult.http?.body || '';
  const bodyLower = body.toLowerCase();

  if (bodyLower.includes('elasticsearch') || bodyLower.includes('elastic')) {
    confidence += 0.4;
    indicators.push('elastic-response');
  }

  if (bodyLower.includes('lucene')) {
    confidence += 0.2;
    indicators.push('lucene-detected');
  }

  return {
    matches: confidence >= 0.6,
    confidence: Math.min(confidence, 1.0),
    indicators
  };
}
  $$,
  -- Discovery
  $$
async function discover(context) {
  const { targetHost, targetPort } = context;
  const baseUrl = 'http://' + targetHost + ':' + (targetPort || 9200);

  const ci = {
    _type: 'search-engine',
    name: 'Elasticsearch on ' + targetHost,
    hostname: targetHost,
    port: targetPort || 9200,
    metadata: {
      technology: 'Elasticsearch',
      platform: 'Search/Analytics'
    }
  };

  // Try to get cluster info
  try {
    const resp = await fetch(baseUrl);
    if (resp.ok) {
      const info = await resp.json();
      ci.metadata.version = info.version?.number;
      ci.metadata.clusterName = info.cluster_name;
      ci.metadata.clusterUuid = info.cluster_uuid;
      ci.metadata.luceneVersion = info.version?.lucene_version;
    }
  } catch (e) {}

  return [ci];
}
  $$,
  'Detects Elasticsearch clusters on standard ports 9200/9300',
  'happycmdb',
  'active',
  true,
  0.90
);

-- ==================================================================
-- RabbitMQ
-- ==================================================================

INSERT INTO ai_discovery_patterns (
  pattern_id, name, version, category,
  detection_code, discovery_code,
  description, author, status, is_active, confidence_score
) VALUES (
  'rabbitmq',
  'RabbitMQ Message Broker',
  '1.0.0',
  'message-queues',
  -- Detection
  $$
function detect(scanResult) {
  let confidence = 0;
  const indicators = [];

  const services = scanResult.services || [];
  const rabbitService = services.find(s =>
    s.port === 5672 || s.port === 15672 ||
    (s.service && s.service.toLowerCase().includes('amqp'))
  );

  if (rabbitService) {
    confidence += 0.6;
    indicators.push('rabbitmq-port');
  }

  // Check for RabbitMQ management UI (port 15672)
  const body = scanResult.http?.body || '';
  if (body.includes('RabbitMQ') || body.includes('rabbitmq')) {
    confidence += 0.4;
    indicators.push('rabbitmq-ui');
  }

  return {
    matches: confidence >= 0.5,
    confidence: Math.min(confidence, 1.0),
    indicators
  };
}
  $$,
  -- Discovery
  $$
async function discover(context) {
  const { targetHost, targetPort } = context;

  const ci = {
    _type: 'message-queue',
    name: 'RabbitMQ on ' + targetHost,
    hostname: targetHost,
    port: targetPort,
    metadata: {
      technology: 'RabbitMQ',
      protocol: 'AMQP',
      platform: 'Message Broker'
    }
  };

  // Try management API
  try {
    const resp = await fetch('http://' + targetHost + ':15672/api/overview');
    if (resp.ok) {
      const info = await resp.json();
      ci.metadata.version = info.rabbitmq_version;
      ci.metadata.erlangVersion = info.erlang_version;
      ci.metadata.clusterName = info.cluster_name;
    }
  } catch (e) {}

  return [ci];
}
  $$,
  'Detects RabbitMQ message brokers on standard AMQP ports',
  'happycmdb',
  'active',
  true,
  0.88
);

-- Add more patterns as needed...

COMMENT ON TABLE ai_discovery_patterns IS 'Industry-standard patterns loaded for common technologies';
