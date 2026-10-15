// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { BaselineService } from '../baseline.service';

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: jest.fn(),
  getPostgresClient: jest.fn(),
}));

it('refuses standalone restore before accessing a baseline or mutating a CI', async () => {
  await expect(new BaselineService().restoreFromBaseline('ci-a', 'baseline-a', 'operator'))
    .rejects.toThrow('Baseline restore unavailable until journal admission');
  expect(getPostgresClient).not.toHaveBeenCalled();
  expect(getNeo4jClient).not.toHaveBeenCalled();
});
