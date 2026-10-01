/**
 * Supply-chain guard for .github/workflows/cla.yml.
 *
 * The CLA workflow runs on pull_request_target / issue_comment and hands
 * GITHUB_TOKEN plus a PAT to a third-party action. A mutable tag ref would let
 * whoever controls that tag run code with those tokens, and `statuses: write`
 * would let it post a forged commit status (e.g. `ci-rollup/test=success`).
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';

const WORKFLOW_PATH = resolve(__dirname, '../../../.github/workflows/cla.yml');
const SHA_REF = /@[0-9a-f]{40}$/;

type Step = { uses?: string };
type Job = { uses?: string; permissions?: unknown; steps?: Step[] };
type Workflow = { permissions?: unknown; jobs: Record<string, Job> };

const workflow = parse(readFileSync(WORKFLOW_PATH, 'utf8')) as Workflow;

describe('.github/workflows/cla.yml', () => {
  it('pins every action and reusable workflow to a full commit SHA', () => {
    const refs = Object.values(workflow.jobs).flatMap((job) => [
      ...(job.uses ? [job.uses] : []),
      ...(job.steps ?? []).flatMap((step) => (step.uses ? [step.uses] : [])),
    ]);

    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((ref) => !SHA_REF.test(ref))).toEqual([]);
  });

  it('never grants the statuses permission', () => {
    // Workflow-level permissions are required: when absent, GITHUB_TOKEN gets the
    // repository default, which may include statuses: write. Jobs without their
    // own block inherit the workflow-level map.
    const scopes: Array<[string, unknown]> = [
      ['workflow', workflow.permissions],
      ...Object.entries(workflow.jobs)
        .filter(([, job]) => job.permissions !== undefined)
        .map(([name, job]) => [`jobs.${name}`, job.permissions] as [string, unknown]),
    ];

    for (const [scope, permissions] of scopes) {
      // An explicit map is required; the `write-all` shorthand includes statuses.
      expect([scope, typeof permissions === 'object' && permissions !== null]).toEqual([scope, true]);
      expect([scope, Object.keys(permissions as object)]).toEqual([
        scope,
        expect.not.arrayContaining(['statuses']),
      ]);
    }
  });
});
