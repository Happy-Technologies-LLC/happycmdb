// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { NOT_AVAILABLE } from '@/lib/dashboardValue';

interface UnavailableNoticeProps {
  /** What is missing, e.g. "Cost trends". */
  label: string;
}

/** Explicit empty state for a dashboard section that has no backing data. */
export const UnavailableNotice: React.FC<UnavailableNoticeProps> = ({ label }) => (
  <p role="status" className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
    {label}: {NOT_AVAILABLE}
  </p>
);
