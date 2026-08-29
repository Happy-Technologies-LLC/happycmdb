// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiscoveryProviderCard } from './DiscoveryProviderCard';
import type { DiscoveryStats } from '../../services/discovery.service';

const baseStats: DiscoveryStats = {
  provider: 'nmap',
  totalJobs: 6,
  successfulJobs: 5,
  failedJobs: 1,
  successRate: 83,
  totalDiscoveredCIs: 12,
};

describe('DiscoveryProviderCard optional field rendering', () => {
  it('renders "Unavailable" for average duration and "Unknown" for the schedule badge when the backend has no data for them', () => {
    render(<DiscoveryProviderCard stats={{ ...baseStats, averageDuration: undefined, enabled: undefined }} />);

    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.getByText('Unknown')).toBeTruthy();
    // Never fabricates the affirmative "Enabled" state when the provider has no registered schedule.
    expect(screen.queryByText('Enabled')).toBeNull();
  });

  it('renders the real average duration and Enabled/Disabled badge when the backend provides them', () => {
    render(<DiscoveryProviderCard stats={{ ...baseStats, averageDuration: 90000, enabled: true }} />);

    expect(screen.getByText('1m')).toBeTruthy();
    expect(screen.getByText('Enabled')).toBeTruthy();
  });

  it('shows Disabled (not the dimmed-but-unlabeled state) when the schedule is explicitly disabled', () => {
    render(<DiscoveryProviderCard stats={{ ...baseStats, averageDuration: 500, enabled: false }} />);

    expect(screen.getByText('500ms')).toBeTruthy();
    expect(screen.getByText('Disabled')).toBeTruthy();
  });
});
