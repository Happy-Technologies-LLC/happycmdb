// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiz OAuth authentication module
 */

import axios from 'axios';
import { logger } from '@cmdb/common';
import { OAuthTokenResponse } from './types';

export class WizAuthManager {
  private accessToken?: string;
  private tokenExpiry?: number;

  constructor(
    private authUrl: string,
    private clientId: string,
    private clientSecret: string
  ) {}

  async authenticate(): Promise<void> {
    try {
      logger.info('Authenticating with Wiz API');

      const response = await axios.post<OAuthTokenResponse>(
        this.authUrl,
        {
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          audience: 'wiz-api',
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      this.accessToken = response.data.access_token;
      this.tokenExpiry = Date.now() + ((response.data.expires_in || 3600) * 1000);

      logger.info('Wiz authentication successful');
    } catch (error: any) {
      logger.error('Wiz authentication failed');
      throw new Error('Wiz authentication failed');
    }
  }

  async ensureValidToken(): Promise<void> {
    const now = Date.now();
    const buffer = 60000; // 60 seconds buffer

    if (!this.accessToken || !this.tokenExpiry || (this.tokenExpiry - buffer) < now) {
      await this.authenticate();
    }
  }

  getAccessToken(): string | undefined {
    return this.accessToken;
  }
}
