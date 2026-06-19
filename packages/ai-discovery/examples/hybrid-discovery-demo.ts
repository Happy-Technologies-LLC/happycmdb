// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Hybrid Discovery Demo
 * Demonstrates the three-tier discovery system:
 * 1. Pattern Matching (Fast Path) - <1 second
 * 2. AI Discovery (Intelligent Path) - 10-60 seconds
 * 3. Fallback - Legacy workers
 */

import { HybridDiscoveryOrchestrator, AIDiscoveryContext } from '../src';

async function main() {
  console.log('='.repeat(70));
  console.log('HappyCMDB Hybrid Discovery Demo');
  console.log('='.repeat(70));
  console.log('');

  // Initialize hybrid orchestrator
  const orchestrator = new HybridDiscoveryOrchestrator({
    aiEnabled: process.env['AI_DISCOVERY_ENABLED'] === 'true',
    patternMatchingEnabled: true,
    patternConfidenceThreshold: 0.9,
    lowConfidenceThreshold: 0.7,
    mediumConfidenceThreshold: 0.9,
  });

  // Example 1: Spring Boot application (should match pattern)
  console.log('Example 1: Spring Boot Application');
  console.log('-'.repeat(70));

  const springBootContext: AIDiscoveryContext = {
    targetHost: 'api.example.com',
    targetPort: 8080,
    scanResult: {
      openPorts: [8080],
      services: [{ port: 8080, service: 'http', version: 'unknown' }],
      http: {
        status: 200,
        headers: {
          'X-Application-Context': 'application:prod:8080',
          'Content-Type': 'application/json',
        },
        endpoints: ['/actuator/health', '/actuator/info', '/actuator/env'],
        body: 'Spring Boot application',
      },
    },
  };

  try {
    const result1 = await orchestrator.discover(springBootContext);

    console.log('✅ Discovery completed!');
    console.log(`   Method: ${result1.method.toUpperCase()}`);
    console.log(`   Confidence: ${(result1.confidence * 100).toFixed(1)}%`);
    console.log(`   Time: ${result1.executionTimeMs}ms`);
    console.log(`   Cost: $${result1.cost.toFixed(4)}`);
    console.log(`   Pattern: ${result1.patternUsed || 'N/A'}`);
    console.log(`   Discovered: ${result1.discoveredCIs.length} CI(s)`);

    if (result1.discoveredCIs.length > 0) {
      console.log('');
      console.log('   CI Details:');
      result1.discoveredCIs.forEach((ci, index) => {
        console.log(`   ${index + 1}. Type: ${ci._type}`);
        console.log(`      Name: ${ci.name}`);
        console.log(
          `      Technology: ${ci.metadata?.technology || 'Unknown'}`
        );
      });
    }
  } catch (error) {
    console.error('❌ Discovery failed:', error);
  }

  console.log('');
  console.log('');

  // Example 2: PostgreSQL database (should match pattern)
  console.log('Example 2: PostgreSQL Database');
  console.log('-'.repeat(70));

  const postgresContext: AIDiscoveryContext = {
    targetHost: 'db.example.com',
    targetPort: 5432,
    scanResult: {
      openPorts: [5432],
      services: [
        { port: 5432, service: 'postgresql', version: 'PostgreSQL 14.5' },
      ],
    },
  };

  try {
    const result2 = await orchestrator.discover(postgresContext);

    console.log('✅ Discovery completed!');
    console.log(`   Method: ${result2.method.toUpperCase()}`);
    console.log(`   Confidence: ${(result2.confidence * 100).toFixed(1)}%`);
    console.log(`   Time: ${result2.executionTimeMs}ms`);
    console.log(`   Cost: $${result2.cost.toFixed(4)}`);
    console.log(`   Pattern: ${result2.patternUsed || 'N/A'}`);
    console.log(`   Discovered: ${result2.discoveredCIs.length} CI(s)`);

    if (result2.discoveredCIs.length > 0) {
      console.log('');
      console.log('   CI Details:');
      result2.discoveredCIs.forEach((ci, index) => {
        console.log(`   ${index + 1}. Type: ${ci._type}`);
        console.log(`      Name: ${ci.name}`);
        console.log(
          `      Technology: ${ci.metadata?.technology || 'Unknown'}`
        );
      });
    }
  } catch (error) {
    console.error('❌ Discovery failed:', error);
  }

  console.log('');
  console.log('');

  // Example 3: Unknown service (will use AI if enabled)
  console.log('Example 3: Unknown Custom Service');
  console.log('-'.repeat(70));

  const unknownContext: AIDiscoveryContext = {
    targetHost: 'custom.example.com',
    targetPort: 3000,
    scanResult: {
      openPorts: [3000],
      services: [{ port: 3000, service: 'http', version: 'unknown' }],
      http: {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          Server: 'CustomApp/1.0',
        },
        body: JSON.stringify({ status: 'ok', app: 'custom-service' }),
      },
    },
  };

  try {
    const result3 = await orchestrator.discover(unknownContext);

    console.log('✅ Discovery completed!');
    console.log(`   Method: ${result3.method.toUpperCase()}`);
    console.log(`   Confidence: ${(result3.confidence * 100).toFixed(1)}%`);
    console.log(`   Time: ${result3.executionTimeMs}ms`);
    console.log(`   Cost: $${result3.cost.toFixed(4)}`);

    if (result3.method === 'ai') {
      console.log('');
      console.log('   AI Reasoning:');
      const reasoning = result3.aiReasoning || 'N/A';
      const lines = reasoning.split('\n').slice(0, 5); // First 5 lines
      lines.forEach(line => console.log(`   ${line}`));
      if (reasoning.split('\n').length > 5) {
        console.log('   ...');
      }
    }

    console.log(`   Discovered: ${result3.discoveredCIs.length} CI(s)`);
  } catch (error) {
    console.error('❌ Discovery failed:', error);
  }

  console.log('');
  console.log('');
  console.log('='.repeat(70));
  console.log('Summary');
  console.log('='.repeat(70));
  console.log('');
  console.log('Hybrid Discovery Routes:');
  console.log('  1. PATTERN (Fast)    - Known services matched instantly (<1s)');
  console.log('  2. AI (Intelligent)  - Unknown services analyzed by LLM (10-60s)');
  console.log('  3. FALLBACK          - Manual or legacy discovery methods');
  console.log('');
  console.log('Cost Comparison:');
  console.log('  - Pattern matching: $0.00 (free!)');
  console.log('  - AI discovery:     ~$0.02-0.05 per discovery');
  console.log('  - After learning:   $0.00 (pattern generated)');
  console.log('');
  console.log('Pattern Library Status:');

  const patterns = orchestrator.getPatternMatcher().getPatterns();
  console.log(`  - Loaded patterns: ${patterns.length}`);
  console.log('  - Categories:');

  const categories = new Set(patterns.map(p => p.category));
  categories.forEach(cat => {
    const count = patterns.filter(p => p.category === cat).length;
    console.log(`    * ${cat}: ${count} pattern(s)`);
  });

  console.log('');
  console.log('Configuration:');
  const config = orchestrator.getConfig();
  console.log(`  - AI Enabled: ${config.aiEnabled ? 'Yes' : 'No'}`);
  console.log(
    `  - Pattern Matching: ${config.patternMatchingEnabled ? 'Yes' : 'No'}`
  );
  console.log(
    `  - Pattern Confidence Threshold: ${(config.patternConfidenceThreshold * 100).toFixed(0)}%`
  );
  console.log(
    `  - Monthly Budget: $${config.monthlyBudget?.toFixed(2) || 'Unlimited'}`
  );
  console.log('');
  console.log('='.repeat(70));
}

// Run demo
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
