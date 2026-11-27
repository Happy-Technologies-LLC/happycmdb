// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useId, useMemo, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  FieldList,
  Icon,
  IconButton,
  PageHeader,
  SectionHeading,
  Skeleton,
  Stat,
  TabPanel,
  Tabs,
  Tag,
} from '@happy-technologies/design-system';
import { useNavigate } from 'react-router-dom';
import { useCI } from '../../hooks/useCIs';
import { useCIRelationships, useImpactEnvelope } from '../../hooks/useCIRelationships';
import type { CIRelationship, ImpactEdge } from '../../services/ci.service';
import CurrentnessBadge from '../impact/CurrentnessBadge';
import EdgeEvidenceDrawer from '../impact/EdgeEvidenceDrawer';
import ImpactBasisBanner from '../impact/ImpactBasisBanner';
import UnreportedCiMarker from '../impact/UnreportedCiMarker';
import { edgeKey, indexEdges } from '../impact/edgeKey';
import { QueryState } from '../estate/SurfaceState';
import CIStatusBadge from './CIStatusBadge';
import CITypeBadge, { typeIcons } from './CITypeBadge';
import DriftTrackingPanel from '../drift/DriftTrackingPanel';
import AuditHistory from './AuditHistory';
import JSONViewer from '../ui/JSONViewer';
import '../ui/JSONViewer.css';
import { statusColors } from '@/lib/brandColors';
import { RequirePermission } from '@/components/common/RequirePermission';

interface CIDetailProps {
  ciId: string;
  onEdit?: () => void;
  onDelete?: () => void;
  onBack?: () => void;
}

type TabId = 'overview' | 'relationships' | 'drift' | 'history';

const TABS: Array<{ value: TabId; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'relationships', label: 'Relationships' },
  { value: 'drift', label: 'Configuration Drift' },
  { value: 'history', label: 'History' },
];

const httpStatus = (error: unknown): number | undefined =>
  (error as { response?: { status?: number } } | null)?.response?.status;

/** Display text of an attribute or metadata value; FieldList hides empty values, so an empty string says so. */
const scalarText = (value: unknown): string => {
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text === '' ? '(empty)' : text;
};

const isComplex = (value: unknown): boolean => typeof value === 'object' && value !== null;

const formatDate = (dateString: string) =>
  new Date(dateString).toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const FIGURE_SKELETON = <Skeleton className="h-8 w-12" />;

export const CIDetail: React.FC<CIDetailProps> = ({
  ciId,
  onEdit,
  onDelete,
  onBack,
}) => {
  const navigate = useNavigate();
  const tabsId = useId();
  const [activeTab, setActiveTab] = useState<TabId>('overview');

  const { data: ci, isLoading, error, refetch } = useCI(ciId);
  const {
    data: relationships,
    isLoading: relationshipsLoading,
    error: relationshipsError,
    refetch: refetchRelationships,
  } = useCIRelationships(
    ciId,
    true  // Always load for stats
  );
  const {
    data: impact,
    isPending: impactPending,
    isError: impactError,
    refetch: refetchImpact,
  } = useImpactEnvelope(
    ciId,
    true  // Always load for stats
  );
  const impactAnalysis = impact?.data;
  const envelope = impact?.envelope ?? null;
  const [evidenceEdge, setEvidenceEdge] = useState<ImpactEdge | null>(null);

  // Direct (depth-1) neighbors for the mockup focal-node composition.
  const directUpstream = useMemo(
    () => (relationships ?? []).filter((r) => r.target_ci_id === ciId && r.source_ci),
    [relationships, ciId]
  );
  const directDownstream = useMemo(
    () => (relationships ?? []).filter((r) => r.source_ci_id === ciId && r.target_ci),
    [relationships, ciId]
  );

  // The server qualifies DEPENDS_ON edges only; a relationship with no entry here gets no badge and no drawer.
  const edgeIndex = useMemo(() => indexEdges(envelope?.edges), [envelope]);
  const unreportedIds = useMemo(
    () => new Set(envelope?.coverage.unreported_ci_ids ?? []),
    [envelope]
  );
  const focalUnreported = unreportedIds.has(ciId);
  const ciNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const r of relationships ?? []) {
      if (r.source_ci) names[r.source_ci_id] = r.source_ci.name;
      if (r.target_ci) names[r.target_ci_id] = r.target_ci.name;
    }
    if (ci) names[ciId] = ci.name;
    return names;
  }, [relationships, ci, ciId]);

  const renderEdgeMeta = (r: CIRelationship, neighbourId: string) => {
    const edge = edgeIndex.get(edgeKey(r.source_ci_id, r.target_ci_id, r.type));
    const unreported = unreportedIds.has(neighbourId);
    if (!edge && !unreported) return null;
    return (
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {unreported && <UnreportedCiMarker />}
        {edge && <CurrentnessBadge currentness={edge.currentness} />}
        {edge && (
          <Button
            variant="link"
            size="sm"
            aria-label={`View evidence: ${ciNames[edge.from] ?? edge.from} ${edge.type} ${ciNames[edge.to] ?? edge.to}`}
            onClick={() => setEvidenceEdge(edge)}
          >
            Evidence
          </Button>
        )}
      </div>
    );
  };

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else {
      navigate('/inventory');
    }
  };

  const backButton = (
    <Button variant="secondary" icon="arrow-left" onClick={handleBack}>
      Back to list
    </Button>
  );

  if (isLoading) {
    return <QueryState what="this configuration item" loading />;
  }

  if (!ci && (!error || httpStatus(error) === 404)) {
    return (
      <EmptyState
        icon="magnifying-glass"
        title="Configuration item not found"
        description="It may have been deleted, or the link is wrong."
        action={backButton}
      />
    );
  }

  if (error || !ci) {
    return (
      <div className="space-y-4">
        <QueryState
          what="this configuration item"
          error={error}
          onRetry={() => void refetch()}
        />
        <div className="flex justify-center">{backButton}</div>
      </div>
    );
  }

  const headerFields: Array<[string, React.ReactNode]> = [
    ['Created', formatDate(ci.created_at)],
    ['Last Updated', formatDate(ci.updated_at)],
    ['Discovered By', ci.discovered_by],
    [
      'Confidence Score',
      ci.confidence_score != null ? `${(ci.confidence_score * 100).toFixed(1)}%` : undefined,
    ],
  ];
  const attributeFields: Array<[string, React.ReactNode]> = Object.entries(ci.attributes ?? {}).map(
    ([key, value]) => [key, scalarText(value)]
  );
  const metadataEntries = Object.entries(ci.metadata ?? {});
  const simpleMetadata = metadataEntries.filter(([, value]) => !isComplex(value));
  const complexMetadata = metadataEntries.filter(([, value]) => isComplex(value));

  // A count is a figure only once its read has answered; a failed or pending read is never shown as zero.
  const figure = (value: number | null, loading: boolean): React.ReactNode =>
    value !== null ? value : loading ? FIGURE_SKELETON : 'N/A';
  const relationshipCount = relationships ? relationships.length : null;
  const impactCount = impactAnalysis
    ? impactAnalysis.upstream.length + impactAnalysis.downstream.length
    : null;

  const renderRelationships = () => {
    if (relationshipsError) {
      return (
        <QueryState
          what="relationships"
          error={relationshipsError}
          onRetry={() => void refetchRelationships()}
        />
      );
    }
    if (relationshipsLoading || (impactPending && !(relationships && relationships.length > 0))) {
      return <QueryState what="relationships" loading />;
    }

    const impactUnavailable = impactError && !impact && (
      <Banner tone="warning" icon="warning">
        The impact basis could not be loaded, so coverage and per-edge currentness are not shown.{' '}
        <Button size="sm" variant="secondary" onClick={() => void refetchImpact()}>
          Try again
        </Button>
      </Banner>
    );

    if (!relationships || relationships.length === 0) {
      return (
        <div className="space-y-4">
          {impactUnavailable}
          {envelope && <ImpactBasisBanner envelope={envelope} />}
          <Banner tone="info" icon="info">
            {focalUnreported ? (
              <>
                <span className="mr-2">
                  <UnreportedCiMarker />
                </span>
                No relationships reported for this CI; coverage is incomplete.
              </>
            ) : (
              'No relationships found for this CI.'
            )}
          </Banner>
        </div>
      );
    }

    return (
      <div className="space-y-8">
        {impactUnavailable}
        {envelope && <ImpactBasisBanner envelope={envelope} />}
        <Card as="section">
          <SectionHeading
            className="mb-1.5"
            right={
              <span className="inline-flex items-center gap-1.5 text-xs text-[var(--hh-text-muted)]">
                <Icon name="share-network" size={16} className="text-[var(--hh-accent-text)]" />
                Neo4j · direct
              </span>
            }
          >
            Dependency topology
          </SectionHeading>
          <p className="mb-6 text-[13.5px] text-[var(--hh-text-muted)]">
            Direct relationships from the graph. Upstream dependencies feed this CI;
            downstream services depend on it - the basis for impact analysis.
          </p>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center">
            {/* Upstream - depends on */}
            <div className="flex flex-col items-stretch gap-3.5">
              <div className="mb-0.5 text-right text-[10.5px] font-bold uppercase tracking-[0.08em] text-[var(--hh-text-muted)]">
                Depends on
              </div>
              {directUpstream.length > 0 ? (
                directUpstream.map((r) => (
                  <div key={r.id} className="flex items-center">
                    <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md border border-[var(--hh-hairline)] bg-[var(--hh-bg-elevated)] px-3 py-2.5">
                      <span className="flex-none text-[var(--hh-accent-text)]">{typeIcons[r.source_ci!.type]}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] font-semibold text-[var(--hh-text-primary)]">
                          {r.source_ci!.name}
                        </div>
                        <div className="text-[10.5px] text-[var(--hh-text-muted)]">{r.type}</div>
                        {renderEdgeMeta(r, r.source_ci_id)}
                      </div>
                    </div>
                    <div className="h-0 w-[34px] flex-none border-t-2 border-dashed border-[var(--hh-border-field)]" />
                  </div>
                ))
              ) : (
                <div className="pr-[34px] text-right text-xs italic text-[var(--hh-text-muted)]">
                  No upstream dependencies
                </div>
              )}
            </div>

            {/* Focal node: navy in both themes (the DS navy hero idiom) */}
            <div className="relative z-[2] mx-2 min-w-[200px] rounded-lg bg-gradient-to-br from-[var(--hh-navy)] to-[var(--hh-navy-deep)] p-5 text-center text-[var(--hh-on-dark-text)] shadow-lg">
              <span className="mb-3 inline-flex h-[46px] w-[46px] items-center justify-center rounded-md bg-[var(--hh-on-dark-bg)]">
                {React.cloneElement(typeIcons[ci.type], { size: 24 })}
              </span>
              <div className="text-sm font-bold leading-tight">{ci.name}</div>
              <div className="mt-1 text-[11px] capitalize opacity-70">
                {ci.type.replace(/-/g, ' ')} · {ci.environment}
              </div>
              <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[var(--hh-on-dark-bg)] px-2.5 py-1 text-[11px] font-semibold capitalize">
                <span className="h-[7px] w-[7px] rounded-full" style={{ background: statusColors[ci.status] }} />
                {ci.status}
              </div>
              {focalUnreported && (
                <div className="mt-2">
                  <UnreportedCiMarker variant="on-dark" />
                </div>
              )}
            </div>

            {/* Downstream - impacts */}
            <div className="flex flex-col items-stretch gap-3.5">
              <div className="mb-0.5 text-left text-[10.5px] font-bold uppercase tracking-[0.08em] text-[var(--hh-text-muted)]">
                Impacts
              </div>
              {directDownstream.length > 0 ? (
                directDownstream.map((r) => (
                  <div key={r.id} className="flex items-center">
                    <div className="h-0 w-[34px] flex-none border-t-2 border-dashed border-[var(--hh-border-field)]" />
                    <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md border border-[var(--hh-hairline)] bg-[var(--hh-bg-elevated)] px-3 py-2.5">
                      <span className="flex-none text-[var(--hh-accent-text)]">{typeIcons[r.target_ci!.type]}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] font-semibold text-[var(--hh-text-primary)]">
                          {r.target_ci!.name}
                        </div>
                        <div className="text-[10.5px] text-[var(--hh-text-muted)]">{r.type}</div>
                        {renderEdgeMeta(r, r.target_ci_id)}
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="pl-[34px] text-left text-xs italic text-[var(--hh-text-muted)]">
                  No downstream dependents
                </div>
              )}
            </div>
          </div>
        </Card>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header Section */}
      <Card as="section" className="space-y-6">
        <div className="flex items-start gap-3">
          <IconButton
            icon="arrow-left"
            variant="ghost"
            aria-label="Back to list"
            onClick={handleBack}
            className="mt-1"
          />
          <span className="flex h-12 w-12 flex-none items-center justify-center rounded-md bg-[var(--hh-accent-bg)] text-[var(--hh-accent-text)]">
            {typeIcons[ci.type]}
          </span>
          <div className="min-w-0 flex-1 space-y-3">
            <PageHeader
              eyebrow="Configuration item"
              title={ci.name}
              actions={
                (onEdit || onDelete) && (
                  <RequirePermission permission="write">
                    {onEdit && (
                      <Button variant="secondary" icon="pencil-simple" onClick={onEdit}>
                        Edit
                      </Button>
                    )}
                    {onDelete && (
                      <Button variant="danger" icon="trash" onClick={onDelete}>
                        Delete
                      </Button>
                    )}
                  </RequirePermission>
                )
              }
            />
            <div className="flex flex-wrap gap-2">
              <CITypeBadge type={ci.type} />
              <CIStatusBadge status={ci.status} />
              <Badge variant="neutral" className="capitalize">
                {ci.environment}
              </Badge>
            </div>
          </div>
        </div>

        {ci.description && <p>{ci.description}</p>}

        <FieldList fields={headerFields} className="md:grid-cols-4 lg:grid-cols-4" />

        {ci.tags && ci.tags.length > 0 && (
          <div>
            <p className="hh-heading mb-2 text-[length:var(--hh-text-2xs)] text-[var(--hh-text-muted)]">Tags</p>
            <div className="flex flex-wrap gap-2">
              {ci.tags.map((tag) => (
                <Tag key={tag}>{tag}</Tag>
              ))}
            </div>
          </div>
        )}

        {attributeFields.length > 0 && (
          <div>
            <SectionHeading level={2}>Attributes</SectionHeading>
            <FieldList fields={attributeFields} />
          </div>
        )}
      </Card>

      {/* Tabs Section */}
      <Card as="section" inset="none" className="overflow-hidden">
        <div className="border-b border-[var(--hh-hairline)] p-3">
          <Tabs
            id={tabsId}
            value={activeTab}
            onChange={setActiveTab}
            options={TABS}
            aria-label="Configuration item sections"
          />
        </div>

        <div className="p-6">
          <TabPanel tabsId={tabsId} value="overview" selected={activeTab === 'overview'}>
            {activeTab === 'overview' && (
              <div className="space-y-6">
                {metadataEntries.length > 0 && (
                  <div>
                    <SectionHeading>Metadata</SectionHeading>
                    <div className="space-y-4">
                      {simpleMetadata.length > 0 && (
                        <FieldList
                          fields={simpleMetadata.map(([key, value]): [string, React.ReactNode] => [
                            key.replace(/_/g, ' '),
                            scalarText(value),
                          ])}
                        />
                      )}
                      {complexMetadata.map(([key, value]) => (
                        <div key={key} className="rounded-lg bg-[var(--hh-bg-elevated)] p-4">
                          <p className="hh-heading mb-2 text-[length:var(--hh-text-2xs)] text-[var(--hh-text-muted)]">
                            {key.replace(/_/g, ' ')}
                          </p>
                          <JSONViewer data={value} collapsed={1} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <SectionHeading>Quick Stats</SectionHeading>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                    <Card>
                      <Stat
                        size="sm"
                        align="left"
                        label="Relationships"
                        value={figure(relationshipCount, relationshipsLoading)}
                      />
                    </Card>
                    <Card>
                      <Stat
                        size="sm"
                        align="left"
                        label="Potential Impact"
                        value={figure(impactCount, impactPending)}
                      />
                    </Card>
                    <Card>
                      <Stat
                        size="sm"
                        align="left"
                        label="Confidence Score"
                        value={
                          ci.confidence_score != null
                            ? `${(ci.confidence_score * 100).toFixed(0)}%`
                            : 'N/A'
                        }
                      />
                    </Card>
                  </div>
                </div>

                {attributeFields.length > 0 && (
                  <div>
                    <SectionHeading>Additional Attributes</SectionHeading>
                    <FieldList fields={attributeFields} />
                  </div>
                )}
              </div>
            )}
          </TabPanel>

          <TabPanel tabsId={tabsId} value="relationships" selected={activeTab === 'relationships'}>
            {activeTab === 'relationships' && renderRelationships()}
          </TabPanel>

          <TabPanel tabsId={tabsId} value="drift" selected={activeTab === 'drift'}>
            {activeTab === 'drift' && <DriftTrackingPanel ciId={ciId} ciName={ci.name} />}
          </TabPanel>

          <TabPanel tabsId={tabsId} value="history" selected={activeTab === 'history'}>
            {activeTab === 'history' && <AuditHistory ciId={ciId} />}
          </TabPanel>
        </div>
      </Card>
      <EdgeEvidenceDrawer edge={evidenceEdge} onClose={() => setEvidenceEdge(null)} ciNames={ciNames} />
    </div>
  );
};

export default CIDetail;
