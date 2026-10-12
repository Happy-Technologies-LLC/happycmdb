// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react';
import { ITSMDashboard } from './ITSMDashboard';

it('shows unavailable state instead of incident and change counts or exports', () => {
  render(<ITSMDashboard />);
  expect(screen.getByText(/ITIL incident and change records are temporarily unavailable/)).toBeVisible();
  expect(screen.queryByText('Open Incidents')).not.toBeInTheDocument();
  expect(screen.queryByText('Export PDF')).not.toBeInTheDocument();
});
