// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { Button, Card, NativeSelect, PageHeader, SectionHeading } from '@happy-technologies/design-system';

export interface RangeOption {
  value: string;
  label: string;
}

/**
 * The header shared by the Executive and CIO dashboards: eyebrow, title, the time-range select, the two exports
 * and a refresh. Presentation only: the caller owns the range state, the query and the export calls.
 */
export function DashboardHeader({
  eyebrow,
  title,
  lede,
  range,
  ranges,
  onRangeChange,
  onExportPdf,
  onExportExcel,
  onRefresh,
}: {
  eyebrow: string;
  title: string;
  lede: string;
  range: string;
  ranges: readonly RangeOption[];
  onRangeChange: (value: string) => void;
  onExportPdf: () => void;
  onExportExcel: () => void;
  onRefresh: () => void;
}) {
  return (
    <PageHeader
      eyebrow={eyebrow}
      title={title}
      lede={lede}
      actions={
        <>
          <NativeSelect
            aria-label="Time range"
            size="sm"
            value={range}
            onChange={(event) => onRangeChange(event.target.value)}
          >
            {ranges.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
          <Button variant="outline" size="sm" icon="download-simple" onClick={onExportPdf}>
            Export PDF
          </Button>
          <Button variant="outline" size="sm" icon="download-simple" onClick={onExportExcel}>
            Export Excel
          </Button>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            Refresh
          </Button>
        </>
      }
    />
  );
}

/**
 * A titled dashboard section: a real h2 and a one-line description over the content. `flush` drops the card for
 * content that brings its own (a DataTable), so the table is not boxed twice.
 */
export function DashboardSection({
  title,
  description,
  flush = false,
  children,
}: {
  title: string;
  description?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}) {
  const body = (
    <>
      <SectionHeading level={2} className="mb-1!">
        {title}
      </SectionHeading>
      {description && <p className="mb-4 text-sm text-[var(--hh-text-muted)]">{description}</p>}
      {children}
    </>
  );
  return flush ? <section>{body}</section> : <Card as="section">{body}</Card>;
}
