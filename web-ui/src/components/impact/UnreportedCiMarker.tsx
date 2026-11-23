// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Badge, type BadgeVariant } from '@happy-technologies/design-system';

export const UNREPORTED_CI_TEXT =
  'No source has reported this CI, so its relationships may be missing from the graph.';

/** Marks a CI that no source has reported: absence of relationships on it is not evidence of none. */
export function UnreportedCiMarker({ variant = 'warning' }: { variant?: BadgeVariant }) {
  return (
    <Badge variant={variant} role="note" aria-label={`Unreported. ${UNREPORTED_CI_TEXT}`} title={UNREPORTED_CI_TEXT}>
      Unreported
    </Badge>
  );
}

export default UnreportedCiMarker;
