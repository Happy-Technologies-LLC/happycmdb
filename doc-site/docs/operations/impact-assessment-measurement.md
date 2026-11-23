---
title: Impact-Assessment Measurement Protocol
description: Protocol for measuring operator error and review effort on impact assessments, current view against evidence view (HAP-2032)
---

# Impact-Assessment Measurement Protocol

This page is a protocol, not a result. No measurement has been run, and this page reports no numbers. It defines what is counted, on which fixture, in which order, and how a result is reported, so that a later run can be compared with the design's claim. It is story 5 of the evidence-qualified impact capability described in [System Overview](/architecture/system-overview).

## Purpose and non-goals

Purpose: measure whether showing per-edge evidence and coverage changes how operators err and how much effort they spend when they assess the impact of a change, against the view they have today.

The capability's acceptance in the design ends with: "Operator error and review-effort measurement against the current view (story 5); graph size is not a value metric."

Non-goals:

* Graph size, node counts and edge counts are not a value metric. A larger graph is not evidence of a better assessment, and this protocol never reports one.
* It does not measure the API, the traversal bounds or the freshness windows. Those are covered by the unit tests of `packages/api-server/src/rest/edge-evidence.ts`.
* It does not set a sample size or a decision threshold. See [Reporting](#reporting).

## Units

One assessment is one operator, one change target CI, and one view.

| Arm | Name | What the operator sees |
|---|---|---|
| A | Current view | `GET /cis/:id/impact` for the target CI, without reading `edges`. The `edges`, `basis`, `runtime_blast_radius` and `coverage` fields are not shown. |
| B | Evidence view | The same read, with each edge's `currentness` and `evidence` from `edges`, and the `coverage` envelope. |

Both arms read the same target CI of the same fixture. Only the presentation differs.

The fixture is `packages/api-server/src/rest/routes/__tests__/fixtures/impact-assessment-measurement.json`. It holds one disposable scenario: a read-time instant `readAt`, five edges of the target CI (a declared dependency, an observed one, a stale observation, a contradicted claim, and an unobserved runtime connection with no receipts), a `beyondGraph` list of CIs that are truly impacted but have no recorded edge, and an `answerKey` for each error definition below. The test `packages/api-server/src/rest/__tests__/impact-assessment-measurement-fixture.test.ts` checks every edge's `expectedCurrentness` against `deriveCurrentness`, so the answer key cannot drift from the real derivation unnoticed.

## Error definitions

Each error is a countable event against the fixture's `answerKey`. An assessment can contain several events of different kinds; each is counted once per edge or per CI.

| Code | Name | Event |
|---|---|---|
| (a) | False-complete | The operator calls the declared-graph impact the complete runtime blast radius. Counted once per assessment. Key: `answerKey.falseComplete`. |
| (b) | Missed dependency | A truly impacted CI of the fixture's beyond-graph case is not named by the operator. Counted per CI in `answerKey.missedDependency.mustName`. |
| (c) | Wrongly trusted edge | An edge whose derived currentness is `stale`, `contradicted` or `unsupported` is treated as current. Counted per edge in `answerKey.wronglyTrustedEdge.notCurrentEdges`. |
| (d) | Wrongly discarded edge | A `current` edge is treated as unsupported. Counted per edge in `answerKey.wronglyDiscardedEdge.currentEdges`. |

How the operator's verdict is captured so that each event can be counted (a verdict form listing the edges and CIs the operator treats as current, unsupported or impacted) is part of the facilitator's script and is not fixed by this page.

How an operator in either arm is given the information needed to name a beyond-graph CI is open: neither view lists those CIs, so the briefing that accompanies the fixture decides what is knowable. That briefing is to be settled by the founder before the first run.

How the pinned view and the per-edge receipts are presented to the operator is open. Procedure step 5 makes a run invalid if the operator sees live reads instead of the fixture's pinned values, and the fixture has aggregate rows only, no receipt rows, so an operator cannot follow `evidence.receipts_href` as the "Edges opened" measure assumes. One suggestion, not a decision: a facilitator renders both arms from the fixture and supplies receipt detail on request. Another way is equally possible. The choice is to be settled by the founder before the first run.

## Review effort

Three measures per assessment:

| Measure | Definition | How it is recorded |
|---|---|---|
| Edges opened | Number of distinct edges whose receipts the operator reads (`evidence.receipts_href`, the receipts read `GET /api/v1/relationships/evidence`). | Counted by the facilitator from the operator's receipt reads, once per distinct edge. Arm A has no per-edge link, so record `null`, not zero. |
| Time to verdict | Wall-clock seconds from the moment the target CI's view is shown to the moment the operator submits a verdict. | Timed by the facilitator and recorded to the second. |
| Verdict confidence | The operator's own statement of confidence in the verdict. | One of `low`, `medium`, `high`, stated at submission and before the answer key is revealed. |

## Procedure

1. Every operator performs one assessment in each arm, on the same fixture, in the same fixture version.
2. The order of arms is counterbalanced across operators: half of the operators start with arm A and half with arm B, assigned before the run and recorded per operator. With an odd operator count the imbalance is stated in the report.
3. No operator sees the answer key before submitting. The key is applied by someone other than the operator after submission.
4. The freshness windows are read from `EDGE_FRESHNESS_WINDOWS_DAYS` in `packages/api-server/src/rest/edge-evidence.ts` at run time. They are not copied into this page, the briefing or the record, because they are policy constants and may be tuned. A change to them is a change of fixture version until the fixture test passes again.
5. The fixture's `readAt` is the instant the currentness values are defined at. If the operator sees live reads instead of the fixture's pinned values, the run is not valid for this protocol.

## Reporting

A report states, for each arm:

* The count of each error (a) to (d).
* The median of each effort measure: edges opened (arm B only), time to verdict, and verdict confidence. Confidence is ordinal, so with an even number of operators and two middle categories, report the lower of the two (the conservative reading). This is a rule of this protocol, not a statistical claim.

and, once for the run:

* The number of operators who completed both arms.
* The fixture version (`fixtureVersion`).

Rule: a result with fewer operators than the planned operator count is reported as inconclusive. It is not reported as a trend, and its counts are not extrapolated.

The planned operator count and the decision threshold are open. They are chosen by the founder before the first run, and this page deliberately gives neither. Both are named fields in the record template below and must be filled in before any assessment is performed.

## Record template

Study-level fields, fixed before the first run:

```json
{
  "fixtureVersion": "",
  "plannedOperators": null,
  "decisionThreshold": null,
  "chosenBy": "founder",
  "chosenOn": ""
}
```

One row per assessment:

| operator | arm | arm order | fixture version | false-complete (a) | missed dependency (b) | wrongly trusted (c) | wrongly discarded (d) | edges opened | seconds to verdict | confidence |
|---|---|---|---|---|---|---|---|---|---|---|
| | A or B | A-first or B-first | | | | | | `null` in arm A | | low, medium or high |
