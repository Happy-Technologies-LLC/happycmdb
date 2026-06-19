// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useMemo, useState } from 'react';
import {
  Pencil,
  Trash2,
  ArrowLeft,
  Tag,
  Calendar,
  User,
  Network,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useCI } from '../../hooks/useCIs';
import { useCIRelationships, useImpactAnalysis } from '../../hooks/useCIRelationships';
import CIStatusBadge from './CIStatusBadge';
import CITypeBadge, { typeIcons } from './CITypeBadge';
import DependencyGraph from '../visualization/DependencyGraph';
import DriftTrackingPanel from '../drift/DriftTrackingPanel';
import AuditHistory from './AuditHistory';
import { cn } from '../../utils/cn';
import { LiquidGlass } from '../ui/liquid-glass';
import JSONViewer from '../ui/JSONViewer';
import '../ui/JSONViewer.css';
import { statusColors } from '@/lib/brandColors';

interface CIDetailProps {
  ciId: string;
  onEdit?: () => void;
  onDelete?: () => void;
  onBack?: () => void;
}

export const CIDetail: React.FC<CIDetailProps> = ({
  ciId,
  onEdit,
  onDelete,
  onBack,
}) => {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState(0);
  const [relationshipDepth, setRelationshipDepth] = useState(1);

  const { data: ci, isLoading, error } = useCI(ciId);
  const { data: relationships, isLoading: relationshipsLoading } = useCIRelationships(
    ciId,
    true,  // Always load for stats
    relationshipDepth
  );
  const { data: impactAnalysis, isLoading: impactLoading } = useImpactAnalysis(
    ciId,
    true  // Always load for stats
  );

  // Direct (depth-1) neighbors for the mockup focal-node composition. Filtering
  // keeps these correct even when the graph below is fetched at a deeper depth.
  const directUpstream = useMemo(
    () => (relationships ?? []).filter((r) => r.target_ci_id === ciId && r.source_ci),
    [relationships, ciId]
  );
  const directDownstream = useMemo(
    () => (relationships ?? []).filter((r) => r.source_ci_id === ciId && r.target_ci),
    [relationships, ciId]
  );

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else {
      navigate('/inventory');
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-sky"></div>
      </div>
    );
  }

  if (error || !ci) {
    return (
      <div className="bg-danger-soft border border-danger/30 rounded-lg p-4 text-danger">
        Failed to load configuration item details. {error?.message}
      </div>
    );
  }

  const tabs = ['Overview', 'Relationships', 'Configuration Drift', 'History'];

  return (
    <div className="space-y-6">
      {/* Header Section */}
      <LiquidGlass size="md" rounded="xl">
        <div className="flex items-start justify-between mb-4 gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <button
              onClick={handleBack}
              className="p-2 hover:bg-warm rounded-lg transition-colors mt-0.5"
              title="Back to list"
            >
              <ArrowLeft className="w-5 h-5 text-ink-soft" />
            </button>
            <span className="flex h-12 w-12 flex-none items-center justify-center rounded-md bg-sky-soft text-sky-text">
              {typeIcons[ci.type]}
            </span>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold text-navy truncate">{ci.name}</h1>
              <div className="flex gap-2 mt-2 flex-wrap">
                <CITypeBadge type={ci.type} />
                <CIStatusBadge status={ci.status} />
                <span className="inline-block px-3 py-1 text-sm border border-line rounded-full capitalize text-ink-soft">
                  {ci.environment}
                </span>
              </div>
            </div>
          </div>
          <div className="flex gap-2 flex-none">
            {onEdit && (
              <button
                onClick={onEdit}
                className="p-2 hover:bg-sky-soft rounded-lg transition-colors"
                title="Edit"
              >
                <Pencil className="w-5 h-5 text-sky-text" />
              </button>
            )}
            {onDelete && (
              <button
                onClick={onDelete}
                className="p-2 hover:bg-danger-soft rounded-lg transition-colors"
                title="Delete"
              >
                <Trash2 className="w-5 h-5 text-danger" />
              </button>
            )}
          </div>
        </div>

        {ci.description && (
          <p className="text-ink mb-6">{ci.description}</p>
        )}

        <hr className="my-6 border-line" />

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6">
          <div className="flex items-start gap-2">
            <Calendar className="w-4 h-4 text-muted-foreground mt-1" />
            <div>
              <p className="text-xs text-muted-foreground mb-1">Created</p>
              <p className="text-sm text-foreground">{formatDate(ci.created_at)}</p>
            </div>
          </div>

          <div className="flex items-start gap-2">
            <Calendar className="w-4 h-4 text-muted-foreground mt-1" />
            <div>
              <p className="text-xs text-muted-foreground mb-1">Last Updated</p>
              <p className="text-sm text-foreground">{formatDate(ci.updated_at)}</p>
            </div>
          </div>

          {ci.discovered_by && (
            <div className="flex items-start gap-2">
              <User className="w-4 h-4 text-muted-foreground mt-1" />
              <div>
                <p className="text-xs text-muted-foreground mb-1">Discovered By</p>
                <p className="text-sm text-foreground">{ci.discovered_by}</p>
              </div>
            </div>
          )}

          {ci.confidence_score !== undefined && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Confidence Score</p>
              <p className="text-sm text-foreground">
                {(ci.confidence_score * 100).toFixed(1)}%
              </p>
            </div>
          )}
        </div>

        {ci.tags && ci.tags.length > 0 && (
          <div className="mt-6">
            <div className="flex items-center gap-2 mb-2">
              <Tag className="w-4 h-4 text-muted-foreground" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Tags</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {ci.tags.map((tag) => (
                <span
                  key={tag}
                  className="px-2 py-1 bg-warm-alt text-ink rounded text-sm"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        {ci.attributes && Object.keys(ci.attributes).length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-foreground mb-3">Attributes</h3>
            <div className="bg-warm border border-line rounded-lg p-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {Object.entries(ci.attributes).map(([key, value]) => (
                  <div key={key}>
                    <p className="text-xs text-muted-foreground mb-1">{key}</p>
                    <p className="text-sm text-foreground">
                      {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </LiquidGlass>

      {/* Tabs Section */}
      <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
        <div className="border-b border-line">
          <nav className="flex -mb-px">
            {tabs.map((tab, index) => (
              <button
                key={tab}
                onClick={() => setActiveTab(index)}
                className={cn(
                  'px-6 py-3 text-sm font-medium border-b-2 transition-colors',
                  activeTab === index
                    ? 'border-sky text-navy'
                    : 'border-transparent text-ink-soft hover:text-navy hover:border-line'
                )}
              >
                {tab}
              </button>
            ))}
          </nav>
        </div>

        <div className="p-6">
          {activeTab === 0 && (
            <div className="space-y-6">
              {/* Metadata Section */}
              {ci.metadata && Object.keys(ci.metadata).length > 0 && (
                <div>
                  <h3 className="text-lg font-semibold mb-4">Metadata</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {Object.entries(ci.metadata)
                      .sort(([, a], [, b]) => {
                        // Sort: simple values first, complex values last
                        const aIsComplex = typeof a === 'object' && a !== null;
                        const bIsComplex = typeof b === 'object' && b !== null;
                        if (aIsComplex === bIsComplex) return 0;
                        return aIsComplex ? 1 : -1;
                      })
                      .map(([key, value]) => {
                        const isComplexValue = typeof value === 'object' && value !== null;

                        return (
                          <div
                            key={key}
                            className={`bg-warm border border-line rounded-lg p-4 ${
                              isComplexValue ? 'md:col-span-2 lg:col-span-3' : ''
                            }`}
                          >
                            <p className="text-xs text-muted-foreground mb-2 uppercase tracking-wider">
                              {key.replace(/_/g, ' ')}
                            </p>
                            {isComplexValue ? (
                              <JSONViewer data={value} collapsed={1} />
                            ) : (
                              <p className="text-sm text-foreground font-medium">
                                {String(value)}
                              </p>
                            )}
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Quick Stats */}
              <div>
                <h3 className="text-lg font-semibold mb-4">Quick Stats</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="rounded-lg border border-line bg-white p-4">
                    <p className="text-xs text-ink-soft mb-1 uppercase tracking-wider font-display font-semibold">Relationships</p>
                    <p className="font-display text-2xl font-extrabold text-navy">{relationships?.length || 0}</p>
                  </div>
                  <div className="rounded-lg border border-line bg-white p-4">
                    <p className="text-xs text-ink-soft mb-1 uppercase tracking-wider font-display font-semibold">Potential Impact</p>
                    <p className="font-display text-2xl font-extrabold text-navy">
                      {impactAnalysis ? (impactAnalysis.upstream.length + impactAnalysis.downstream.length) : 0}
                    </p>
                  </div>
                  <div className="rounded-lg border border-line bg-white p-4">
                    <p className="text-xs text-ink-soft mb-1 uppercase tracking-wider font-display font-semibold">Confidence Score</p>
                    <p className="font-display text-2xl font-extrabold text-navy">
                      {ci.confidence_score ? `${(ci.confidence_score * 100).toFixed(0)}%` : 'N/A'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Additional Attributes */}
              {ci.attributes && Object.keys(ci.attributes).length > 0 && (
                <div>
                  <h3 className="text-lg font-semibold mb-4">Additional Attributes</h3>
                  <div className="bg-warm border border-line rounded-lg p-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {Object.entries(ci.attributes).map(([key, value]) => (
                        <div key={key} className="border-l-2 border-sky pl-3">
                          <p className="text-xs text-muted-foreground mb-1">{key}</p>
                          <p className="text-sm text-foreground">
                            {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 1 && (
            <div>
              {relationshipsLoading ? (
                <div className="flex justify-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-sky"></div>
                </div>
              ) : relationships && relationships.length > 0 ? (
                <div className="space-y-8">
                  {/* Direct-neighbor focal topology (mockup) above the full graph */}
                  <div className="rounded-lg border border-line bg-white p-7 shadow-sm">
                    <div className="mb-1.5 flex items-center justify-between">
                      <h3 className="text-lg font-semibold text-navy">Dependency topology</h3>
                      <span className="inline-flex items-center gap-1.5 font-display text-xs text-ink-soft">
                        <Network className="h-4 w-4 text-sky-text" />
                        Neo4j · direct
                      </span>
                    </div>
                    <p className="mb-6 text-[13.5px] text-ink-soft">
                      Direct relationships from the graph. Upstream dependencies feed this CI;
                      downstream services depend on it — the basis for impact analysis.
                    </p>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center">
                      {/* Upstream — depends on */}
                      <div className="flex flex-col items-stretch gap-3.5">
                        <div className="mb-0.5 text-right font-display text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-soft">
                          Depends on
                        </div>
                        {directUpstream.length > 0 ? (
                          directUpstream.map((r) => (
                            <div key={r.id} className="flex items-center">
                              <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md border border-line bg-warm px-3 py-2.5">
                                <span className="flex-none text-sky-text">{typeIcons[r.source_ci!.type]}</span>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate font-display text-[12.5px] font-semibold text-navy">
                                    {r.source_ci!.name}
                                  </div>
                                  <div className="text-[10.5px] text-ink-soft">{r.type}</div>
                                </div>
                              </div>
                              <div className="h-0 w-[34px] flex-none border-t-2 border-dashed border-line" />
                            </div>
                          ))
                        ) : (
                          <div className="pr-[34px] text-right text-xs italic text-ink-soft">
                            No upstream dependencies
                          </div>
                        )}
                      </div>

                      {/* Focal node — navy gradient per mockup */}
                      <div className="relative z-[2] mx-2 min-w-[200px] rounded-lg bg-gradient-to-br from-navy to-navy-deep p-5 text-center text-white shadow-lg">
                        <span className="mb-3 inline-flex h-[46px] w-[46px] items-center justify-center rounded-md bg-sky/20 text-sky-light">
                          {React.cloneElement(typeIcons[ci.type], { className: 'h-6 w-6' })}
                        </span>
                        <div className="font-display text-sm font-bold leading-tight">{ci.name}</div>
                        <div className="mt-1 text-[11px] capitalize text-white/65">
                          {ci.type.replace(/-/g, ' ')} · {ci.environment}
                        </div>
                        <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 font-display text-[11px] font-semibold capitalize">
                          <span className="h-[7px] w-[7px] rounded-full" style={{ background: statusColors[ci.status] }} />
                          {ci.status}
                        </div>
                      </div>

                      {/* Downstream — impacts */}
                      <div className="flex flex-col items-stretch gap-3.5">
                        <div className="mb-0.5 text-left font-display text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-soft">
                          Impacts
                        </div>
                        {directDownstream.length > 0 ? (
                          directDownstream.map((r) => (
                            <div key={r.id} className="flex items-center">
                              <div className="h-0 w-[34px] flex-none border-t-2 border-dashed border-line" />
                              <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md border border-line bg-warm px-3 py-2.5">
                                <span className="flex-none text-sky-text">{typeIcons[r.target_ci!.type]}</span>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate font-display text-[12.5px] font-semibold text-navy">
                                    {r.target_ci!.name}
                                  </div>
                                  <div className="text-[10.5px] text-ink-soft">{r.type}</div>
                                </div>
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="pl-[34px] text-left text-xs italic text-ink-soft">
                            No downstream dependents
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <DependencyGraph
                    ciId={ciId}
                    relationships={relationships}
                    depth={relationshipDepth}
                    onDepthChange={setRelationshipDepth}
                  />
                </div>
              ) : (
                <div className="bg-sky-soft border border-sky rounded-lg p-4 text-sky-text">
                  No relationships found for this CI.
                </div>
              )}
            </div>
          )}

          {activeTab === 2 && (
            <DriftTrackingPanel ciId={ciId} ciName={ci.name} />
          )}

          {activeTab === 3 && <AuditHistory ciId={ciId} />}
        </div>
      </LiquidGlass>
    </div>
  );
};

export default CIDetail;
