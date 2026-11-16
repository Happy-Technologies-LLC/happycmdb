// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-2033: GET /api/v1/cis/:id/impact emits impact_score on a 0-1 scale
// (min(totalImpacted / 10, 1)); the chart must show it as a percentage.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ImpactChart } from './ImpactChart';
import type { CI, ImpactAnalysis } from '@/services/ci.service';

afterEach(cleanup);

const ci = (id: string): CI => ({
  id,
  name: id,
  type: 'server',
  status: 'active',
  environment: 'production',
  attributes: {},
});

const analysis = (impact_score: number, upstream = 1, downstream = 2): ImpactAnalysis => ({
  ci: ci('root'),
  upstream: Array.from({ length: upstream }, (_, i) => ci(`up-${i}`)),
  downstream: Array.from({ length: downstream }, (_, i) => ci(`down-${i}`)),
  impact_score,
  affected_environments: ['production'],
});

describe('ImpactChart impact score display', () => {
  it('shows a 0-1 score of 0.3 as 30.0%, in both the headline and the alert', () => {
    render(<ImpactChart data={analysis(0.3)} />);
    expect(screen.getByText('30.0%')).toBeInTheDocument();
    expect(screen.getByText(/impact score of 30\.0%\./)).toBeInTheDocument();
  });

  it('shows the saturated score 1 as 100.0% and rates it high', () => {
    render(<ImpactChart data={analysis(1, 6, 6)} />);
    expect(screen.getByText('100.0%')).toBeInTheDocument();
    expect(screen.getByText('HIGH')).toBeInTheDocument();
  });

  it('shows 0 as 0.0% and rates it low', () => {
    render(<ImpactChart data={analysis(0, 0, 0)} />);
    expect(screen.getByText('0.0%')).toBeInTheDocument();
    expect(screen.getByText('LOW')).toBeInTheDocument();
  });
});
