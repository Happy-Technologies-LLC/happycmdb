// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Banner } from '@happy-technologies/design-system';
import type { ImpactEnvelope } from '../../services/ci.service';

/**
 * States what an impact read is: reachability over the declared graph, not a runtime blast radius. Shown whenever
 * the envelope is present, even with nothing unreported.
 */
export function ImpactBasisBanner({ envelope }: { envelope: ImpactEnvelope }) {
  const { coverage } = envelope;
  const inScope = coverage.ci_nodes_in_scope;
  const unreported = coverage.unreported_ci_ids.length;
  return (
    <Banner tone="info" icon="info" role="note" aria-label="Impact basis">
      <span className="block font-semibold">Declared graph reachability. Not a complete runtime blast radius.</span>
      <span className="block">Runtime blast radius: not established.</span>
      <span className="block">{coverage.note}</span>
      <span className="block">
        {inScope} {inScope === 1 ? 'CI' : 'CIs'} in scope, {unreported} unreported.
      </span>
    </Banner>
  );
}

export default ImpactBasisBanner;
