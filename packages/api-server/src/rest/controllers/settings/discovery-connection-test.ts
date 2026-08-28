// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery Provider Connection Testing
 *
 * Backs POST /api/v1/discovery/test-connection (DiscoverySettings.tsx).
 * Every provider genuinely attempts to verify the credentials it was
 * given -- no branch ever returns success without doing real work:
 *
 * - aws:   SigV4-signs and sends a real STS GetCallerIdentity request.
 * - azure: requests a real OAuth2 client-credentials token from Azure AD.
 * - gcp:   signs a real RS256 JWT with the service-account private key and
 *          exchanges it for a real OAuth2 token from Google.
 * - ssh:   the UI collects no target host, so live connectivity can't be
 *          tested; the private key is genuinely parsed (crypto.createPrivateKey)
 *          to catch malformed/non-PEM keys instead of a network call.
 *
 * No new runtime dependency is introduced: only Node's built-in `crypto`
 * and the `axios` the api-server package already depends on.
 */

import { createHash, createHmac, createPrivateKey, sign as cryptoSign } from 'crypto';
import axios from 'axios';

const CANONICAL_GCP_TOKEN_URI = 'https://oauth2.googleapis.com/token';

// Only these STS regions use the amazonaws.com partition constructed below.
// Rejecting everything else keeps untrusted values out of the hostname.
const AWS_STS_REGIONS: Record<string, true> = {
  'af-south-1': true,
  'ap-east-1': true,
  'ap-east-2': true,
  'ap-northeast-1': true,
  'ap-northeast-2': true,
  'ap-northeast-3': true,
  'ap-south-1': true,
  'ap-south-2': true,
  'ap-southeast-1': true,
  'ap-southeast-2': true,
  'ap-southeast-3': true,
  'ap-southeast-4': true,
  'ap-southeast-5': true,
  'ap-southeast-6': true,
  'ap-southeast-7': true,
  'ca-central-1': true,
  'ca-west-1': true,
  'eu-central-1': true,
  'eu-central-2': true,
  'eu-north-1': true,
  'eu-south-1': true,
  'eu-south-2': true,
  'eu-west-1': true,
  'eu-west-2': true,
  'eu-west-3': true,
  'il-central-1': true,
  'me-central-1': true,
  'me-south-1': true,
  'mx-central-1': true,
  'sa-east-1': true,
  'us-east-1': true,
  'us-east-2': true,
  'us-gov-east-1': true,
  'us-gov-west-1': true,
  'us-west-1': true,
  'us-west-2': true,
};

function providerFailureMessage(provider: string, status: number, response: unknown): string {
  const data = response && typeof response === 'object' ? response as Record<string, unknown> : undefined;
  const nestedError = data?.Error && typeof data.Error === 'object'
    ? data.Error as Record<string, unknown>
    : data?.GetCallerIdentityResponse && typeof data.GetCallerIdentityResponse === 'object'
      && (data.GetCallerIdentityResponse as Record<string, unknown>).Error
      && typeof (data.GetCallerIdentityResponse as Record<string, unknown>).Error === 'object'
      ? (data.GetCallerIdentityResponse as Record<string, unknown>).Error as Record<string, unknown>
      : undefined;
  const code = [nestedError?.Code, data?.error]
    .find((value): value is string => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value));

  return code
    ? `${provider} rejected the request (${code}; HTTP ${status})`
    : `${provider} rejected the request (HTTP ${status})`;
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export const DISCOVERY_PROVIDERS = ['aws', 'azure', 'gcp', 'ssh'] as const;
export type DiscoveryProvider = (typeof DISCOVERY_PROVIDERS)[number];

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function base64Url(input: Buffer | string): string {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * AWS Signature Version 4 request signing, implemented per
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 * (canonical request -> string to sign -> derived signing key -> HMAC
 * signature). Verified in discovery-connection-test.test.ts against the
 * official AWS "get-vanilla" SigV4 test vector.
 */
export function signAwsV4Request(params: {
  method: string;
  host: string;
  canonicalUri: string;
  canonicalQuerystring: string;
  payloadHash: string;
  amzDate: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
}): { authorizationHeader: string; canonicalRequest: string; stringToSign: string } {
  const {
    method,
    host,
    canonicalUri,
    canonicalQuerystring,
    payloadHash,
    amzDate,
    accessKeyId,
    secretAccessKey,
    region,
    service,
  } = params;

  const dateStamp = amzDate.slice(0, 8);
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [algorithm, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const signingKey = hmacSha256(kService, 'aws4_request');
  const signature = hmacSha256(signingKey, stringToSign).toString('hex');

  const authorizationHeader =
    `${algorithm} Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorizationHeader, canonicalRequest, stringToSign };
}

async function testAwsConnection(credentials: Record<string, unknown>): Promise<ConnectionTestResult> {
  const accessKeyId = str(credentials['accessKeyId']);
  const secretAccessKey = str(credentials['secretAccessKey']);
  if (!accessKeyId || !secretAccessKey) {
    return { success: false, message: 'AWS credentials must include accessKeyId and secretAccessKey' };
  }

  const region = str(credentials['region']) || 'us-east-1';
  if (!Object.hasOwn(AWS_STS_REGIONS, region)) {
    return { success: false, message: 'AWS region must be a supported STS region' };
  }
  const service = 'sts';
  const host = `sts.${region}.amazonaws.com`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const canonicalQuerystring = 'Action=GetCallerIdentity&Version=2011-06-15';

  const { authorizationHeader } = signAwsV4Request({
    method: 'GET',
    host,
    canonicalUri: '/',
    canonicalQuerystring,
    payloadHash: sha256Hex(''),
    amzDate,
    accessKeyId,
    secretAccessKey,
    region,
    service,
  });

  try {
    const response = await axios.get(`https://${host}/?${canonicalQuerystring}`, {
      headers: {
        'X-Amz-Date': amzDate,
        Authorization: authorizationHeader,
        Accept: 'application/json',
      },
      timeout: 8000,
      validateStatus: () => true,
    });

    if (response.status === 200) {
      const result = response.data?.GetCallerIdentityResponse?.GetCallerIdentityResult;
      return {
        success: true,
        message: 'AWS credentials verified via STS GetCallerIdentity',
        details: result
          ? { arn: result.Arn, account: result.Account, userId: result.UserId }
          : undefined,
      };
    }

    return {
      success: false,
      message: providerFailureMessage('AWS STS', response.status, response.data),
    };
  } catch {
    return { success: false, message: 'Unable to reach AWS STS' };
  }
}

async function testAzureConnection(credentials: Record<string, unknown>): Promise<ConnectionTestResult> {
  const tenantId = str(credentials['tenantId']);
  const clientId = str(credentials['clientId']);
  const clientSecret = str(credentials['clientSecret']);
  if (!tenantId || !clientId || !clientSecret) {
    return { success: false, message: 'Azure credentials must include tenantId, clientId, and clientSecret' };
  }

  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://management.azure.com/.default',
  });

  try {
    const response = await axios.post(url, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 8000,
      validateStatus: () => true,
    });

    if (response.status === 200 && response.data?.access_token) {
      return {
        success: true,
        message: 'Azure service principal authenticated successfully',
        details: { tokenType: response.data.token_type, expiresIn: response.data.expires_in },
      };
    }

    return {
      success: false,
      message: providerFailureMessage('Azure AD', response.status, response.data),
    };
  } catch {
    return { success: false, message: 'Unable to reach Azure AD' };
  }
}

async function testGcpConnection(credentials: Record<string, unknown>): Promise<ConnectionTestResult> {
  const rawCredentials = credentials['credentials'];
  let serviceAccount: Record<string, unknown>;
  try {
    const parsed = typeof rawCredentials === 'string' ? JSON.parse(rawCredentials) : rawCredentials;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('not an object');
    }
    serviceAccount = parsed as Record<string, unknown>;
  } catch {
    return { success: false, message: 'GCP service account credentials must be valid JSON' };
  }

  const clientEmail = str(serviceAccount['client_email']);
  const privateKey = str(serviceAccount['private_key']);
  const suppliedTokenUri = str(serviceAccount['token_uri']);
  if (suppliedTokenUri && suppliedTokenUri !== CANONICAL_GCP_TOKEN_URI) {
    return { success: false, message: `GCP token_uri must be ${CANONICAL_GCP_TOKEN_URI}` };
  }
  const tokenUri = CANONICAL_GCP_TOKEN_URI;
  if (!clientEmail || !privateKey) {
    return { success: false, message: 'GCP service account JSON must include client_email and private_key' };
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(
    JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: tokenUri,
      exp: now + 3600,
      iat: now,
    })
  );
  const unsigned = `${header}.${claims}`;

  let signature: string;
  try {
    signature = base64Url(cryptoSign('RSA-SHA256', Buffer.from(unsigned), privateKey));
  } catch (error) {
    return {
      success: false,
      message: `Invalid GCP private key: ${error instanceof Error ? error.message : 'unable to sign JWT'}`,
    };
  }

  const assertion = `${unsigned}.${signature}`;

  try {
    const response = await axios.post(
      tokenUri,
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 8000,
        validateStatus: () => true,
      }
    );

    if (response.status === 200 && response.data?.access_token) {
      return {
        success: true,
        message: 'GCP service account authenticated successfully',
        details: { projectId: serviceAccount['project_id'] || credentials['projectId'] },
      };
    }
    return {
      success: false,
      message: providerFailureMessage('Google token endpoint', response.status, response.data),
    };
  } catch {
    return { success: false, message: 'Unable to reach Google token endpoint' };
  }
}

async function testSshConnection(credentials: Record<string, unknown>): Promise<ConnectionTestResult> {
  const username = str(credentials['username']);
  const privateKeyPem = str(credentials['privateKey']);
  if (!username) {
    return { success: false, message: 'SSH credentials must include a username' };
  }
  if (!privateKeyPem) {
    return { success: false, message: 'SSH credentials must include a private key' };
  }

  try {
    createPrivateKey({ key: privateKeyPem, format: 'pem' });
  } catch (error) {
    return {
      success: false,
      message: `Invalid SSH private key: ${error instanceof Error ? error.message : 'unable to parse key'}`,
    };
  }

  return {
    success: true,
    message: 'SSH private key is well-formed. Provide a target host during discovery to verify live connectivity.',
  };
}

export async function testDiscoveryProviderConnection(
  provider: string,
  credentials: Record<string, unknown>
): Promise<ConnectionTestResult> {
  switch (provider) {
    case 'aws':
      return testAwsConnection(credentials);
    case 'azure':
      return testAzureConnection(credentials);
    case 'gcp':
      return testGcpConnection(credentials);
    case 'ssh':
      return testSshConnection(credentials);
    default:
      return { success: false, message: `Unsupported provider: ${provider}` };
  }
}
