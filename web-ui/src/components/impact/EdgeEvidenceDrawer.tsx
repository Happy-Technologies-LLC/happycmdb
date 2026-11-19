// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Badge, Banner, Button, DataTable, Drawer, fmtDate } from '@happy-technologies/design-system';
import { useRelationshipEvidence } from '../../hooks/useCIRelationships';
import type { EvidenceClass, ImpactEdge, RelationshipReceipt } from '../../services/ci.service';
import CurrentnessBadge from './CurrentnessBadge';

export const EVIDENCE_CLASS_LABEL: Record<EvidenceClass, string> = {
  declared: 'Declared',
  static_observed: 'Static observed',
  runtime_observed: 'Runtime observed',
  inferred: 'Inferred',
};

const classLabel = (c: EvidenceClass) => EVIDENCE_CLASS_LABEL[c] ?? c;

/** Fixed copy per refusal: the drawer never prints server text. */
function errorMessage(error: unknown): string {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  if (status === 403) return 'You do not have permission to view the evidence for this relationship.';
  if (status === 404) return 'This relationship or one of its CIs was not found.';
  return 'The receipts could not be loaded. Try again.';
}

const dash = (value: string | null | undefined) => (value ? value : '-');

const COLUMNS = [
  { header: 'Class', render: (r: RelationshipReceipt) => classLabel(r.evidence_class) },
  {
    header: 'Polarity',
    render: (r: RelationshipReceipt) => (
      <Badge variant={r.polarity === 'contradicts' ? 'danger' : 'success'}>
        {r.polarity === 'contradicts' ? 'Contradicts' : 'Supports'}
      </Badge>
    ),
  },
  {
    header: 'Source',
    render: (r: RelationshipReceipt) =>
      r.source_version ? `${dash(r.source_name)} ${r.source_version}` : dash(r.source_name),
  },
  { header: 'Method', render: (r: RelationshipReceipt) => dash(r.method) },
  { header: 'Observer', render: (r: RelationshipReceipt) => dash(r.observer) },
  {
    header: 'Observed',
    render: (r: RelationshipReceipt) => <time dateTime={r.observed_at}>{fmtDate(r.observed_at)}</time>,
  },
];

export interface EdgeEvidenceDrawerProps {
  /** The edge to show; null keeps the drawer closed and fetches nothing. */
  edge: ImpactEdge | null;
  onClose: () => void;
  /** CI names by id; an id with no name is shown as the id. */
  ciNames?: Readonly<Record<string, string>>;
}

/** Opens one edge: its class, currentness and counts as the server returned them, and its receipts (lazy, 20 a page). */
export function EdgeEvidenceDrawer({ edge, onClose, ciNames = {} }: EdgeEvidenceDrawerProps) {
  const open = edge !== null;
  const query = useRelationshipEvidence(edge?.from ?? '', edge?.to ?? '', edge?.type ?? '', open);
  const receipts = query.data?.pages.flatMap((p) => p.receipts) ?? [];
  const name = (id: string) => ciNames[id] ?? id;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      eyebrow="Relationship evidence"
      title={edge ? `${name(edge.from)} → ${name(edge.to)}` : undefined}
      icon="share-network"
      width={720}
      recordKey={edge ? `${edge.from}|${edge.to}|${edge.type}` : undefined}
    >
      {edge && (
        <div className="space-y-5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt>From</dt>
            <dd>{name(edge.from)}</dd>
            <dt>To</dt>
            <dd>{name(edge.to)}</dd>
            <dt>Type</dt>
            <dd>{edge.type}</dd>
            <dt>Currentness</dt>
            <dd>
              <CurrentnessBadge currentness={edge.currentness} />
            </dd>
            <dt>Evidence classes</dt>
            <dd>{edge.evidence.classes.length > 0 ? edge.evidence.classes.map(classLabel).join(', ') : 'None'}</dd>
            <dt>Supporting receipts</dt>
            <dd>{edge.evidence.support.supports}</dd>
            <dt>Contradicting receipts</dt>
            <dd>{edge.evidence.support.contradicts}</dd>
            <dt>Last supported</dt>
            <dd>{edge.evidence.last_supported_at ? fmtDate(edge.evidence.last_supported_at) : 'Never'}</dd>
          </dl>

          {edge.evidence.receipts_truncated && (
            <Banner tone="neutral">
              More receipts exist than the impact read scans. Currentness and counts cover the newest 200 receipts only.
            </Banner>
          )}

          {query.isError && <Banner tone="danger">{errorMessage(query.error)}</Banner>}
          {query.data ? (
            <>
              <DataTable
                caption="Receipts"
                rows={receipts}
                columns={COLUMNS}
                rowKey={(r) => r.receipt_id}
                emptyLabel="No receipts for this relationship"
              />
              {query.hasNextPage && (
                <Button variant="secondary" size="sm" loading={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
                  Load more
                </Button>
              )}
            </>
          ) : (
            query.isPending && <p role="status">Loading receipts...</p>
          )}
        </div>
      )}
    </Drawer>
  );
}

export default EdgeEvidenceDrawer;
