// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import {
  Badge,
  Banner,
  Button,
  CopyId,
  Drawer,
  EmptyState,
  FieldList,
  SectionHeading,
  fmtDate,
  type BadgeVariant,
} from '@happy-technologies/design-system';
import { useCI, useCIAuditHistory } from '../../hooks/useCIs';
import { useCIRelationships, useImpactAnalysis } from '../../hooks/useCIRelationships';
import type { AuditLogEntry, CI, CIHealth, CIRelationship } from '../../services/ci.service';
import { QueryState } from '../estate/SurfaceState';
import CIStatusBadge from './CIStatusBadge';
import { typeLabels } from './CITypeBadge';

interface CIDrawerProps {
  /** The CI to peek at. Nothing is requested while `open` is false. */
  ciId: string;
  open: boolean;
  onClose: () => void;
  /** Opens the full record (the drawer never owns navigation). */
  onOpenFull: (ciId: string) => void;
}

/** Shown where a field has no value: never a made-up one. */
const NONE = '\u2014';

const RECENT_CHANGES = 5;
const RELATIONSHIPS_SHOWN = 8;

const HEALTH: Record<CIHealth, { label: string; tone: BadgeVariant }> = {
  healthy: { label: 'Healthy', tone: 'success' },
  degraded: { label: 'Degraded', tone: 'warning' },
  critical: { label: 'Critical', tone: 'danger' },
};

const ACTION_LABELS: Record<AuditLogEntry['action'], string> = {
  CREATE: 'Created',
  UPDATE: 'Updated',
  DELETE: 'Deleted',
  RELATIONSHIP_ADD: 'Relationship added',
  RELATIONSHIP_REMOVE: 'Relationship removed',
  DISCOVERY_UPDATE: 'Discovery update',
};

const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** Health is a signal of its own (`CI.health`); null or absent is "Unknown", never "Healthy". */
function HealthBadge({ health }: { health: CIHealth | null | undefined }) {
  const known = health ? HEALTH[health] : undefined;
  return (
    <Badge variant={known?.tone ?? 'neutral'} dot>
      <span className="sr-only">Health: </span>
      {known?.label ?? 'Unknown'}
    </Badge>
  );
}

function addressList(value: CI['ip_address']): React.ReactNode {
  const addresses = (Array.isArray(value) ? value : [value]).filter(
    (address): address is string => typeof address === 'string' && address.trim() !== ''
  );
  if (addresses.length === 0) return NONE;
  if (addresses.length === 1) return addresses[0];
  return (
    <ul className="space-y-0.5">
      {addresses.map((address) => (
        <li key={address}>{address}</li>
      ))}
    </ul>
  );
}

function CoreSection({ ci }: { ci: CI }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <HealthBadge health={ci.health} />
        <CIStatusBadge status={ci.status} />
        {ci.tier ? (
          <Badge variant="ai">
            <span className="sr-only">Tier: </span>
            {ci.tier}
          </Badge>
        ) : null}
      </div>
      {ci.description ? <Banner tone="neutral">{ci.description}</Banner> : null}
      <FieldList
        // One column: the sheet is 460px wide whatever the viewport, so FieldList's viewport breakpoints do not apply.
        style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}
        fields={[
          ['CI ID', <CopyId key="id" id={ci.id} full />],
          ['Class', typeLabels[ci.type] ?? ci.type],
          ['Environment', titleCase(ci.environment)],
          ['Provider', ci.provider || NONE],
          ['Owner', ci.owner || NONE],
          ['IP address', addressList(ci.ip_address)],
        ]}
      />
    </div>
  );
}

/** The declared dependency count of the existing impact read: not a runtime blast radius. */
function DependentsSection({ ciId }: { ciId: string }) {
  const impact = useImpactAnalysis(ciId);
  if (impact.isLoading || impact.error) {
    return (
      <QueryState
        what="dependents"
        loading={impact.isLoading}
        error={impact.error}
        onRetry={() => void impact.refetch()}
      />
    );
  }
  if (!impact.data) return null;
  const count = impact.data.downstream.length;
  return (
    <Banner tone={count > 0 ? 'warning' : 'neutral'} icon="share-network">
      <strong className="font-semibold">
        {count} {count === 1 ? 'dependent' : 'dependents'}
      </strong>
      <span className="block text-[12px] font-normal">
        Declared dependency count from the graph. Not a runtime blast radius.
      </span>
    </Banner>
  );
}

function RecentChangesSection({ ciId }: { ciId: string }) {
  const audit = useCIAuditHistory(ciId);
  const entries = React.useMemo(
    () =>
      [...(audit.data ?? [])]
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
        .slice(0, RECENT_CHANGES),
    [audit.data]
  );
  return (
    <section aria-labelledby={`ci-drawer-changes-${ciId}`}>
      <SectionHeading level={3} id={`ci-drawer-changes-${ciId}`}>
        Recent changes
      </SectionHeading>
      {audit.isLoading || audit.error ? (
        <QueryState
          what="recent changes"
          loading={audit.isLoading}
          error={audit.error}
          onRetry={() => void audit.refetch()}
        />
      ) : entries.length === 0 ? (
        <EmptyState label="No recorded changes." />
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li key={entry.id} className="text-[13px]">
              <span className="font-semibold">{ACTION_LABELS[entry.action] ?? entry.action}</span>
              <span className="text-[var(--hh-text-muted)]">
                {' '}
                by {entry.actor} on {fmtDate(entry.timestamp)}
              </span>
              {entry.changes?.length ? (
                <span className="block text-[12px] text-[var(--hh-text-muted)]">
                  {entry.changes.map((change) => change.field).join(', ')}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The other end of a relationship, with its direction from the peeked CI. */
function describeRelationship(rel: CIRelationship, ciId: string) {
  const outgoing = rel.source_ci_id === ciId;
  const other = outgoing ? rel.target_ci : rel.source_ci;
  return {
    outgoing,
    name: other?.name ?? (outgoing ? rel.target_ci_id : rel.source_ci_id),
  };
}

function RelationshipsSection({ ciId }: { ciId: string }) {
  const relationships = useCIRelationships(ciId);
  const rows = relationships.data;
  return (
    <section aria-labelledby={`ci-drawer-relationships-${ciId}`}>
      <SectionHeading
        level={3}
        id={`ci-drawer-relationships-${ciId}`}
        right={rows ? <Badge variant="info">{rows.length}</Badge> : undefined}
      >
        Relationships
      </SectionHeading>
      {relationships.isLoading || relationships.error ? (
        <QueryState
          what="relationships"
          loading={relationships.isLoading}
          error={relationships.error}
          onRetry={() => void relationships.refetch()}
        />
      ) : !rows || rows.length === 0 ? (
        <EmptyState label="No relationships." />
      ) : (
        <>
          <ul className="space-y-2">
            {rows.slice(0, RELATIONSHIPS_SHOWN).map((rel) => {
              const { outgoing, name } = describeRelationship(rel, ciId);
              return (
                <li key={rel.id} className="text-[13px]">
                  <span className="hh-mono text-[11.5px] text-[var(--hh-text-muted)]">
                    {rel.type} {outgoing ? '\u2192' : '\u2190'}
                  </span>{' '}
                  <span className="font-semibold">{name}</span>
                </li>
              );
            })}
          </ul>
          {rows.length > RELATIONSHIPS_SHOWN ? (
            <p className="mt-2 text-[12px] text-[var(--hh-text-muted)]">
              and {rows.length - RELATIONSHIPS_SHOWN} more on the full record
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * Read-only peek at one CI, opened from a list row. Every request is gated on `open` and each of the four reads
 * degrades only its own section.
 */
export const CIDrawer: React.FC<CIDrawerProps> = ({ ciId, open, onClose, onOpenFull }) => {
  const ci = useCI(ciId, open);
  return (
    <Drawer
      open={open}
      onClose={onClose}
      eyebrow="Configuration item"
      title={ci.data?.name ?? 'Configuration item'}
      recordKey={ciId}
      footer={
        <Button variant="secondary" size="md" iconRight="arrow-right" onClick={() => onOpenFull(ciId)}>
          Open full record
        </Button>
      }
    >
      {open ? (
        <div className="space-y-6">
          {ci.isLoading || ci.error || !ci.data ? (
            <QueryState
              what="this configuration item"
              loading={ci.isLoading}
              error={ci.error}
              onRetry={() => void ci.refetch()}
            />
          ) : (
            <CoreSection ci={ci.data} />
          )}
          <DependentsSection ciId={ciId} />
          <RecentChangesSection ciId={ciId} />
          <RelationshipsSection ciId={ciId} />
        </div>
      ) : null}
    </Drawer>
  );
};

export default CIDrawer;
