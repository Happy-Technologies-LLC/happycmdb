// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import CurrentnessBadge, { currentnessLabel } from './CurrentnessBadge';
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

  it('renders each known value with its own variant, and "No evidence" as the neutral one', () => {
    const classOf = (currentness: 'current' | 'stale' | 'contradicted' | 'unsupported', label: string) => {
      const { unmount } = render(<CurrentnessBadge currentness={currentness} />);
      const cls = screen.getByText(label).className;
      unmount();
      return cls;
    };
    const classes = [
      classOf('current', 'Current'),
      classOf('stale', 'Stale'),
      classOf('contradicted', 'Contradicted'),
      classOf('unsupported', 'No evidence'),
    ];

    expect(new Set(classes).size).toBe(4);
  });

  it('renders an unknown value as a neutral badge carrying the raw value, without throwing', () => {
    const { unmount } = render(<CurrentnessBadge currentness="unsupported" />);
    const neutralClass = screen.getByText('No evidence').className;
    unmount();

    render(<CurrentnessBadge currentness={'archived' as never} />);

    expect(screen.getByText('archived').className).toBe(neutralClass);
    expect(currentnessLabel('archived' as never)).toBe('archived');
  });

  it('does not resolve inherited object keys as known values', () => {
    render(<CurrentnessBadge currentness={'toString' as never} />);

    expect(screen.getByText('toString')).toBeInTheDocument();
    expect(currentnessLabel('constructor' as never)).toBe('constructor');
  });

  it.each([
    ['an empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['a number', 7],
  ])('renders %s as "Unknown"', (_name, value) => {
    render(<CurrentnessBadge currentness={value as never} />);

    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(currentnessLabel(value as never)).toBe('Unknown');
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
