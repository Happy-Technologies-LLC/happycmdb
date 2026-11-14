/**
 * HAP-1297: the `sec12-02-p99` job's "Applies to this PR?" step decides whether the real-store auth p99 gate runs.
 * This executes that step's own shell script (taken from test.yml) against a throwaway git repo and reads the
 * `run=` output, so a request-path file missing from the step's pathspec list leaves the gate silently skipped.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { parse } from 'yaml';

type Step = { id?: string; run?: string };
const workflow = parse(readFileSync(resolve(__dirname, '../../../.github/workflows/test.yml'), 'utf8')) as {
  jobs: Record<string, { env: Record<string, string>; steps: Step[] }>;
};
const job = workflow.jobs['sec12-02-p99'];
const script = job.steps.find((step) => step.id === 'scope')!.run!;
const HARNESS = job.env.HARNESS;

describe('sec12-02-p99 scope step', () => {
  let repo: string;
  let base: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8' }).trim();

  /** Commit one change to `file` on top of the base commit and report the step's `run=` output. */
  function runFor(file: string): string {
    git('checkout', '-q', '--detach', base);
    mkdirSync(join(repo, dirname(file)), { recursive: true });
    writeFileSync(join(repo, file), `${Math.random()}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', 'change');
    const output = join(repo, '.git', 'gh-output');
    writeFileSync(output, '');
    execFileSync('bash', ['-c', script], {
      cwd: repo,
      stdio: 'pipe',
      env: { PATH: process.env.PATH!, HARNESS, BASE_SHA: base, GITHUB_OUTPUT: output },
    });
    return readFileSync(output, 'utf8').trim();
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'sec12-scope-'));
    git('init', '-q');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    base = git('rev-parse', 'HEAD');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it.each([
    'packages/api-server/src/auth/jwt.service.ts',
    'packages/api-server/src/middleware/auth.middleware.ts',
    'packages/api-server/src/rest/auth.controller.ts',
    'packages/api-server/src/rest/middleware/refresh-cookie.ts',
    'packages/api-server/src/validation/schemas.ts',
    HARNESS,
    '.github/workflows/test.yml',
  ])('runs the gate when %s changes', (file) => {
    expect(runFor(file)).toBe('run=true');
  });

  it('skips the gate for an unrelated change', () => {
    expect(runFor('packages/api-server/src/rest/routes/ci.routes.ts')).toBe('run=false');
  });
});
