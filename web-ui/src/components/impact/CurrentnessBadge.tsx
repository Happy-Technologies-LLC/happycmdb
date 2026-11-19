// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Badge, type BadgeVariant } from '@happy-technologies/design-system';
import type { EdgeCurrentness } from '../../services/ci.service';

const CURRENTNESS: Record<EdgeCurrentness, { label: string; variant: BadgeVariant }> = {
  current: { label: 'Current', variant: 'success' },
  stale: { label: 'Stale', variant: 'warning' },
  contradicted: { label: 'Contradicted', variant: 'danger' },
  unsupported: { label: 'No evidence', variant: 'neutral' },
};

export function currentnessLabel(currentness: EdgeCurrentness): string {
  return CURRENTNESS[currentness].label;
}

/** The server's per-edge currentness as a chip. The label is always text: colour is never the only signal. */
export function CurrentnessBadge({ currentness }: { currentness: EdgeCurrentness }) {
  const { label, variant } = CURRENTNESS[currentness];
  return <Badge variant={variant}>{label}</Badge>;
}

export default CurrentnessBadge;
