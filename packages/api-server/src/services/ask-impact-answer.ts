// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1928 (UX-4b BW13, decision N4 (a)): the deterministic `happy-ui/v1` answer to the impact question on one CI.
 *
 * No model, no randomness, no conversation memory and no I/O: the same prediction, business context and recommendations
 * always give the same lines. The answer is composed only from what the read-only impact reads already return
 * (`previewChangeImpact`, `loadImpactBusinessContext`, `deriveImpactRecommendations`), so it adds no new fact.
 *
 * Wire format (JSON Lines, the design system's `stream.ts`): `begin`, one `text`, the effects, the nodes, `end`.
 *
 *  - text: one plain-text summary line (risk, dependents, services).
 *  - effects: `select` and `focus` of the source CI, so the topology moves to it, then `highlight` of the dependent CIs
 *    (risk tone) when there are any. A CI id longer than the catalog's 64 characters is left out of `highlight`.
 *  - nodes (catalog `happy.core@1`), in this order, a node only when it has data:
 *      `kpis` StatGroup: Risk (always), Dependent CIs (always), Cost per hour (only when a service has revenue recorded;
 *      a lower bound says how many services priced it), Estimated downtime (only when the change type has an estimate).
 *      `services` ImpactChain: the affected business services by criticality (at most 12).
 *      `chain` ImpactChain: the longest dependency chain from the CI (at most 12).
 *      `unavailable` Text: what was left out for lack of data. A value with no backing data is omitted; a figure that is backed by data is shown as it is, 0 included.
 *      `basis` Text: the declared-graph coverage note (not a runtime blast radius).
 *      `recommendations-heading` Text and `rec-<rule id>` Callouts: the rule-based recommendations, in rule order.
 */

import { COVERAGE_NOTE } from '../rest/impact-envelope';

import type { AffectedBusinessService, ImpactBusinessContext, ImpactRecommendation, RecommendationInput } from './impact-business-context';

export const HAPPY_UI_SCHEMA = 'happy-ui/v1';
export const HAPPY_UI_CATALOG = 'happy.core@1';
/** The design system's id limit; an id over it is invalid in `highlight` and so is dropped. */
const MAX_ID_LENGTH = 64;
const MAX_CHAIN_ITEMS = 12;
const MAX_NAME_LENGTH = 80;

type Tone = 'ok' | 'warn' | 'crit' | 'ai' | 'sky' | 'muted';

/** The fields of the engine's `ImpactAnalysis` the answer reads. */
export interface AnswerImpact extends RecommendationInput {
  source_ci_id: string;
  source_ci_name: string;
  impact_score: number;
  affected_cis: ReadonlyArray<{ ci_id: string; ci_name: string; hop_count: number }>;
}

export interface ImpactAnswerInput {
  impact: AnswerImpact;
  context: ImpactBusinessContext;
  recommendations: readonly ImpactRecommendation[];
}

export type HappyUILine = Record<string, unknown> & { op: 'begin' | 'text' | 'effect' | 'node' | 'end' };

/** "Before you ..." per change type (the engine's `ChangeType` values; any other value reads "make this change"). */
const CHANGE_VERB: Readonly<Record<string, string>> = {
  failover: 'fail over',
  restart: 'restart',
  decommission: 'decommission',
  version_upgrade: 'upgrade',
  configuration_change: 'change the configuration of',
  network_change: 'change the network of',
  security_change: 'change the security settings of',
  performance_tuning: 'tune',
};

const RISK_TONE: Readonly<Record<string, Tone>> = { critical: 'crit', high: 'warn', medium: 'warn', low: 'ok', minimal: 'ok' };
const CRITICALITY_TONE: Readonly<Record<string, Tone>> = { critical: 'crit', high: 'warn', medium: 'sky', low: 'muted' };

const truncate = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, max - 3)}...`);
const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

function serviceItem(service: AffectedBusinessService): Record<string, unknown> {
  const meta = [
    service.users === null ? null : `${service.users} users`,
    service.cost_per_hour === null ? null : `$${service.cost_per_hour}/h`,
  ].filter((part): part is string => part !== null).join(', ');
  return {
    ...(service.service_id.length <= MAX_ID_LENGTH ? { id: service.service_id } : {}),
    name: truncate(service.name, MAX_NAME_LENGTH),
    ...(meta === '' ? {} : { meta }),
    tag: service.business_criticality,
    tagTone: CRITICALITY_TONE[service.business_criticality] ?? 'muted',
  };
}

/** The lines of the answer, in stream order. Pure. */
export function composeImpactAnswer(input: ImpactAnswerInput): HappyUILine[] {
  const { impact, context, recommendations } = input;
  const sourceName = truncate(impact.source_ci_name, MAX_NAME_LENGTH);
  const verb = CHANGE_VERB[impact.change_type] ?? 'make this change to';
  const direct = impact.affected_cis.filter(ci => ci.hop_count === 1).length;
  const services = context.affected_business_services;
  const riskTone = RISK_TONE[impact.risk_level] ?? 'muted';
  const hasCost = context.cost_per_hour !== null;
  const hasDowntime = impact.estimated_downtime_minutes !== undefined;

  const summary = `If you ${verb} ${sourceName}: ${impact.risk_level} risk (score ${impact.impact_score}), `
    + `${plural(impact.blast_radius, 'dependent CI')} (${direct} direct), ${plural(services.length, 'business service')} affected.`;

  const lines: HappyUILine[] = [
    { op: 'begin', $schema: HAPPY_UI_SCHEMA, catalog: HAPPY_UI_CATALOG },
    { op: 'text', text: summary },
    { op: 'effect', effect: { emit: 'select', detail: { id: impact.source_ci_id } } },
    { op: 'effect', effect: { emit: 'focus', detail: { id: impact.source_ci_id } } },
  ];
  const dependentIds = [...new Set(impact.affected_cis.map(ci => ci.ci_id))].filter(id => id.length <= MAX_ID_LENGTH);
  if (dependentIds.length > 0) {
    lines.push({ op: 'effect', effect: { emit: 'highlight', detail: { ids: dependentIds, tone: riskTone } } });
  }

  const node = (id: string, type: string, props: Record<string, unknown>, parent: string | null = 'root'): void => {
    lines.push({ op: 'node', id, ...(parent === null ? {} : { parent }), type, props });
  };
  node('root', 'Stack', { gap: 16 }, null);

  const stats: Array<Record<string, unknown>> = [
    { label: 'Risk', value: capitalize(impact.risk_level), delta: { text: `score ${impact.impact_score}`, tone: riskTone } },
    { label: 'Dependent CIs', value: impact.blast_radius, delta: { text: `${direct} direct` } },
  ];
  if (hasCost) {
    const priced = context.cost_per_hour_services_priced;
    stats.push({
      label: 'Cost per hour', value: context.cost_per_hour, prefix: '$', suffix: '/h', decimals: 2,
      ...(priced < services.length ? { delta: { text: `lower bound: ${priced} of ${services.length} priced`, tone: 'warn' } } : {}),
    });
  }
  if (hasDowntime) {
    stats.push({
      label: 'Estimated downtime', value: impact.estimated_downtime_minutes, suffix: ' min',
      delta: { text: 'heuristic, not measured', tone: 'muted' },
    });
  }
  node('kpis', 'StatGroup', { items: stats });

  if (services.length > 0) {
    node('services', 'ImpactChain', {
      title: 'Affected business services',
      caption: services.length > MAX_CHAIN_ITEMS ? `showing ${MAX_CHAIN_ITEMS} of ${services.length}` : plural(services.length, 'service'),
      tone: riskTone,
      items: services.slice(0, MAX_CHAIN_ITEMS).map(serviceItem),
    });
  }

  if (impact.critical_path.length > 1) {
    const names = new Map(impact.affected_cis.map(ci => [ci.ci_id, ci.ci_name]));
    node('chain', 'ImpactChain', {
      title: 'Longest dependency chain',
      caption: `${impact.critical_path.length - 1} hops`,
      tone: riskTone,
      items: impact.critical_path.slice(0, MAX_CHAIN_ITEMS).map((ciId, index) => ({
        ...(ciId.length <= MAX_ID_LENGTH ? { id: ciId } : {}),
        name: truncate(index === 0 ? impact.source_ci_name : (names.get(ciId) ?? ciId), MAX_NAME_LENGTH),
        meta: index === 0 ? 'selected CI' : `hop ${index}`,
      })),
    });
  }

  const missing = [
    ...(hasCost ? [] : ['cost per hour (no affected business service has annual revenue recorded)']),
    ...(hasDowntime ? [] : [`estimated downtime (no estimate for the ${impact.change_type} change type)`]),
  ];
  if (missing.length > 0) {
    node('unavailable', 'Text', { text: `Not available: ${missing.join('; ')}.`, variant: 'muted' });
  }
  node('basis', 'Text', { text: COVERAGE_NOTE, variant: 'muted' });

  if (recommendations.length > 0) {
    node('recommendations-heading', 'Text', { text: `Before you ${verb} ${sourceName}`, variant: 'lead' });
    for (const recommendation of recommendations) {
      node(`rec-${recommendation.id}`, 'Callout', {
        tone: recommendation.id === 'no_recorded_dependents' ? 'warn' : 'ai', text: truncate(recommendation.message, 600),
      });
    }
  }
  lines.push({ op: 'end' });
  return lines;
}

/** One JSON value per line, each ended by a newline, the form the design system's `parseStream` reads. */
export function toJsonLines(lines: readonly HappyUILine[]): string {
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n';
}
