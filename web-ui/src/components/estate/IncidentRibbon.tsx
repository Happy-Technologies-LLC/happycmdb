// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Banner, Button, Skeleton } from '@happy-technologies/design-system';
import { classifyError, incidentFacts, leadIncident, shortIncidentNumber } from '@/lib/estate';
import { getOpenIncidents } from '@/services/estate.service';

/**
 * ME1: the open-incident ribbon. Source: GET /itil/incidents (BW8 is partly on main: the list exists, the users and
 * revenue figures are never filled in, so they show only when an incident carries one). "Analyze impact" belongs to
 * the impact flow (S3); until then the action opens the affected CI.
 */
export function IncidentRibbon() {
  const navigate = useNavigate();
  const incidents = useQuery({ queryKey: ['estate', 'incidents'], queryFn: getOpenIncidents });

  if (incidents.isLoading)
    return <Skeleton className="h-12 w-full" role="status" aria-label="Loading incidents" />;

  if (incidents.error) {
    const failure = classifyError(incidents.error);
    return (
      <Banner tone="warning" icon={failure.kind === 'forbidden' ? 'lock-key' : 'warning-circle'}>
        {failure.kind === 'forbidden'
          ? `Incidents are not available to you: ${failure.message}`
          : `Could not load open incidents: ${failure.message}`}{' '}
        <Button size="sm" variant="secondary" onClick={() => void incidents.refetch()}>
          Try again
        </Button>
      </Banner>
    );
  }

  const lead = leadIncident(incidents.data?.rows ?? []);
  if (!lead) {
    return (
      <Banner tone="success" icon="check-circle">
        No open incidents.
      </Banner>
    );
  }
  const others = (incidents.data?.total ?? 1) - 1;
  return (
    <Banner tone="danger" icon="warning-circle" className="min-w-0 [&>span:last-child]:flex-1">
      <span className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate">
          <strong className="hh-mono" title={lead.incident_number}>
            {shortIncidentNumber(lead.incident_number)}
          </strong>{' '}
          {lead.title}
          <span className="opacity-80">
            {' · '}
            {incidentFacts(lead, Date.now()).join(' · ')}
            {others > 0 ? ` · ${others} more open` : ''}
          </span>
        </span>
        {lead.affected_ci_id && (
          <Button
            variant="cta"
            size="sm"
            iconRight="arrow-right"
            className="flex-none"
            onClick={() => navigate(`/cis/${encodeURIComponent(lead.affected_ci_id as string)}`)}
          >
            Open affected CI
          </Button>
        )}
      </span>
    </Banner>
  );
}
