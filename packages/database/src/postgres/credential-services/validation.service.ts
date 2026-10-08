// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Credential Validation Service
 * Handles credential structure validation and connection testing
 */

import { Pool } from 'pg';
import {
  UnifiedCredential,
  CredentialValidationResult,
} from '@cmdb/common';
import { logger } from '@cmdb/common';

export class CredentialValidationService {
  constructor(private pool: Pool) {}

  async validate(id: string, createdBy: string, organizationId: string, getById: (id: string) => Promise<UnifiedCredential | null>): Promise<CredentialValidationResult | null> {
    const client = await this.pool.connect();
    try {
      const credential = await getById(id);
      if (!credential) return null;

      const validationResult = this.validateCredentialStructure(credential);

      // Update validation status in database
      await client.query(
        `UPDATE credentials
        SET last_validated_at = NOW(),
            validation_status = $2
        WHERE id = $1 AND created_by = $3 AND organization_id = $4`,
        [id, validationResult.valid ? 'valid' : 'invalid', createdBy, organizationId]
      );

      logger.info('Credential validated', {
        id,
        valid: validationResult.valid,
      });

      return validationResult;
    } catch (error) {
      logger.error('Failed to validate credential', { error, id });
      return {
        valid: false,
        message: error instanceof Error ? error.message : 'Unknown error',
        validated_at: new Date(),
      };
    } finally {
      client.release();
    }
  }

  async testConnection(id: string, validateFunc: (id: string) => Promise<CredentialValidationResult | null>): Promise<boolean> {
    try {
      const result = await validateFunc(id);
      return result?.valid ?? false;
    } catch (error) {
      logger.error('Connection test failed', { error, id });
      return false;
    }
  }

  validateCredentialStructure(
    credential: UnifiedCredential
  ): CredentialValidationResult {
    const { protocol, credentials: creds } = credential;

    try {
      switch (protocol) {
        case 'aws_iam':
          if (!creds['access_key_id'] || !creds['secret_access_key']) {
            return {
              valid: false,
              message: 'Missing AWS access key or secret',
              validated_at: new Date(),
            };
          }
          break;

        case 'azure_sp':
          if (!creds['client_id'] || !creds['client_secret'] || !creds['tenant_id']) {
            return {
              valid: false,
              message: 'Missing Azure service principal credentials',
              validated_at: new Date(),
            };
          }
          break;

        case 'gcp_sa':
          if (!creds['project_id'] || !creds['private_key'] || !creds['client_email']) {
            return {
              valid: false,
              message: 'Missing GCP service account credentials',
              validated_at: new Date(),
            };
          }
          break;

        case 'ssh_key':
          if (!creds['username'] || !creds['private_key']) {
            return {
              valid: false,
              message: 'Missing SSH username or private key',
              validated_at: new Date(),
            };
          }
          break;

        case 'ssh_password':
          if (!creds['username'] || !creds['password']) {
            return {
              valid: false,
              message: 'Missing SSH username or password',
              validated_at: new Date(),
            };
          }
          break;

        case 'api_key':
          if (!creds['key']) {
            return {
              valid: false,
              message: 'Missing API key',
              validated_at: new Date(),
            };
          }
          break;

        case 'basic':
          if (!creds['username'] || !creds['password']) {
            return {
              valid: false,
              message: 'Missing username or password',
              validated_at: new Date(),
            };
          }
          break;

        case 'bearer':
          if (!creds['token']) {
            return {
              valid: false,
              message: 'Missing bearer token',
              validated_at: new Date(),
            };
          }
          break;

        case 'oauth2':
          if (!creds['client_id'] || !creds['client_secret'] || !creds['token_url']) {
            return {
              valid: false,
              message: 'Missing OAuth2 credentials',
              validated_at: new Date(),
            };
          }
          break;

        case 'snmp_v2c':
          if (!creds['community_string']) {
            return {
              valid: false,
              message: 'Missing SNMP community string',
              validated_at: new Date(),
            };
          }
          break;

        case 'snmp_v3':
          if (!creds['username'] || !creds['auth_protocol'] || !creds['auth_password']) {
            return {
              valid: false,
              message: 'Missing SNMP v3 credentials',
              validated_at: new Date(),
            };
          }
          break;

        case 'winrm':
          if (!creds['username'] || !creds['password']) {
            return {
              valid: false,
              message: 'Missing WinRM credentials',
              validated_at: new Date(),
            };
          }
          break;

        case 'certificate':
          if (!creds['certificate'] || !creds['private_key']) {
            return {
              valid: false,
              message: 'Missing certificate or private key',
              validated_at: new Date(),
            };
          }
          break;

        case 'kerberos':
          if (!creds['principal'] || !creds['realm']) {
            return {
              valid: false,
              message: 'Missing Kerberos principal or realm',
              validated_at: new Date(),
            };
          }
          if (!creds['password'] && !creds['keytab']) {
            return {
              valid: false,
              message: 'Missing Kerberos password or keytab',
              validated_at: new Date(),
            };
          }
          break;

        default:
          return {
            valid: false,
            message: `Unknown protocol: ${protocol}`,
            validated_at: new Date(),
          };
      }

      return {
        valid: true,
        message: 'Credential structure is valid',
        validated_at: new Date(),
        details: {
          protocol,
          scope: credential.scope,
        },
      };
    } catch (error) {
      return {
        valid: false,
        message: error instanceof Error ? error.message : 'Validation failed',
        validated_at: new Date(),
      };
    }
  }
}
