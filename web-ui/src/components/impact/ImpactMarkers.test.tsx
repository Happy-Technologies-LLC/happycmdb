// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import CurrentnessBadge from './CurrentnessBadge';
import ImpactBasisBanner from './ImpactBasisBanner';
import UnreportedCiMarker from './UnreportedCiMarker';
import { envelopeFixture } from '../../tests/fixtures/impactEvidence';

describe('ImpactBasisBanner', () => {
  it('states the basis, that the runtime blast radius is not established, the server note and the coverage counts', () => {
    render(<ImpactBasisBanner envelope={envelopeFixture([], ['ci-1', 'ci-2'], 7)} />);

    expect(screen.getByText('Declared graph reachability. Not a complete runtime blast radius.')).toBeInTheDocument();
    expect(screen.getByText('Runtime blast radius: not established.')).toBeInTheDocument();
    expect(
      screen.getByText('Reachability over declared DEPENDS_ON edges; no runtime observation is in scope.')
    ).toBeInTheDocument();
    expect(screen.getByText('7 CIs in scope, 2 unreported.')).toBeInTheDocument();
  });

  it('is still shown when nothing is unreported', () => {
    render(<ImpactBasisBanner envelope={envelopeFixture([], [], 1)} />);

    expect(screen.getByRole('note', { name: 'Impact basis' })).toBeInTheDocument();
    expect(screen.getByText('1 CI in scope, 0 unreported.')).toBeInTheDocument();
  });
});

describe('CurrentnessBadge', () => {
  it.each([
    ['current', 'Current'],
    ['stale', 'Stale'],
    ['contradicted', 'Contradicted'],
    ['unsupported', 'No evidence'],
  ] as const)('renders %s as the text "%s", not only a colour', (currentness, label) => {
    render(<CurrentnessBadge currentness={currentness} />);

    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe('UnreportedCiMarker', () => {
  it('has an accessible name and a title saying that its relationships may be missing', () => {
    render(<UnreportedCiMarker />);

    const marker = screen.getByRole('note', { name: /^Unreported\./ });
    expect(marker).toHaveTextContent('Unreported');
    expect(marker).toHaveAttribute('title', expect.stringMatching(/no source has reported this CI.*may be missing/i));
  });
});
