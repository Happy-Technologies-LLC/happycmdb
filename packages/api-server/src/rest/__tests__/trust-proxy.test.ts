// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import { applyTrustProxy } from '../trust-proxy';

/** HAP-1091: TRUST_PROXY -> Express `trust proxy`; anything but a hop count or an address list trusts no proxy. */
describe('applyTrustProxy', () => {
  it.each<[unknown, unknown]>([
    [undefined, false],
    ['', false],
    ['0', false],
    [false, false],
    ['1', 1],
    [2, 2],
    [' 10.0.0.0/8, loopback ', ['10.0.0.0/8', 'loopback']],
    [true, false],
    ['true', false],
    ['-1', false],
    [1.5, false],
    ['10.0.0.300', false],
    ['10.0.0.0/8,', false],
  ])('%p -> %p', (value, expected) => {
    const app = express();
    applyTrustProxy(app, value);
    expect(app.get('trust proxy')).toEqual(expected);
  });
});
