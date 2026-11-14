// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unified Credential Type Definitions
 *
 * Protocol-based credential system that replaces provider-specific credentials
 * with standard authentication protocols. This allows credentials to be reused
 * across different providers and supports credential sets with affinity matching.
 */

/**
 * Standard Authentication Protocols
 * Based on industry standards, not vendor-specific implementations
 */
export type AuthProtocol =
  | 'oauth2'           // OAuth 2.0 (client credentials, authorization code, etc.)
  | 'api_key'          // API key/token authentication
  | 'basic'            // HTTP Basic Auth (username/password)
  | 'bearer'           // Bearer token
  | 'aws_iam'          // AWS IAM (access key + secret)
  | 'azure_sp'         // Azure Service Principal
  | 'gcp_sa'           // GCP Service Account
  | 'ssh_key'          // SSH public/private key
  | 'ssh_password'     // SSH username/password
  | 'certificate'      // X.509 certificate
  | 'kerberos'         // Kerberos authentication
  | 'snmp_v2c'         // SNMP v2c community string
  | 'snmp_v3'          // SNMP v3 with USM
  | 'winrm'            // Windows Remote Management
  | 'kubernetes'       // Kubernetes authentication (token, kubeconfig)
  | 'redfish'          // Redfish API (iDRAC, iLO, XCC - username/password)
  | 'ldap'             // LDAP/Active Directory authentication
  | 'proxmox'          // Proxmox VE (username@realm + password or API token)
  | 'tenable'          // Tenable.io (access key + secret key)
  | 'veeam'            // Veeam Enterprise Manager (username/password with session token)
  | 'wiz'              // Wiz Cloud Security (OAuth 2.0 client credentials)
  | 'infoblox';        // Infoblox WAPI (username/password with HTTPS)

/**
 * Credential Scope - Where can this credential be used?
 */
export type CredentialScope =
  | 'cloud_provider'   // Cloud platform (AWS, Azure, GCP)
  | 'ssh'              // SSH/WinRM access
  | 'api'              // REST/GraphQL API access
  | 'network'          // Network device (SNMP, NETCONF)
  | 'database'         // Database connection
  | 'container'        // Container runtime (Docker, Kubernetes)
  | 'virtualization'   // Hypervisor/VM platform (VMware, Proxmox, Hyper-V)
  | 'universal';       // Can be used anywhere

/**
 * Validation Status
 */
export type ValidationStatus = 'valid' | 'invalid' | 'expired' | 'unknown';

/**
 * Credential Affinity - Hints for credential selection
 * Used to prioritize which credentials to try first
 */
export interface CredentialAffinity {
  /** Target networks (CIDR notation) - e.g., ['10.0.0.0/8', '192.168.1.0/24'] */
  networks?: string[];

  /** Hostname patterns (glob or regex) - e.g., ['*.prod.company.com', 'db-*'] */
  hostname_patterns?: string[];

  /** Operating systems - e.g., ['linux', 'windows', 'cisco-ios'] */
  os_types?: string[];

  /** Device types - e.g., ['router', 'switch', 'firewall', 'server'] */
  device_types?: string[];

  /** Environments - e.g., ['production', 'staging'] */
  environments?: string[];

  /** Cloud providers - e.g., ['aws', 'azure', 'gcp'] */
  cloud_providers?: string[];

  /** Priority for selection (1-10, higher = try first) */
  priority?: number;
}

/**
 * Unified Credential Structure
 */
export interface UnifiedCredential {
  /** Unique identifier */
  id: string;

  /** User-friendly name */
  name: string;

  /** Optional description */
  description?: string;

  /** Standard authentication protocol */
  protocol: AuthProtocol;

  /** Where this credential can be used */
  scope: CredentialScope;

  /**
   * Encrypted credential data
   * Structure varies by protocol:
   *
   * oauth2: {
   *   client_id: string,
   *   client_secret: string,
   *   token_url: string,
   *   scopes?: string[]
   * }
   *
   * api_key: {
   *   key: string,
   *   header_name?: string,
   *   query_param?: string
   * }
   *
   * basic: {
   *   username: string,
   *   password: string
   * }
   *
   * bearer: {
   *   token: string
   * }
   *
   * aws_iam: {
   *   access_key_id: string,
   *   secret_access_key: string,
   *   region?: string,
   *   session_token?: string
   * }
   *
   * azure_sp: {
   *   client_id: string,
   *   client_secret: string,
   *   tenant_id: string,
   *   subscription_id?: string
   * }
   *
   * gcp_sa: {
   *   project_id: string,
   *   private_key: string,
   *   client_email: string,
   *   type: 'service_account',
   *   ...additional service account fields
   * }
   *
   * ssh_key: {
   *   username: string,
   *   private_key: string,
   *   passphrase?: string,
   *   port?: number
   * }
   *
   * ssh_password: {
   *   username: string,
   *   password: string,
   *   port?: number
   * }
   *
   * certificate: {
   *   certificate: string,
   *   private_key: string,
   *   passphrase?: string,
   *   ca_certificate?: string
   * }
   *
   * kerberos: {
   *   principal: string,
   *   keytab?: string,
   *   password?: string,
   *   realm: string
   * }
   *
   * snmp_v2c: {
   *   community_string: string
   * }
   *
   * snmp_v3: {
   *   username: string,
   *   auth_protocol: 'MD5' | 'SHA',
   *   auth_password: string,
   *   priv_protocol: 'DES' | 'AES',
   *   priv_password: string
   * }
   *
   * winrm: {
   *   username: string,
   *   password: string,
   *   port?: number,
   *   transport?: 'http' | 'https'
   * }
   *
   * kubernetes: {
   *   kubeconfig_content?: string,   // Full kubeconfig YAML content
   *   server?: string,                // Kubernetes API server URL
   *   token?: string,                 // Bearer token
   *   certificate_authority?: string, // CA certificate (base64)
   *   namespace?: string,             // Default namespace
   *   skip_tls_verify?: boolean       // Skip TLS verification
   * }
   *
   * ldap: {
   *   domain: string,                 // LDAP://dc.example.com or LDAPS://dc.example.com
   *   base_dn: string,                // DC=example,DC=com
   *   username: string,               // admin@example.com or CN=admin,DC=example,DC=com
   *   password: string,               // Password
   *   use_ssl?: boolean,              // Use LDAPS (default: true)
   *   port?: number                   // LDAP port (default: 389 or 636 for SSL)
   * }
   *
   * proxmox: {
   *   username: string,               // user@pam or user@pve
   *   password?: string,              // Password (for ticket-based auth)
   *   token_id?: string,              // API token ID (alternative to password)
   *   token_secret?: string           // API token secret (alternative to password)
   * }
   *
   * redfish: {
   *   username: string,               // iDRAC/iLO/XCC username (default: root)
   *   password: string,               // Password
   *   verify_ssl?: boolean,           // Verify SSL certificates (default: false)
   *   timeout?: number                // Request timeout in milliseconds (default: 30000)
   * }
   *
   * tenable: {
   *   access_key: string,             // Tenable.io API access key
   *   secret_key: string,             // Tenable.io API secret key
   *   api_url?: string                // API URL (default: https://cloud.tenable.com)
   * }
   *
   * veeam: {
   *   username: string,               // Veeam Enterprise Manager username
   *   password: string,               // Password
   *   verify_ssl?: boolean            // Verify SSL certificates (default: false)
   * }
   *
   * wiz: {
   *   client_id: string,              // Wiz Service Account client ID
   *   client_secret: string,          // Wiz Service Account client secret
   *   auth_url?: string,              // OAuth token endpoint (default: https://auth.app.wiz.io/oauth/token)
   *   api_url?: string                // GraphQL API endpoint (default: https://api.us1.app.wiz.io/graphql)
   * }
   *
   * infoblox: {
   *   username: string,               // Infoblox username
   *   password: string,               // Password
   *   wapi_version?: string,          // WAPI version (default: v2.12)
   *   verify_ssl?: boolean            // Verify SSL certificates (default: false)
   * }
   */
  credentials: Record<string, any>;

  /**
   * Affinity hints for credential selection
   * Used by NMAP and other tools to try credentials in order
   */
  affinity: CredentialAffinity;

  /** Tags for organization */
  tags: string[];

  /** User who created this credential */
  created_by: string;

  /** Timestamp when credential was created */
  created_at: Date;

  /** Timestamp when credential was last updated */
  updated_at: Date;

  /** Optional: Last time credential was validated */
  last_validated_at?: Date;

  /** Optional: Validation status */
  validation_status?: ValidationStatus;
}

/**
 * Credential Input - Data for creating a new credential
 */
export interface UnifiedCredentialInput {
  /** User-friendly name */
  name: string;

  /** Optional description */
  description?: string;

  /** Standard authentication protocol */
  protocol: AuthProtocol;

  /** Where this credential can be used */
  scope: CredentialScope;

  /** Unencrypted credential data (will be encrypted on storage) */
  credentials: Record<string, any>;

  /** Affinity hints for credential selection */
  affinity?: CredentialAffinity;

  /** Tags for organization */
  tags?: string[];
}

/**
 * Credential Update Input - Data for updating an existing credential
 */
export interface UnifiedCredentialUpdateInput {
  /** Updated name */
  name?: string;

  /** Updated description */
  description?: string;

  /** Updated credential data (will be re-encrypted) */
  credentials?: Record<string, any>;

  /** Updated affinity hints */
  affinity?: CredentialAffinity;

  /** Updated tags */
  tags?: string[];
}

/**
 * Credential Summary - Lightweight credential info without sensitive data
 */
export interface UnifiedCredentialSummary {
  /** Unique identifier */
  id: string;

  /** User-friendly name */
  name: string;

  /** Optional description */
  description?: string;

  /** Standard authentication protocol */
  protocol: AuthProtocol;

  /** Where this credential can be used */
  scope: CredentialScope;

  /** Affinity hints (non-sensitive) */
  affinity: CredentialAffinity;

  /** Tags */
  tags: string[];

  /** Creation timestamp */
  created_at: Date;

  /** Last update timestamp */
  updated_at: Date;

  /** Last validation timestamp */
  last_validated_at?: Date;

  /** Validation status */
  validation_status?: ValidationStatus;

  /** Number of discovery definitions using this credential */
  usage_count?: number;

  /** Number of connector configurations using this credential */
  connector_usage_count?: number;
}

/**
 * Credential Set Strategy
 */
export type CredentialSetStrategy =
  | 'sequential'   // Try credentials in order, one at a time
  | 'parallel'     // Try all credentials simultaneously
  | 'adaptive';    // Learn from past successes and adapt order

/**
 * Credential Set - Group of credentials to try in order
 * Used by NMAP and SSH discovery for credential rotation
 */
export interface CredentialSet {
  /** Unique identifier */
  id: string;

  /** User-friendly name */
  name: string;

  /** Optional description */
  description?: string;

  /** Ordered list of credential IDs to try */
  credential_ids: string[];

  /** Strategy for trying credentials */
  strategy: CredentialSetStrategy;

  /** Stop after first success (default: true) */
  stop_on_success: boolean;

  /** Tags for organization */
  tags: string[];

  /** User who created this set */
  created_by: string;

  /** Timestamp when set was created */
  created_at: Date;

  /** Timestamp when set was last updated */
  updated_at: Date;
}

/**
 * Credential Set Input - Data for creating a new credential set
 */
export interface CredentialSetInput {
  /** User-friendly name */
  name: string;

  /** Optional description */
  description?: string;

  /** Ordered list of credential IDs to try */
  credential_ids: string[];

  /** Strategy for trying credentials */
  strategy?: CredentialSetStrategy;

  /** Stop after first success */
  stop_on_success?: boolean;

  /** Tags for organization */
  tags?: string[];
}

/**
 * Credential Set Update Input
 */
export interface CredentialSetUpdateInput {
  /** Updated name */
  name?: string;

  /** Updated description */
  description?: string;

  /** Updated credential IDs */
  credential_ids?: string[];

  /** Updated strategy */
  strategy?: CredentialSetStrategy;

  /** Updated stop_on_success */
  stop_on_success?: boolean;

  /** Updated tags */
  tags?: string[];
}

/**
 * A credential set that does not exist for the caller (missing, or owned by someone else). Controllers branch on the
 * class, never on the message: a decode failure's message can quote decrypted plaintext (HAP-1834).
 */
export class CredentialSetNotFoundError extends Error {
  constructor(id: string) {
    super(`Credential set with ID ${id} not found`);
    this.name = 'CredentialSetNotFoundError';
  }
}

/**
 * Credential Set Summary - Lightweight info with expanded credential details
 */
export interface CredentialSetSummary {
  /** Unique identifier */
  id: string;

  /** User-friendly name */
  name: string;

  /** Optional description */
  description?: string;

  /** List of credentials in this set (summaries, not full credentials) */
  credentials: UnifiedCredentialSummary[];

  /** Strategy */
  strategy: CredentialSetStrategy;

  /** Stop after first success */
  stop_on_success: boolean;

  /** Tags */
  tags: string[];

  /** Creation timestamp */
  created_at: Date;

  /** Last update timestamp */
  updated_at: Date;

  /** Number of discovery definitions using this set */
  usage_count?: number;
}

/**
 * Credential Match Result - Result of affinity matching
 */
export interface CredentialMatchResult {
  /** The credential that matched */
  credential: UnifiedCredential;

  /** Match score: sum of matched affinity rule points plus priority × 2 (1 when nothing matched; max 140). Not 0-100. */
  score: number;

  /** Reasons for the match */
  reasons: string[];
}

/**
 * Credential Match Context - Context for credential selection
 */
export interface CredentialMatchContext {
  /** Target IP address or CIDR */
  ip?: string;

  /** Target hostname */
  hostname?: string;

  /** Detected OS type */
  os_type?: string;

  /** Device type */
  device_type?: string;

  /** Environment */
  environment?: string;

  /** Cloud provider */
  cloud_provider?: string;

  /** Required protocol */
  required_protocol?: AuthProtocol;

  /** Required scope */
  required_scope?: CredentialScope;
}

/**
 * Credential Validation Result
 */
export interface CredentialValidationResult {
  /** Whether the credential is valid */
  valid: boolean;

  /** Validation message */
  message: string;

  /** Timestamp of validation */
  validated_at: Date;

  /** Additional details */
  details?: Record<string, any>;
}
