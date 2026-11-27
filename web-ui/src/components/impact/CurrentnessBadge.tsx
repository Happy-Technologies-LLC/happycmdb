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

type CurrentnessEntry = { label: string; variant: BadgeVariant };

/**
 * A value outside the four known ones (the server adds one before the UI learns it, or a malformed
 * body) must not throw during render: it gets a neutral chip carrying the raw value as text.
 */
function entryFor(currentness: EdgeCurrentness): CurrentnessEntry {
  const known: CurrentnessEntry | undefined = Object.hasOwn(CURRENTNESS, currentness)
    ? CURRENTNESS[currentness]
    : undefined;
  if (known) return known;
  const raw: unknown = currentness;
  return { label: typeof raw === 'string' && raw !== '' ? raw : 'Unknown', variant: 'neutral' };
}

export function currentnessLabel(currentness: EdgeCurrentness): string {
  return entryFor(currentness).label;
}

/** The server's per-edge currentness as a chip. The label is always text: colour is never the only signal. */
export function CurrentnessBadge({ currentness }: { currentness: EdgeCurrentness }) {
  const { label, variant } = entryFor(currentness);
  return <Badge variant={variant}>{label}</Badge>;
}

export default CurrentnessBadge;
