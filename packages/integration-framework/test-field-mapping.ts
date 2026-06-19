// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Field Mapping Test Script
 * Tests the applyFieldMappings() functionality
 *
 * Run: npx ts-node test-field-mapping.ts
 */

import { BaseIntegrationConnector } from './src/core/base-connector';
import {
  ConnectorConfiguration,
  ConnectorMetadata,
  ConnectorResource,
  TestResult,
  ExtractedData,
  ExtractedRelationship,
  TransformedCI,
  IdentificationAttributes,
} from './src/types/connector.types';

// Mock connector for testing
class TestConnector extends BaseIntegrationConnector {
  async initialize(): Promise<void> {
    console.log('✓ Connector initialized');
  }

  async testConnection(): Promise<TestResult> {
    return { success: true };
  }

  async extractResource(resourceId: string): Promise<ExtractedData[]> {
    return [];
  }

  async extractRelationships(): Promise<ExtractedRelationship[]> {
    return [];
  }

  async transformResource(resourceId: string, sourceData: any): Promise<TransformedCI> {
    const { standardFields, metadata } = this.applyFieldMappings(resourceId, sourceData);

    return {
      name: standardFields.name || 'Unknown',
      ci_type: 'server',
      status: standardFields.status || 'active',
      environment: standardFields.environment || 'production',
      attributes: {
        ...standardFields,
        ...metadata,
      },
      identifiers: this.extractIdentifiers(sourceData),
      source: 'test-connector',
      source_id: sourceData.id || 'test-id',
      confidence_score: 0.95,
    };
  }

  extractIdentifiers(data: any): IdentificationAttributes {
    return {
      external_id: data.id,
      serial_number: data.serial,
    };
  }
}

// Test metadata with field mappings
const testMetadata: ConnectorMetadata = {
  type: 'lansweeper',
  name: 'Lansweeper Asset Discovery',
  version: '1.0.0',
  description: 'Test connector',
  author: 'HappyCMDB',
  verified: true,
  category: 'connector',
  capabilities: {
    extraction: true,
    relationships: false,
    incremental: false,
    bidirectional: false,
  },
  configuration_schema: {},
  resources: [
    {
      id: 'servers',
      name: 'Servers',
      description: 'Test servers',
      ci_type: 'server',
      operations: ['extract', 'transform', 'load'],
      enabled_by_default: true,
      field_mappings: {
        // Standard fields
        name: 'AssetBasicInfo.AssetName',
        ip_address: 'AssetBasicInfo.IPAddress',
        serial_number: 'AssetBasicInfo.SerialNumber',
        manufacturer: 'AssetBasicInfo.Manufacturer',
        model: 'AssetBasicInfo.Model',

        // Non-standard fields (should go to metadata)
        cpu_name: 'Processor.Name',
        cpu_count: 'Processor.NumberOfCores',
        ram_mb: 'Memory.TotalPhysical',
        disk_size_gb: 'DiskDrive.Size',
        os: 'OperatingSystem.Caption',
        os_version: 'OperatingSystem.Version',
        bios_version: 'BIOS.Version',
        last_seen: 'AssetBasicInfo.LastSeen',
      },
    },
  ],
};

// Test configuration
const testConfig: ConnectorConfiguration = {
  name: 'Test Lansweeper',
  type: 'lansweeper',
  enabled: true,
  connection: {},
};

// Sample source data (mimics Lansweeper API response)
const sampleSourceData = {
  AssetBasicInfo: {
    AssetName: 'SERVER-001',
    IPAddress: '192.168.1.100',
    SerialNumber: 'SN123456789',
    Manufacturer: 'Dell',
    Model: 'PowerEdge R740',
    LastSeen: '2025-01-15T10:30:00Z',
  },
  Processor: {
    Name: 'Intel Xeon E5-2680 v4',
    NumberOfCores: 16,
  },
  Memory: {
    TotalPhysical: 32768,
  },
  DiskDrive: {
    Size: 500,
  },
  OperatingSystem: {
    Caption: 'Windows Server 2019 Standard',
    Version: '10.0.17763',
  },
  BIOS: {
    Version: '2.5.0',
  },
};

// Run tests
async function runTests() {
  console.log('🧪 Testing Field Mapping Functionality\n');
  console.log('=' .repeat(60));

  const connector = new TestConnector(testConfig, testMetadata);
  await connector.initialize();

  console.log('\n📋 Test Configuration:');
  console.log('  Connector:', testMetadata.name);
  console.log('  Resource:', 'servers');
  console.log('  Field Mappings:', Object.keys(testMetadata.resources[0].field_mappings!).length);

  console.log('\n📦 Sample Source Data:');
  console.log(JSON.stringify(sampleSourceData, null, 2));

  console.log('\n🔄 Applying Field Mappings...\n');

  const result = await connector.transformResource('servers', sampleSourceData);

  console.log('✅ Transformation Result:\n');
  console.log(JSON.stringify(result, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('\n📊 Field Categorization:\n');

  const standardFieldsFound: string[] = [];
  const metadataFieldsFound: string[] = [];

  // Check which fields ended up where
  const standardFieldNames = new Set([
    'name', 'type', 'status', 'environment', 'description',
    'external_id', 'ip_address', 'hostname', 'serial_number',
    'manufacturer', 'model', 'location', 'owner', 'cost_center',
  ]);

  Object.keys(result.attributes).forEach(key => {
    if (standardFieldNames.has(key)) {
      standardFieldsFound.push(key);
    } else {
      metadataFieldsFound.push(key);
    }
  });

  console.log('✅ Standard CI Fields:');
  standardFieldsFound.forEach(field => {
    console.log(`   - ${field}: ${result.attributes[field]}`);
  });

  console.log('\n✅ Dynamic Metadata Fields:');
  metadataFieldsFound.forEach(field => {
    console.log(`   - ${field}: ${result.attributes[field]}`);
  });

  console.log('\n' + '='.repeat(60));
  console.log('\n✨ Test Results:\n');

  const totalFields = Object.keys(result.attributes).length;
  const standardCount = standardFieldsFound.length;
  const metadataCount = metadataFieldsFound.length;

  console.log(`  Total Fields Mapped: ${totalFields}`);
  console.log(`  Standard Fields: ${standardCount}`);
  console.log(`  Metadata Fields: ${metadataCount}`);

  // Validation
  const errors: string[] = [];

  if (!result.attributes.name) {
    errors.push('❌ Missing required field: name');
  }

  if (!result.attributes.ip_address) {
    errors.push('❌ Missing standard field: ip_address');
  }

  if (!result.attributes.cpu_name) {
    errors.push('❌ Missing metadata field: cpu_name');
  }

  if (!result.attributes.os) {
    errors.push('❌ Missing metadata field: os');
  }

  if (errors.length > 0) {
    console.log('\n❌ Validation Errors:');
    errors.forEach(err => console.log(`  ${err}`));
    process.exit(1);
  } else {
    console.log('\n✅ All validation checks passed!');
    console.log('\n🎉 Field mapping is working correctly!\n');
  }
}

// Execute tests
runTests().catch(error => {
  console.error('\n❌ Test failed:', error);
  process.exit(1);
});
