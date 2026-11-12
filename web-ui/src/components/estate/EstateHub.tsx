// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  SectionHeading,
  SegmentedControl,
} from '@happy-technologies/design-system';
import { Stage, StageChip } from '@happy-technologies/design-system/ai';
import { RequirePermission } from '@/components/common/RequirePermission';
import CIStatusBadge from '@/components/ci/CIStatusBadge';
import CITypeBadge from '@/components/ci/CITypeBadge';
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  SAMPLE_NODE_CAP,
  buildSample,
  categoryCounts,
  categoryOf,
  classifyError,
  type Category,
} from '@/lib/estate';
import ciService, { type CI } from '@/services/ci.service';
import { getRelationshipSample } from '@/services/estate.service';
import { EstateKpis } from './EstateKpis';
import { GraphMap } from './GraphMap';
import { IncidentRibbon } from './IncidentRibbon';
import { OrbitMap } from './OrbitMap';
import { NotShipped, QueryState } from './SurfaceState';

type View = 'orbit' | 'graph' | 'list';
const VIEWS: ReadonlyArray<readonly [View, string]> = [
  ['orbit', 'Orbit'],
  ['graph', 'Graph'],
  ['list', 'List'],
];
const CHIP_TONE: Record<Category, 'accent' | 'ai' | 'success' | 'neutral'> = {
  services: 'accent',
  apps: 'ai',
  data: 'success',
  infra: 'neutral',
};
const asView = (value: string | null): View =>
  VIEWS.some(([v]) => v === value) ? (value as View) : 'orbit';

/**
 * HAP-1252 S2 (HAP-1916): the estate hub. Incident ribbon, the Stage (Orbit, Graph or List, ME2/ME3) beside the KPI
 * stack, then live changes and top services. The view is the `?view=` search parameter, so a link or a reload keeps
 * it. Every surface has its own loading, error, 403 and empty state; a function whose backend is not on main says so
 * (see the table in the PR) instead of showing a number.
 */
export function EstateHub() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = asView(params.get('view'));
  const [filter, setFilter] = useState<Category | null>(null);

  const stats = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: () => ciService.getDashboardStats(),
    staleTime: 60000,
  });
  const cis = useQuery({
    queryKey: ['estate', 'cis'],
    queryFn: () => ciService.getCIs({ limit: SAMPLE_NODE_CAP }),
  });
  const relationships = useQuery({
    queryKey: ['estate', 'relationships'],
    queryFn: getRelationshipSample,
  });

  const sample = useMemo(
    () => buildSample(cis.data?.data ?? [], relationships.data?.rows ?? []),
    [cis.data, relationships.data]
  );
  const counts = stats.data ? categoryCounts(stats.data.by_type) : null;
  const openCi = (id: string) => navigate(`/cis/${encodeURIComponent(id)}`);
  const setView = (next: View) => setParams({ view: next }, { replace: true });

  const relationshipNote = relationships.error
    ? `Relationships not shown: ${classifyError(relationships.error).message}`
    : relationships.data
      ? `${relationships.data.total.toLocaleString('en-US')} ${relationships.data.total === 1 ? 'relationship' : 'relationships'}`
      : null;
  const total = cis.data?.total ?? 0;

  const chip = (category: Category) => (
    <StageChip
      key={category}
      tone={CHIP_TONE[category]}
      active={filter === category}
      onClick={() => setFilter(filter === category ? null : category)}
    >
      {CATEGORY_LABEL[category]}
      {counts ? ` · ${counts[category].toLocaleString('en-US')}` : ''}
    </StageChip>
  );
  const legend = (
    <>
      {CATEGORY_ORDER.map(chip)}
      <StageChip tone="danger" title="A critical flag needs a CI health state (BW1)">
        Critical · not available yet
      </StageChip>
    </>
  );

  const ready = !cis.isLoading && !cis.error && total > 0;
  const rows = (cis.data?.data ?? []).filter(
    (ci: CI) => filter === null || categoryOf(ci.type) === filter
  );

  let canvas;
  if (ready && view !== 'list') {
    canvas = (
      <Stage
        aria-label="Live topology"
        eyebrow="Estate topology"
        title={view === 'orbit' ? 'Your estate, in orbit' : 'Dependency graph'}
        subtitle={[
          `${total.toLocaleString('en-US')} CIs`,
          relationshipNote,
          `${sample.nodes.length.toLocaleString('en-US')} shown`,
        ]
          .filter(Boolean)
          .join(' · ')}
        controls={
          <div role="group" aria-label="View mode" className="flex gap-1">
            {VIEWS.map(([v, label]) => (
              <Button
                key={v}
                size="sm"
                variant={view === v ? 'white' : 'outline-on-dark'}
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {label}
              </Button>
            ))}
          </div>
        }
        legend={legend}
      >
        {view === 'orbit' ? (
          <OrbitMap sample={sample} filter={filter} onOpen={openCi} />
        ) : (
          <GraphMap sample={sample} filter={filter} onOpen={openCi} />
        )}
      </Stage>
    );
  } else {
    canvas = (
      <Card className="grid content-start gap-4">
        <div className="flex items-center justify-between gap-3">
          <SectionHeading className="mb-0">Configuration items</SectionHeading>
          <SegmentedControl<View>
            aria-label="View mode"
            value={view}
            onChange={setView}
            options={VIEWS.map(([value, label]) => ({ value, label }))}
          />
        </div>
        {cis.isLoading || cis.error ? (
          <QueryState
            what="configuration items"
            loading={cis.isLoading}
            error={cis.error}
            onRetry={() => void cis.refetch()}
          />
        ) : total === 0 ? (
          <EmptyState
            icon="cube"
            title="No configuration items yet"
            description="Run discovery or add a CI to populate the estate."
            action={
              <RequirePermission permission="write">
                <Button size="sm" onClick={() => navigate('/discovery')}>
                  Run discovery
                </Button>
              </RequirePermission>
            }
          />
        ) : (
          <>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Category filter">
              {CATEGORY_ORDER.map((category) => (
                <Button
                  key={category}
                  size="sm"
                  variant={filter === category ? 'primary' : 'secondary'}
                  aria-pressed={filter === category}
                  onClick={() => setFilter(filter === category ? null : category)}
                >
                  {CATEGORY_LABEL[category]}
                </Button>
              ))}
            </div>
            <DataTable
              rows={rows}
              rowKey={(ci) => ci.id}
              onRowClick={(ci) => openCi(ci.id)}
              caption="Configuration items"
              note={`${rows.length} of ${total.toLocaleString('en-US')} CIs (first ${SAMPLE_NODE_CAP} by name). Provider, owner and health are not available yet (BW1, BW2).`}
              emptyLabel="No CIs of this category in the first page."
              columns={[
                { header: 'CI', render: (ci) => <span className="hh-mono">{ci.name}</span> },
                { header: 'Class', render: (ci) => <CITypeBadge type={ci.type} size="small" /> },
                { header: 'Environment', render: (ci) => ci.environment },
                {
                  header: 'Status',
                  render: (ci) => <CIStatusBadge status={ci.status} size="small" />,
                },
              ]}
            />
          </>
        )}
      </Card>
    );
  }

  return (
    <div className="grid gap-5">
      <IncidentRibbon />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {canvas}
        <EstateKpis
          stats={stats.data}
          loading={stats.isLoading}
          error={stats.error}
          onRetry={() => void stats.refetch()}
        />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card as="section" aria-label="Live changes">
          <SectionHeading right={<Badge variant="neutral">Not available yet</Badge>}>
            Live changes
          </SectionHeading>
          <NotShipped
            title="No tenant-wide change feed"
            missing="Needs a recent-changes endpoint for the whole estate (BW9). Today a CI's history needs its id and the timeline returns daily counts."
          />
        </Card>
        <Card as="section" aria-label="Top services">
          <SectionHeading right={<Badge variant="neutral">Not available yet</Badge>}>
            Top services
          </SectionHeading>
          <NotShipped
            title="No service availability"
            missing="Needs 24-hour availability per business service (BW10). The services themselves are listed under Business services."
            action={
              <Button size="sm" variant="secondary" onClick={() => navigate('/business-services')}>
                Open business services
              </Button>
            }
          />
        </Card>
      </div>
    </div>
  );
}
