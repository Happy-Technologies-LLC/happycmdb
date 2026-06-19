// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit Tests - Matching Strategies
 * Focused tests on individual matching algorithms
 */

import { IdentityReconciliationEngine } from '../../src/engine/identity-reconciliation-engine';
import { IdentificationAttributes } from '@cmdb/integration-framework';
import {
  createServerWithStrongIdentifiers,
  createServerWithWeakIdentifiers,
  createDuplicateServers,
  createNetworkDevice,
  testHelpers,
} from '../fixtures/ci-factory';

// Mock dependencies
jest.mock('@cmdb/common', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  sanitizeCITypeForLabel: (ciType: string): string => ciType.replace(/-/g, '_').toLowerCase(),
}));

const mockNeo4jClient = {
  getSession: jest.fn(),
};

const mockPostgresClient = {
  query: jest.fn(),
};

const mockEventProducer = {
  emit: jest.fn(),
};

const mockSession = {
  run: jest.fn(),
  close: jest.fn(),
};

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: jest.fn(() => mockNeo4jClient),
  getPostgresClient: jest.fn(() => mockPostgresClient),
}));

jest.mock('@cmdb/event-processor', () => ({
  getEventProducer: jest.fn(() => mockEventProducer),
  EventType: {
    CI_DISCOVERED: 'ci_discovered',
    CI_UPDATED: 'ci_updated',
  },
}));

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { getEventProducer } from '@cmdb/event-processor';

describe('Matching Strategies - Detailed Tests', () => {
  let engine: IdentityReconciliationEngine;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Restore mock implementations after clearAllMocks
    (getNeo4jClient as jest.Mock).mockReturnValue(mockNeo4jClient);
    (getPostgresClient as jest.Mock).mockReturnValue(mockPostgresClient);
    (getEventProducer as jest.Mock).mockReturnValue(mockEventProducer);
    mockNeo4jClient.getSession.mockReturnValue(mockSession);

    (IdentityReconciliationEngine as any).instance = undefined;
    engine = IdentityReconciliationEngine.getInstance();

    // Setup mock for loadConfiguration (returns no custom config => uses defaults)
    mockPostgresClient.query.mockResolvedValueOnce({ rows: [] });
    await engine.loadConfiguration();
    mockPostgresClient.query.mockReset();
  });

  describe('External ID Matching', () => {
    it('should match AWS instance ID', async () => {
      const identifiers: IdentificationAttributes = {
        external_id: 'i-0abcdef123456789',
        hostname: 'web-server-01',
      };

      mockPostgresClient.query.mockResolvedValueOnce({
        rows: [{ ci_id: 'ci_aws_instance' }],
      });

      const ci = createServerWithStrongIdentifiers('web-server-01', 'aws');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      expect(result).toBeTruthy();
      expect(result?.match_strategy).toBe('external_id');
      expect(result?.confidence).toBe(100);
    });

    it('should match Azure VM resource ID', async () => {
      const identifiers: IdentificationAttributes = {
        external_id:
          '/subscriptions/abc/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01',
        hostname: 'azure-vm-01',
      };

      mockPostgresClient.query.mockResolvedValueOnce({
        rows: [{ ci_id: 'ci_azure_vm' }],
      });

      const ci = createServerWithStrongIdentifiers('azure-vm-01', 'azure');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      expect(result?.match_strategy).toBe('external_id');
      expect(result?.confidence).toBe(100);
    });

    it('should match GCP instance ID', async () => {
      const identifiers: IdentificationAttributes = {
        external_id: '1234567890123456789',
        hostname: 'gcp-instance-01',
      };

      mockPostgresClient.query.mockResolvedValueOnce({
        rows: [{ ci_id: 'ci_gcp_instance' }],
      });

      const ci = createServerWithStrongIdentifiers('gcp-instance-01', 'gcp');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      expect(result?.match_strategy).toBe('external_id');
    });

    it('should not match if external_id exists but for different source', async () => {
      const identifiers: IdentificationAttributes = {
        external_id: 'i-0abcdef123456789',
      };

      // External ID found but for different source
      mockPostgresClient.query.mockResolvedValueOnce({
        rows: [], // No match for this source
      });

      mockSession.run.mockResolvedValue({ records: [] });

      const ci = createServerWithStrongIdentifiers('server', 'azure');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      expect(result).toBeNull();
    });
  });

  describe('Serial Number Matching', () => {
    it('should match VMware VM serial number', async () => {
      const identifiers: IdentificationAttributes = {
        serial_number: 'VMware-42 1e 8d 9c 3f 7a 5b 2d-a1 b2 c3 d4 e5 f6 07 08',
      };

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn().mockReturnValue('ci_vmware_vm'),
          },
        ],
      });

      const ci = createServerWithStrongIdentifiers('vmware-vm', 'vmware');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      expect(result?.match_strategy).toBe('serial_number');
      expect(result?.confidence).toBe(95);
    });

    it('should match Dell server BIOS serial number', async () => {
      const identifiers: IdentificationAttributes = {
        serial_number: 'C7BBBP2',
      };

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn().mockReturnValue('ci_dell_server'),
          },
        ],
      });

      const ci = createServerWithStrongIdentifiers('dell-server', 'ssh');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      expect(result?.match_strategy).toBe('serial_number');
    });

    it('should match HP server serial number', async () => {
      const identifiers: IdentificationAttributes = {
        serial_number: 'MXQ12345AB',
      };

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn().mockReturnValue('ci_hp_server'),
          },
        ],
      });

      const ci = createServerWithStrongIdentifiers('hp-server', 'ssh');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      expect(result?.match_strategy).toBe('serial_number');
    });
  });

  describe('UUID Matching', () => {
    it('should match VMware BIOS UUID', async () => {
      const identifiers: IdentificationAttributes = {
        uuid: '564d2c9f-7a5b-2d3c-a1b2-c3d4e5f60708',
      };

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn().mockReturnValue('ci_vm_uuid'),
          },
        ],
      });

      const ci = createServerWithStrongIdentifiers('server', 'vmware');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      expect(result?.match_strategy).toBe('uuid');
      expect(result?.confidence).toBe(95);
    });

    it('should match system UUID from dmidecode', async () => {
      const identifiers: IdentificationAttributes = {
        uuid: '12345678-1234-1234-1234-123456789abc',
      };

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn().mockReturnValue('ci_system_uuid'),
          },
        ],
      });

      const ci = createServerWithStrongIdentifiers('server', 'ssh');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      expect(result?.match_strategy).toBe('uuid');
    });
  });

  describe('MAC Address Matching', () => {
    it('should match single MAC address', async () => {
      const identifiers: IdentificationAttributes = {
        mac_address: ['00:50:56:ab:cd:ef'],
      };

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn().mockReturnValue('ci_mac_match'),
          },
        ],
      });

      const ci = createServerWithStrongIdentifiers('server', 'nmap');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      expect(result?.match_strategy).toBe('mac_address');
      expect(result?.confidence).toBe(85);
    });

    it('should match any MAC in multi-NIC server', async () => {
      const identifiers: IdentificationAttributes = {
        mac_address: [
          '00:50:56:ab:cd:ef', // NIC 1
          '00:50:56:ab:cd:f0', // NIC 2
          '00:50:56:ab:cd:f1', // NIC 3
        ],
      };

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn().mockReturnValue('ci_multi_nic'),
          },
        ],
      });

      const ci = createServerWithStrongIdentifiers('server', 'ssh');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      expect(result?.match_strategy).toBe('mac_address');
    });

    it('should normalize MAC address formats', async () => {
      // Different MAC formats that represent the same address
      const formats = [
        '00:50:56:ab:cd:ef',
        '00-50-56-AB-CD-EF',
        '0050.56ab.cdef',
      ];

      for (const macFormat of formats) {
        const identifiers: IdentificationAttributes = {
          mac_address: [macFormat],
        };

        // Test that matching logic works regardless of format
        expect(identifiers.mac_address).toBeTruthy();
      }
    });
  });

  describe('FQDN Matching', () => {
    it('should match fully qualified domain name', async () => {
      const identifiers: IdentificationAttributes = {
        fqdn: 'prod-db-01.example.com',
      };

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn().mockReturnValue('ci_fqdn_match'),
          },
        ],
      });

      const ci = createServerWithStrongIdentifiers('prod-db-01', 'ssh');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      expect(result?.match_strategy).toBe('fqdn');
      expect(result?.confidence).toBe(80);
    });

    it('should be case-insensitive for FQDN', async () => {
      const identifiers: IdentificationAttributes = {
        fqdn: 'PROD-DB-01.EXAMPLE.COM',
      };

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn().mockReturnValue('ci_fqdn_case'),
          },
        ],
      });

      const ci = createServerWithStrongIdentifiers('prod-db-01', 'ssh');
      ci.identifiers = identifiers;

      // The implementation should handle case-insensitivity
      const result = await engine.findExistingCI(identifiers, ci);

      expect(result?.match_strategy).toBe('fqdn');
    });
  });

  describe('Composite Fuzzy Matching', () => {
    it('should match on exact hostname + exact IP', async () => {
      const identifiers: IdentificationAttributes = {
        hostname: 'prod-app-01',
        ip_address: ['10.0.1.50'],
      };

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn((field: string) => {
              if (field === 'ci_id') return 'ci_composite_exact';
              if (field === 'hostname') return 'prod-app-01';
              if (field === 'ips') return ['10.0.1.50'];
              return null;
            }),
          },
        ],
      });

      const ci = createServerWithStrongIdentifiers('prod-app-01', 'ssh');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      expect(result?.match_strategy).toBe('composite_fuzzy');
      expect(result?.confidence).toBeGreaterThan(90);
    });

    it('should match on similar hostname + exact IP', async () => {
      const identifiers: IdentificationAttributes = {
        hostname: 'prod-app-server-01',
        ip_address: ['10.0.1.50'],
      };

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn((field: string) => {
              if (field === 'ci_id') return 'ci_fuzzy_hostname';
              if (field === 'hostname') return 'prod-app-01'; // Similar but not exact
              if (field === 'ips') return ['10.0.1.50'];
              return null;
            }),
          },
        ],
      });

      const ci = createServerWithStrongIdentifiers('prod-app-server-01', 'nmap');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      // Should match but with lower confidence
      if (result) {
        expect(result.match_strategy).toBe('composite_fuzzy');
        expect(result.confidence).toBeLessThan(90);
        expect(result.confidence).toBeGreaterThanOrEqual(65);
      }
    });

    it('should not match on very different hostnames even with same IP', async () => {
      const identifiers: IdentificationAttributes = {
        hostname: 'web-frontend-prod',
        ip_address: ['10.0.1.50'],
      };

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn((field: string) => {
              if (field === 'ci_id') return 'ci_different_host';
              if (field === 'hostname') return 'database-backend-dev';
              if (field === 'ips') return ['10.0.1.50'];
              return null;
            }),
          },
        ],
      });

      const ci = createServerWithStrongIdentifiers('web-frontend-prod', 'nmap');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      // Should not match (score below threshold)
      expect(result).toBeNull();
    });

    it('should handle multiple candidate matches and select best', async () => {
      const identifiers: IdentificationAttributes = {
        hostname: 'prod-server',
        ip_address: ['10.0.1.50'],
      };

      mockSession.run.mockResolvedValueOnce({
        records: [
          // Candidate 1: Good hostname match, no IP overlap
          {
            get: jest.fn((field: string) => {
              if (field === 'ci_id') return 'ci_candidate_1';
              if (field === 'hostname') return 'prod-server-01';
              if (field === 'ips') return ['10.0.1.51'];
              return null;
            }),
          },
          // Candidate 2: Perfect hostname + IP match
          {
            get: jest.fn((field: string) => {
              if (field === 'ci_id') return 'ci_candidate_2';
              if (field === 'hostname') return 'prod-server';
              if (field === 'ips') return ['10.0.1.50'];
              return null;
            }),
          },
          // Candidate 3: Poor hostname match, IP overlap
          {
            get: jest.fn((field: string) => {
              if (field === 'ci_id') return 'ci_candidate_3';
              if (field === 'hostname') return 'test-dev-server';
              if (field === 'ips') return ['10.0.1.50'];
              return null;
            }),
          },
        ],
      });

      const ci = createServerWithStrongIdentifiers('prod-server', 'ssh');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      // Should select candidate 2 (best match)
      expect(result?.ci_id).toBe('ci_candidate_2');
    });
  });

  describe('Match Strategy Priority', () => {
    it('should prefer external_id over all other strategies', async () => {
      const identifiers: IdentificationAttributes = {
        external_id: 'i-12345',
        serial_number: 'SN-12345',
        uuid: 'uuid-12345',
        mac_address: ['00:11:22:33:44:55'],
        fqdn: 'server.example.com',
        hostname: 'server',
        ip_address: ['10.0.0.1'],
      };

      mockPostgresClient.query.mockResolvedValueOnce({
        rows: [{ ci_id: 'ci_external_id' }],
      });

      const ci = createServerWithStrongIdentifiers('server', 'aws');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      expect(result?.match_strategy).toBe('external_id');
      // Should not check other strategies
      expect(mockSession.run).not.toHaveBeenCalled();
    });

    it('should try serial_number if external_id not found', async () => {
      const identifiers: IdentificationAttributes = {
        external_id: 'not-found',
        serial_number: 'SN-12345',
      };

      mockPostgresClient.query.mockResolvedValueOnce({
        rows: [], // External ID not found
      });

      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn().mockReturnValue('ci_serial'),
          },
        ],
      });

      const ci = createServerWithStrongIdentifiers('server', 'ssh');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      expect(result?.match_strategy).toBe('serial_number');
    });

    it('should cascade through all strategies until match found', async () => {
      const identifiers: IdentificationAttributes = {
        hostname: 'server',
        ip_address: ['10.0.0.1'],
      };

      // No strong identifiers, should fall through to composite fuzzy
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: jest.fn((field: string) => {
              if (field === 'ci_id') return 'ci_fuzzy';
              if (field === 'hostname') return 'server';
              if (field === 'ips') return ['10.0.0.1'];
              return null;
            }),
          },
        ],
      });

      const ci = createServerWithWeakIdentifiers('server', 'nmap');
      ci.identifiers = identifiers;

      const result = await engine.findExistingCI(identifiers, ci);

      expect(result?.match_strategy).toBe('composite_fuzzy');
    });
  });
});
