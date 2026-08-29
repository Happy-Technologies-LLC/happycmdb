// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for discovery-connection-test.ts
 *
 * signAwsV4Request is verified against the official AWS SigV4
 * "get-vanilla" test vector (aws-c-auth / botocore's aws4_testsuite),
 * not a value this suite invented -- see the inline citation below. The
 * per-provider testDiscoveryProviderConnection() functions are exercised
 * against a mocked axios so no real network call happens.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { generateKeyPairSync } from 'crypto';

jest.mock('axios');

import axios from 'axios';
import { settingsSchemas } from '../../../../validation/schemas';
import { signAwsV4Request, testDiscoveryProviderConnection } from '../discovery-connection-test';

const mockedAxiosGet = axios.get as jest.Mock;
const mockedAxiosPost = axios.post as jest.Mock;

describe('signAwsV4Request', () => {
  it('matches the official AWS SigV4 "get-vanilla" test vector', () => {
    // Source: https://github.com/awslabs/aws-c-auth (aws-sig-v4-test-suite),
    // mirrored at boto/botocore tests/unit/auth/aws4_testsuite/get-vanilla/.
    // GET / HTTP/1.1, Host: example.amazonaws.com, X-Amz-Date: 20150830T123600Z
    // AccessKey=AKIDEXAMPLE, SecretKey=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY,
    // region=us-east-1, service=service, no query string, empty body.
    const { authorizationHeader, canonicalRequest, stringToSign } = signAwsV4Request({
      method: 'GET',
      host: 'example.amazonaws.com',
      canonicalUri: '/',
      canonicalQuerystring: '',
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      amzDate: '20150830T123600Z',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 'service',
    });

    expect(canonicalRequest).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'x-amz-date:20150830T123600Z',
        '',
        'host;x-amz-date',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ].join('\n')
    );

    expect(stringToSign).toBe(
      [
        'AWS4-HMAC-SHA256',
        '20150830T123600Z',
        '20150830/us-east-1/service/aws4_request',
        'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
      ].join('\n')
    );

    expect(authorizationHeader).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
    );
  });

  it('is deterministic for identical inputs', () => {
    const params = {
      method: 'GET',
      host: 'sts.us-east-1.amazonaws.com',
      canonicalUri: '/',
      canonicalQuerystring: 'Action=GetCallerIdentity&Version=2011-06-15',
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      amzDate: '20240101T000000Z',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret',
      region: 'us-east-1',
      service: 'sts',
    };

    expect(signAwsV4Request(params)).toEqual(signAwsV4Request(params));
  });
});

describe('testDiscoveryProviderConnection', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('aws', () => {
    it('reports failure without attempting a network call when credentials are incomplete', async () => {
      const result = await testDiscoveryProviderConnection('aws', { accessKeyId: 'AKIA123' });
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/accessKeyId and secretAccessKey/);
      expect(mockedAxiosGet).not.toHaveBeenCalled();
    });

    it.each(['localhost', '169.254.169.254', 'us-west-2.evil.com', 'us-west-2/../../evil', 'invalid-region'])(
      'rejects unsafe AWS region %s without dispatching a request',
      async (region) => {
        const result = await testDiscoveryProviderConnection('aws', {
          accessKeyId: 'AKIA123',
          secretAccessKey: 'secret',
          region,
        });

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/region/i);
        expect(mockedAxiosGet).not.toHaveBeenCalled();
      }
    );

    it('reports success when STS returns 200 with a caller identity', async () => {
      mockedAxiosGet.mockResolvedValue({
        status: 200,
        data: {
          GetCallerIdentityResponse: {
            GetCallerIdentityResult: { Arn: 'arn:aws:iam::123456789012:user/test', Account: '123456789012' },
          },
        },
      });

      const result = await testDiscoveryProviderConnection('aws', {
        accessKeyId: 'AKIA123',
        secretAccessKey: 'secret',
        region: 'us-west-2',
      });

      expect(result.success).toBe(true);
      expect(result.details).toEqual(
        expect.objectContaining({ arn: 'arn:aws:iam::123456789012:user/test' })
      );
      expect(mockedAxiosGet).toHaveBeenCalledWith(
        expect.stringContaining('sts.us-west-2.amazonaws.com'),
        expect.any(Object)
      );
    });

    it('returns the bounded AWS provider error code when STS rejects credentials', async () => {
      mockedAxiosGet.mockResolvedValue({
        status: 403,
        data: { Error: { Code: 'InvalidClientTokenId', Message: 'The security token included in the request is invalid.' } },
      });

      const result = await testDiscoveryProviderConnection('aws', {
        accessKeyId: 'AKIA123',
        secretAccessKey: 'wrong-secret',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('InvalidClientTokenId');
      expect(result.message).not.toContain('security token included in the request is invalid');
    });

    it('returns only a bounded AWS error code, not the provider response body', async () => {
      mockedAxiosGet.mockResolvedValue({
        status: 403,
        data: { Error: { Code: 'InvalidClientTokenId', Message: 'sensitive provider response body' } },
      });

      const result = await testDiscoveryProviderConnection('aws', {
        accessKeyId: 'AKIA123',
        secretAccessKey: 'wrong-secret',
      });

      expect(result.message).toContain('InvalidClientTokenId');
      expect(result.message).not.toContain('sensitive provider response body');
    });
  });

  describe('azure', () => {
    it('reports failure when required fields are missing', async () => {
      const result = await testDiscoveryProviderConnection('azure', { clientId: 'x' });
      expect(result.success).toBe(false);
      expect(mockedAxiosPost).not.toHaveBeenCalled();
    });

    it('reports success when Azure AD returns an access token', async () => {
      mockedAxiosPost.mockResolvedValue({
        status: 200,
        data: { access_token: 'token', token_type: 'Bearer', expires_in: 3600 },
      });

      const result = await testDiscoveryProviderConnection('azure', {
        tenantId: 'tenant',
        clientId: 'client',
        clientSecret: 'secret',
      });

      expect(result.success).toBe(true);
    });

    it('returns the bounded Azure AD provider error code on failure', async () => {
      mockedAxiosPost.mockResolvedValue({
        status: 401,
        data: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' },
      });

      const result = await testDiscoveryProviderConnection('azure', {
        tenantId: 'tenant',
        clientId: 'client',
        clientSecret: 'wrong',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid_client');
      expect(result.message).not.toContain('Invalid client secret provided');
    });
  });

  describe('gcp', () => {
    it('reports failure when the pasted credentials are not valid JSON', async () => {
      const result = await testDiscoveryProviderConnection('gcp', { credentials: 'not-json' });
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/valid JSON/);
      expect(mockedAxiosPost).not.toHaveBeenCalled();
    });

    it('reports failure when the service account is missing required fields', async () => {
      const result = await testDiscoveryProviderConnection('gcp', {
        credentials: JSON.stringify({ project_id: 'p' }),
      });
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/client_email and private_key/);
    });

    it.each([
      'http://oauth2.googleapis.com/token',
      'https://localhost/token',
      'https://169.254.169.254/latest/meta-data',
      'https://evil.googleapis.com/token',
    ])('rejects unsafe token_uri %s without dispatching a request', async (tokenUri) => {
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      });

      const result = await testDiscoveryProviderConnection('gcp', {
        credentials: JSON.stringify({
          client_email: 'service-account@example.iam.gserviceaccount.com',
          private_key: privateKey,
          token_uri: tokenUri,
        }),
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/token_uri/i);
      expect(mockedAxiosPost).not.toHaveBeenCalled();
    });

    it('uses the canonical Google token endpoint for valid service account credentials', async () => {
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      });
      mockedAxiosPost.mockResolvedValue({ status: 200, data: { access_token: 'token' } });

      const result = await testDiscoveryProviderConnection('gcp', {
        credentials: JSON.stringify({
          client_email: 'service-account@example.iam.gserviceaccount.com',
          private_key: privateKey,
          token_uri: 'https://oauth2.googleapis.com/token',
        }),
      });

      expect(result.success).toBe(true);
      expect(mockedAxiosPost).toHaveBeenCalledWith(
        'https://oauth2.googleapis.com/token',
        expect.any(String),
        expect.any(Object)
      );
    });
  });

  describe('ssh', () => {
    it('reports failure for a malformed private key', async () => {
      const result = await testDiscoveryProviderConnection('ssh', {
        username: 'root',
        privateKey: 'not-a-real-key',
      });
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Invalid SSH private key/);
    });

    it('reports success for a well-formed private key without dialing a host', async () => {
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      });

      const result = await testDiscoveryProviderConnection('ssh', {
        username: 'root',
        privateKey,
      });

      expect(result.success).toBe(true);
    });
  });

  describe('test connection validation schema', () => {
    it.each([
      {
        provider: 'aws',
        credentials: { accessKeyId: 'AKIA123', secretAccessKey: 'secret', region: 'us-west-2.evil.com' },
      },
      {
        provider: 'gcp',
        credentials: {
          credentials: JSON.stringify({ token_uri: 'http://oauth2.googleapis.com/token' }),
        },
      },
    ])('rejects unsafe provider endpoint input at the Joi edge', (payload) => {
      expect(settingsSchemas.testConnection.validate(payload).error).toBeDefined();
    });

    it('accepts canonical AWS and GCP endpoint inputs', () => {
      expect(
        settingsSchemas.testConnection.validate({
          provider: 'aws',
          credentials: { accessKeyId: 'AKIA123', secretAccessKey: 'secret', region: 'us-west-2' },
        }).error
      ).toBeUndefined();
      expect(
        settingsSchemas.testConnection.validate({
          provider: 'gcp',
          credentials: {
            credentials: JSON.stringify({ token_uri: 'https://oauth2.googleapis.com/token' }),
          },
        }).error
      ).toBeUndefined();
    });
  });

  it('reports failure for an unsupported provider', async () => {
    const result = await testDiscoveryProviderConnection('unsupported', {});
    expect(result.success).toBe(false);
  });
});
