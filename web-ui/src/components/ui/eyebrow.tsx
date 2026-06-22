// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import * as React from 'react';
import { Eyebrow as DsEyebrow } from '@happy-technologies/design-system';

// Brand eyebrow chip: the uppercase section-label that sits above page titles.
// Thin adapter over the design-system <Eyebrow> primitive so every screen renders
// the single source-of-truth component. The design system expresses two tones
// (accent, danger); the legacy tone names collapse onto the nearest DS tone.
type LegacyTone = 'accent' | 'coral' | 'success' | 'warning' | 'danger' | 'neutral';

export interface EyebrowProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: LegacyTone;
}

const dsTone = (tone: LegacyTone): 'accent' | 'danger' => (tone === 'danger' ? 'danger' : 'accent');

const Eyebrow = React.forwardRef<HTMLSpanElement, EyebrowProps>(
  ({ tone = 'accent', className, children, ...props }, ref) => {
    const chip = <DsEyebrow tone={dsTone(tone)}>{children}</DsEyebrow>;
    // The DS primitive owns its own styling and takes no className/ref; only wrap
    // when a caller supplies extra span attributes (none do today).
    if (!className && !ref && Object.keys(props).length === 0) return chip;
    return (
      <span ref={ref} className={className} {...props}>
        {chip}
      </span>
    );
  }
);
Eyebrow.displayName = 'Eyebrow';

export { Eyebrow };
