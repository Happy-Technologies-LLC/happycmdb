// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Credential Protocol Adapter
 *
 * Converts UnifiedCredential objects (protocol-based) to provider-specific
 * SDK credential formats. This adapter decouples the unified credential storage
 * from the various SDK implementations used by discovery workers.
 *
 * Usage:
 * - Discovery workers use these adapters to convert credentials before SDK calls
 * - Each adapter validates the protocol type and required fields
 * - Adapters throw descriptive errors for invalid or missing data
 */

import { UnifiedCredential } from '../types/unified-credential.types';

/**
 * AWS SDK Credential Identity
 * Matches the interface from @aws-sdk/types
 */
export interface AwsCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

/**
 * Azure Client Secret Credential Configuration
 * Matches the constructor parameters for @azure/identity ClientSecretCredential
 */
export interface AzureClientSecretConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/**
 * GCP Service Account Credentials
 * Matches the structure expected by @google-cloud/* packages
 */
export interface GCPServiceAccountCredentials {
  type: 'service_account';
  project_id: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
  client_id?: string;
  auth_uri?: string;
  token_uri?: string;
  auth_provider_x509_cert_url?: string;
  client_x509_cert_url?: string;
}

/**
 * SSH Connection Configuration
 * Matches the config expected by node-ssh and similar libraries
 */
export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  privateKey?: string;
  passphrase?: string;
  password?: string;
}

/**
 * SNMP Configuration
 * Matches the config expected by net-snmp and similar libraries
 */
export interface SNMPConfig {
  version: '2c' | '3';
  community?: string;
  username?: string;
  authProtocol?: string;
  authPassword?: string;
  privProtocol?: string;
  privPassword?: string;
}

/**
 * WinRM Configuration
 * Matches the config expected by node-winrm and similar libraries
 */
export interface WinRMConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  transport: 'http' | 'https';
}

/**
 * Kubernetes Configuration
 * Matches the config expected by @kubernetes/client-node
 */
export interface KubernetesConfig {
  /** Full kubeconfig YAML content */
  kubeconfigContent?: string;
  /** Kubernetes API server URL */
  server?: string;
  /** Bearer token for authentication */
  token?: string;
  /** CA certificate (base64 encoded) */
  certificateAuthority?: string;
  /** Default namespace */
  namespace?: string;
  /** Skip TLS verification */
  skipTLSVerify?: boolean;
}

/**
 * LDAP/Active Directory Configuration
 * Matches the config expected by ldapjs and similar LDAP clients
 */
export interface LDAPConfig {
  /** LDAP server URL (ldap:// or ldaps://) */
  url: string;
  /** Base DN for searches (e.g., DC=example,DC=com) */
  baseDN: string;
  /** Bind DN or username */
  bindDN: string;
  /** Password */
  password: string;
  /** Use SSL/TLS */
  useSSL: boolean;
  /** Port (default: 389 for LDAP, 636 for LDAPS) */
  port: number;
}

/**
 * Redfish API Configuration
 * Matches the config expected by Redfish-compatible BMCs (iDRAC, iLO, XCC)
 */
export interface RedfishConfig {
  /** Target host (IP or hostname) */
  host: string;
  /** Username for Redfish authentication */
  username: string;
  /** Password for Redfish authentication */
  password: string;
  /** Port (default: 443) */
  port: number;
  /** Verify SSL certificates */
  verifySsl: boolean;
  /** Request timeout in milliseconds */
  timeout: number;
}

/**
 * Proxmox VE Configuration
 * Matches the config expected by Proxmox VE API
 */
export interface ProxmoxConfig {
  /** Username (user@realm format, e.g., root@pam or admin@pve) */
  username: string;
  /** Password for ticket-based authentication */
  password?: string;
  /** API token ID (alternative to password) */
  tokenId?: string;
  /** API token secret (alternative to password) */
  tokenSecret?: string;
}

/**
 * Credential Protocol Adapter
 *
 * Static utility class that converts UnifiedCredential objects to
 * provider-specific SDK credential formats.
 */
export class CredentialProtocolAdapter {
  /**
   * Convert UnifiedCredential to AWS SDK AwsCredentialIdentity
   *
   * @param cred - UnifiedCredential with protocol 'aws_iam'
   * @returns AwsCredentialIdentity object for use with @aws-sdk/* packages
   * @throws Error if protocol is not 'aws_iam' or required fields are missing
   */
  static toAWSCredentials(cred: UnifiedCredential): AwsCredentialIdentity {
    if (cred.protocol !== 'aws_iam') {
      throw new Error(
        `Invalid protocol for AWS: ${cred.protocol}. Expected aws_iam.`
      );
    }

    const { access_key_id, secret_access_key, session_token } = cred.credentials;

    if (!access_key_id || !secret_access_key) {
      throw new Error(
        'AWS IAM credentials must include access_key_id and secret_access_key'
      );
    }

    return {
      accessKeyId: access_key_id,
      secretAccessKey: secret_access_key,
      sessionToken: session_token, // Optional for STS temporary credentials
    };
  }

  /**
   * Convert UnifiedCredential to Azure ClientSecretCredential configuration
   *
   * @param cred - UnifiedCredential with protocol 'azure_sp'
   * @returns Configuration object for Azure ClientSecretCredential constructor
   * @throws Error if protocol is not 'azure_sp' or required fields are missing
   */
  static toAzureCredentials(cred: UnifiedCredential): AzureClientSecretConfig {
    if (cred.protocol !== 'azure_sp') {
      throw new Error(
        `Invalid protocol for Azure: ${cred.protocol}. Expected azure_sp.`
      );
    }

    const { tenant_id, client_id, client_secret } = cred.credentials;

    if (!tenant_id || !client_id || !client_secret) {
      throw new Error(
        'Azure Service Principal credentials must include tenant_id, client_id, and client_secret'
      );
    }

    return {
      tenantId: tenant_id,
      clientId: client_id,
      clientSecret: client_secret,
    };
  }

  /**
   * Convert UnifiedCredential to GCP Service Account credentials
   *
   * @param cred - UnifiedCredential with protocol 'gcp_sa'
   * @returns Service Account JSON object for use with @google-cloud/* packages
   * @throws Error if protocol is not 'gcp_sa' or required fields are missing
   */
  static toGCPCredentials(cred: UnifiedCredential): GCPServiceAccountCredentials {
    if (cred.protocol !== 'gcp_sa') {
      throw new Error(
        `Invalid protocol for GCP: ${cred.protocol}. Expected gcp_sa.`
      );
    }

    const { project_id, private_key, client_email } = cred.credentials;

    if (!project_id || !private_key || !client_email) {
      throw new Error(
        'GCP Service Account credentials must include project_id, private_key, and client_email'
      );
    }

    // Return the service account JSON structure
    // GCP libraries expect the entire service account JSON
    return {
      type: 'service_account',
      project_id,
      private_key,
      client_email,
      ...cred.credentials, // Include additional fields if present
    } as GCPServiceAccountCredentials;
  }

  static readonly INVALID_SSH_PORT = 'Invalid SSH port';

  /** HAP-444 K1: the one SSH port rule. A JSON integer 1-65535; strings, null and floats are refused. */
  static isSshPort(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;
  }

  /**
   * Convert UnifiedCredential to SSH connection configuration
   *
   * @param cred - UnifiedCredential with protocol 'ssh_key' or 'ssh_password'
   * @param host - Target hostname or IP address
   * @returns SSH configuration object for use with node-ssh or similar libraries
   * @throws Error if protocol is not ssh_key/ssh_password or required fields are missing
   */
  static toSSHConfig(cred: UnifiedCredential, host: string): SSHConfig {
    if (!['ssh_key', 'ssh_password'].includes(cred.protocol)) {
      throw new Error(
        `Invalid protocol for SSH: ${cred.protocol}. Expected ssh_key or ssh_password.`
      );
    }

    const { username, port } = cred.credentials;

    if (!username) {
      throw new Error('SSH credentials must include username');
    }

    if (port !== undefined && !CredentialProtocolAdapter.isSshPort(port)) {
      throw new Error(CredentialProtocolAdapter.INVALID_SSH_PORT);
    }

    const config: SSHConfig = {
      host,
      port: port ?? 22,
      username,
    };

    if (cred.protocol === 'ssh_key') {
      const { private_key, passphrase } = cred.credentials;

      if (!private_key) {
        throw new Error('SSH key credentials must include private_key');
      }

      config.privateKey = private_key;
      config.passphrase = passphrase; // Optional
    } else {
      // ssh_password
      const { password } = cred.credentials;

      if (!password) {
        throw new Error('SSH password credentials must include password');
      }

      config.password = password;
    }

    return config;
  }

  /**
   * Convert UnifiedCredential to SNMP configuration
   *
   * @param cred - UnifiedCredential with protocol 'snmp_v2c' or 'snmp_v3'
   * @returns SNMP configuration object for use with net-snmp or similar libraries
   * @throws Error if protocol is not snmp_v2c/snmp_v3 or required fields are missing
   */
  static toSNMPConfig(cred: UnifiedCredential): SNMPConfig {
    if (cred.protocol === 'snmp_v2c') {
      const { community_string } = cred.credentials;

      if (!community_string) {
        throw new Error('SNMP v2c credentials must include community_string');
      }

      return {
        version: '2c',
        community: community_string,
      };
    } else if (cred.protocol === 'snmp_v3') {
      const {
        username,
        auth_protocol,
        auth_password,
        priv_protocol,
        priv_password,
      } = cred.credentials;

      if (!username || !auth_protocol || !auth_password) {
        throw new Error(
          'SNMP v3 credentials must include username, auth_protocol, and auth_password'
        );
      }

      return {
        version: '3',
        username,
        authProtocol: auth_protocol,
        authPassword: auth_password,
        privProtocol: priv_protocol, // Optional
        privPassword: priv_password, // Optional
      };
    }

    throw new Error(`Invalid SNMP protocol: ${cred.protocol}`);
  }

  /**
   * Convert UnifiedCredential to API authentication headers
   *
   * @param cred - UnifiedCredential with protocol 'api_key', 'bearer', or 'basic'
   * @returns HTTP headers object for use with axios, fetch, etc.
   * @throws Error if protocol is not supported or required fields are missing
   */
  static toAPIHeaders(cred: UnifiedCredential): Record<string, string> {
    switch (cred.protocol) {
      case 'api_key': {
        const { key, header_name } = cred.credentials;

        if (!key) {
          throw new Error('API key credentials must include key');
        }

        const headerName = header_name || 'X-API-Key';
        return { [headerName]: key };
      }

      case 'bearer': {
        const { token } = cred.credentials;

        if (!token) {
          throw new Error('Bearer credentials must include token');
        }

        return { Authorization: `Bearer ${token}` };
      }

      case 'basic': {
        const { username, password } = cred.credentials;

        if (!username || !password) {
          throw new Error('Basic auth credentials must include username and password');
        }

        const encoded = Buffer.from(`${username}:${password}`).toString('base64');
        return { Authorization: `Basic ${encoded}` };
      }

      default:
        throw new Error(`Unsupported API protocol: ${cred.protocol}`);
    }
  }

  /**
   * Convert UnifiedCredential to WinRM configuration
   *
   * @param cred - UnifiedCredential with protocol 'winrm'
   * @param host - Target hostname or IP address
   * @returns WinRM configuration object for use with node-winrm or similar libraries
   * @throws Error if protocol is not 'winrm' or required fields are missing
   */
  static toWinRMConfig(cred: UnifiedCredential, host: string): WinRMConfig {
    if (cred.protocol !== 'winrm') {
      throw new Error(
        `Invalid protocol for WinRM: ${cred.protocol}. Expected winrm.`
      );
    }

    const { username, password, port, transport } = cred.credentials;

    if (!username || !password) {
      throw new Error('WinRM credentials must include username and password');
    }

    return {
      host,
      port: port || 5985,
      username,
      password,
      transport: transport || 'http',
    };
  }

  /**
   * Convert UnifiedCredential to Kubernetes configuration
   *
   * @param cred - UnifiedCredential with protocol 'kubernetes'
   * @returns Kubernetes configuration object for use with @kubernetes/client-node
   * @throws Error if protocol is not 'kubernetes' or required fields are missing
   */
  static toKubernetesConfig(cred: UnifiedCredential): KubernetesConfig {
    if (cred.protocol !== 'kubernetes') {
      throw new Error(
        `Invalid protocol for Kubernetes: ${cred.protocol}. Expected kubernetes.`
      );
    }

    const {
      kubeconfig_content,
      server,
      token,
      certificate_authority,
      namespace,
      skip_tls_verify,
    } = cred.credentials;

    // Either kubeconfig content OR server+token must be provided
    if (!kubeconfig_content && (!server || !token)) {
      throw new Error(
        'Kubernetes credentials must include either kubeconfig_content or both server and token'
      );
    }

    return {
      kubeconfigContent: kubeconfig_content,
      server,
      token,
      certificateAuthority: certificate_authority,
      namespace: namespace || 'default',
      skipTLSVerify: skip_tls_verify || false,
    };
  }

  /**
   * Convert UnifiedCredential to LDAP configuration
   *
   * @param cred - UnifiedCredential with protocol 'ldap'
   * @returns LDAP configuration object for use with ldapjs
   * @throws Error if protocol is not 'ldap' or required fields are missing
   */
  static toLDAPConfig(cred: UnifiedCredential): LDAPConfig {
    if (cred.protocol !== 'ldap') {
      throw new Error(
        `Invalid protocol for LDAP: ${cred.protocol}. Expected ldap.`
      );
    }

    const { domain, base_dn, username, password, use_ssl, port } = cred.credentials;

    if (!domain || !base_dn || !username || !password) {
      throw new Error(
        'LDAP credentials must include domain, base_dn, username, and password'
      );
    }

    // Determine SSL usage and port
    const useSSL = use_ssl !== undefined ? use_ssl : true;
    const ldapPort = port || (useSSL ? 636 : 389);

    // Construct LDAP URL
    const protocol = useSSL ? 'ldaps' : 'ldap';
    const url = domain.startsWith('ldap://') || domain.startsWith('ldaps://')
      ? domain
      : `${protocol}://${domain}:${ldapPort}`;

    return {
      url,
      baseDN: base_dn,
      bindDN: username,
      password,
      useSSL,
      port: ldapPort,
    };
  }

  /**
   * Convert UnifiedCredential to Redfish API configuration
   *
   * @param cred - UnifiedCredential with protocol 'redfish'
   * @param host - Target BMC hostname or IP address
   * @returns Redfish configuration object for use with BMC API clients
   * @throws Error if protocol is not 'redfish' or required fields are missing
   */
  static toRedfishConfig(cred: UnifiedCredential, host: string): RedfishConfig {
    if (cred.protocol !== 'redfish') {
      throw new Error(
        `Invalid protocol for Redfish: ${cred.protocol}. Expected redfish.`
      );
    }

    const { username, password, port, verify_ssl, timeout } = cred.credentials;

    if (!username || !password) {
      throw new Error('Redfish credentials must include username and password');
    }

    return {
      host,
      username,
      password,
      port: port || 443,
      verifySsl: verify_ssl !== undefined ? verify_ssl : false,
      timeout: timeout || 30000,
    };
  }

  /**
   * Convert UnifiedCredential to Proxmox VE configuration
   *
   * @param cred - UnifiedCredential with protocol 'proxmox'
   * @returns Proxmox configuration object for Proxmox discovery worker
   * @throws Error if protocol is not 'proxmox' or required fields are missing
   */
  static toProxmoxConfig(cred: UnifiedCredential): ProxmoxConfig {
    if (cred.protocol !== 'proxmox') {
      throw new Error(
        `Invalid protocol for Proxmox: ${cred.protocol}. Expected proxmox.`
      );
    }

    const { username, password, token_id, token_secret } = cred.credentials;

    if (!username) {
      throw new Error('Proxmox credentials must include username');
    }

    // Either password OR token_id+token_secret must be provided
    if (!password && !(token_id && token_secret)) {
      throw new Error(
        'Proxmox credentials must include either password or both token_id and token_secret'
      );
    }

    return {
      username,
      password,
      tokenId: token_id,
      tokenSecret: token_secret,
    };
  }

  /**
   * Validate that a credential has all required fields for its protocol
   *
   * @param cred - UnifiedCredential to validate
   * @returns True if valid, throws Error otherwise
   * @throws Error with descriptive message if validation fails
   */
  static validate(cred: UnifiedCredential): boolean {
    if (!cred.protocol) {
      throw new Error('Credential must have a protocol');
    }

    if (!cred.credentials || typeof cred.credentials !== 'object') {
      throw new Error('Credential must have a credentials object');
    }

    // Validate based on protocol
    switch (cred.protocol) {
      case 'aws_iam':
        this.toAWSCredentials(cred);
        break;

      case 'azure_sp':
        this.toAzureCredentials(cred);
        break;

      case 'gcp_sa':
        this.toGCPCredentials(cred);
        break;

      case 'ssh_key':
      case 'ssh_password':
        this.toSSHConfig(cred, 'validation-host');
        break;

      case 'snmp_v2c':
      case 'snmp_v3':
        this.toSNMPConfig(cred);
        break;

      case 'api_key':
      case 'bearer':
      case 'basic':
        this.toAPIHeaders(cred);
        break;

      case 'winrm':
        this.toWinRMConfig(cred, 'validation-host');
        break;

      case 'kubernetes':
        this.toKubernetesConfig(cred);
        break;

      case 'ldap':
        this.toLDAPConfig(cred);
        break;

      case 'redfish':
        this.toRedfishConfig(cred, 'validation-host');
        break;

      case 'proxmox':
        this.toProxmoxConfig(cred);
        break;

      case 'oauth2':
      case 'certificate':
      case 'kerberos':
        // These protocols are defined but not yet implemented
        throw new Error(`Protocol ${cred.protocol} is not yet supported by the adapter`);

      default:
        throw new Error(`Unknown protocol: ${cred.protocol}`);
    }

    return true;
  }

  /**
   * Get a list of supported protocols
   *
   * @returns Array of supported AuthProtocol values
   */
  static getSupportedProtocols(): string[] {
    return [
      'aws_iam',
      'azure_sp',
      'gcp_sa',
      'ssh_key',
      'ssh_password',
      'snmp_v2c',
      'snmp_v3',
      'api_key',
      'bearer',
      'basic',
      'winrm',
      'kubernetes',
      'ldap',
      'redfish',
      'proxmox',
    ];
  }

  /**
   * Check if a protocol is supported by this adapter
   *
   * @param protocol - Protocol to check
   * @returns True if supported, false otherwise
   */
  static isProtocolSupported(protocol: string): boolean {
    return this.getSupportedProtocols().includes(protocol);
  }
}

export default CredentialProtocolAdapter;
