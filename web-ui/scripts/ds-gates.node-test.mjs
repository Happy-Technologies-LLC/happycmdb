// Behaviour of the HAP-1252 S0 design-system gates, run against throwaway fixture trees:
//   node --test web-ui/scripts/ds-gates.node-test.mjs     (npm run test:scripts --workspace=web-ui)
// Named `*.node-test.mjs`, not `*.test.mjs`, so check-test-discovery.mjs (vitest files only) leaves it alone.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkTokens } from './check-ds-tokens.mjs';
import { measure } from './ds-share.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const roots = [];
function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'ds-gates-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const node = (script, ...args) => spawnSync(process.execPath, [path.join(here, script), ...args], { encoding: 'utf8' });

describe('ds-adherence (warn-first gate)', () => {
  const clean = "import { Button } from '@happy-technologies/design-system';\nexport const A = () => <Button variant=\"primary\">ok</Button>;\n";
  const dirty =
    "import { Camera } from 'lucide-react';\nimport { Button } from '@happy-technologies/design-system';\n" +
    "export const A = () => <Button variant=\"nope\" style={{ color: '#123456' }}><Camera /></Button>;\n";

  it('passes a clean tree in both modes', () => {
    const src = tree({ 'a.tsx': clean });
    for (const flags of [[], ['--deny-warnings']]) {
      const r = node('ds-adherence.mjs', ...flags, src);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /clean \(0 restricted import\(s\), 0 adherence problem\(s\)/);
    }
  });

  it('reports a banned icon import (by both tools), an off-union prop and a raw hex, yet exits 0 while warn-first', () => {
    const r = node('ds-adherence.mjs', tree({ 'a.tsx': dirty }));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /warn-first, not failing \(1 restricted import\(s\), 3 adherence problem\(s\)/);
    assert.match(r.stdout, /variant 'nope' must be/);
    assert.match(r.stdout, /raw hex colour '#123456'/);
  });

  it('exits 1 on the same tree with --deny-warnings', () => {
    const r = node('ds-adherence.mjs', '--deny-warnings', tree({ 'a.tsx': dirty }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FAIL --deny-warnings \(1 restricted import\(s\), 3 adherence problem\(s\)/);
  });

  it('does not fail --deny-warnings on a deprecated 0.9.1 alias, which is a notice', () => {
    const src = tree({
      'a.tsx': "import { Badge } from '@happy-technologies/design-system';\nexport const A = () => <Badge variant=\"error\">x</Badge>;\n",
    });
    const r = node('ds-adherence.mjs', '--deny-warnings', src);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /1 deprecation notice\(s\)/);
  });

  it('fails closed, even warn-first, when a checker crashes instead of reporting', () => {
    const r = node('ds-adherence.mjs', path.join(tmpdir(), 'ds-gates-no-such-dir'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /exited 1 with no readable finding|oxlint failed/);
  });
});

describe('check-ds-tokens', () => {
  it('flags a token the design system does not declare, and lists the file that reads it', () => {
    const dsDir = tree({ 'src/theme.css': '.hh-theme { --hh-accent: red; }\n' });
    const src = tree({ 'a.tsx': 'const s = { color: "var(--hh-accent)", border: "var(--hh-renamed-away)" };\n' });
    const { missing } = checkTokens(src, dsDir);
    assert.deepEqual([...missing.keys()], ['--hh-renamed-away']);
    assert.deepEqual(missing.get('--hh-renamed-away'), [path.join(src, 'a.tsx')]);
  });

  it('accepts tokens web-ui declares itself, ignores template prefixes and test files', () => {
    const dsDir = tree({ 'src/theme.css': '.hh-theme { --hh-accent: red; }\n' });
    const src = tree({
      'own.css': ':root { --hh-local-tone: blue; }\n.a { color: var(--hh-local-tone); background: var(--hh-accent); }\n',
      'dyn.tsx': 'const c = (t: string) => `var(--hh-status-${t})`;\n',
      'a.test.tsx': 'expect(el).toHaveStyle("color: var(--hh-not-real)");\n',
    });
    assert.equal(checkTokens(src, dsDir).missing.size, 0);
  });

  it('CLI exits 1 naming the token, 0 when all are declared, and 1 on an empty scan', () => {
    // The CLI resolves the installed design system from the script location; the fixtures use the real one.
    const bad = node('check-ds-tokens.mjs', tree({ 'a.css': '.a { color: var(--hh-definitely-not-a-token); }\n' }));
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--hh-definitely-not-a-token/);
    const good = node('check-ds-tokens.mjs', tree({ 'a.css': '.a { color: var(--hh-accent); }\n' }));
    assert.equal(good.status, 0, good.stderr);
    const empty = node('check-ds-tokens.mjs', tree({ 'a.css': '.a { color: red; }\n' }));
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /empty scan/);
  });
});

describe('ds-share', () => {
  const files = {
    // 2 ds (one aliased, one via namespace member), 1 Icon, 1 local UI, 2 raw primitives, layout/router ignored.
    'pages/Home.tsx':
      "import { Button as B } from '@happy-technologies/design-system';\n" +
      "import * as DS from '@happy-technologies/design-system';\n" +
      "import { Button } from '@/components/ui/button';\n" +
      "import { Link } from 'react-router-dom';\n" +
      'export const H = () => (<div><B /><DS.Card /><DS.Icon name="x" /><Button /><button /><h1>t</h1><Link /></div>);\n',
    // not a screen: components dir. 1 local UI via relative path, 1 raw table.
    'components/Row.tsx': "import { Badge } from './ui/badge';\nexport const R = () => (<table><Badge /></table>);\n",
    'components/ui/badge.tsx': 'export const Badge = () => <span />;\n',
    // second screen with no DS use
    'pages/Legacy.tsx': "import { Input } from '../components/ui/input';\nexport const L = () => <Input />;\n",
    // ignored: tests, and type-only DS imports
    'pages/Home.test.tsx': "import { Button } from '@happy-technologies/design-system';\nit('x', () => { render(<Button />); });\n",
    'components/T.tsx': "import type { ButtonProps } from '@happy-technologies/design-system';\nexport const T = (p: ButtonProps) => <i />;\n",
  };

  it('classifies use sites by what the tag resolves to', () => {
    const r = measure(tree(files));
    assert.deepEqual(
      { ds: r.ds, icon: r.icon, localUi: r.localUi, raw: r.raw },
      { ds: 2, icon: 1, localUi: 3, raw: 3 },
    );
    assert.equal(r.share, 25); // 2 / (2 + 3 + 3)
    assert.equal(r.shareInclIcon, 33.3); // 3 / (8 + 1)
    assert.deepEqual(r.screens, { total: 2, onDs: 1 });
  });

  it('CLI --min exits 1 below the threshold and 0 at or above it; an empty scan is an error, not 0%', () => {
    const src = tree(files);
    assert.equal(node('ds-share.mjs', '--min', '25', src).status, 0);
    const below = node('ds-share.mjs', '--min', '26', src);
    assert.equal(below.status, 1);
    assert.match(below.stderr, /25% is below the required 26%/);
    const empty = node('ds-share.mjs', tree({ 'a.tsx': 'export const A = () => <div />;\n' }));
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /empty scan/);
  });
});
