#!/usr/bin/env node
// HAP-1252 S0: share of web-ui on the design system (decision N10 (a)), measured, not estimated.
//
//   node scripts/ds-share.mjs [--json] [--min <percent>] [srcDir]     (default srcDir: src)
//
// Unit = a JSX element use site (`<X>`, `<X />`, `<X.Y>`) in a non-test `.tsx` file under srcDir.
// Each site is classified by what its tag resolves to:
//   ds        root identifier imported from `@happy-technologies/design-system` (or a subpath; named,
//             default and namespace imports, aliases follow the local name), except `Icon`
//   icon      the design system's `Icon`: reported separately and kept out of the headline, because a
//             glyph is on the system by construction and says nothing about screen adoption
//   localUi   imported from the app's own UI layer, `srcDir/components/ui/**` (the shadcn-style
//             primitives the design system replaces)
//   raw       a raw primitive host element the design system forbids outside itself:
//             h1 h2 h3 button select table input textarea
// Everything else (layout `div`/`span`, router, charts, feature components) is not a primitive and is
// outside the ratio.
//
//   share         = ds / (ds + localUi + raw)                  the N10 target: >= 80% by end of S8
//   shareInclIcon = (ds + icon) / (ds + icon + localUi + raw)
//
// Screens = non-test `.tsx` files under srcDir/pages; a screen is on the design system when it
// contains at least one `ds` site. `--min <percent>` exits 1 when the headline share is below it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DS_MODULE = /^@happy-technologies\/design-system(\/|$)/;
const RAW_PRIMITIVES = new Set(['h1', 'h2', 'h3', 'button', 'select', 'table', 'input', 'textarea']);

function* tsxFiles(dir) {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* tsxFiles(full);
    else if (/\.tsx$/.test(entry) && !/\.(test|spec)\.tsx$/.test(entry)) yield full;
  }
}

/** Absolute path for a relative or tsconfig-aliased (`@/`, `@components/`) specifier; else the bare specifier. */
function resolveSpecifier(spec, file, srcDir) {
  if (spec.startsWith('@/')) return path.join(srcDir, spec.slice(2));
  if (spec.startsWith('@components/')) return path.join(srcDir, 'components', spec.slice('@components/'.length));
  if (spec.startsWith('.')) return path.resolve(path.dirname(file), spec);
  return spec;
}

/** local name -> { from: resolved module, imported: imported name | 'default' | '*' } */
function importBindings(ts, sf, file, srcDir) {
  const bound = new Map();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const clause = stmt.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const from = resolveSpecifier(stmt.moduleSpecifier.text, file, srcDir);
    if (clause.name) bound.set(clause.name.text, { from, imported: 'default' });
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) bound.set(nb.name.text, { from, imported: '*' });
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (!el.isTypeOnly) bound.set(el.name.text, { from, imported: (el.propertyName ?? el.name).text });
      }
    }
  }
  return bound;
}

function classify(ts, tag, bound, uiDir) {
  const text = tag.getText();
  if (RAW_PRIMITIVES.has(text)) return 'raw';
  let node = tag;
  let leaf;
  while (ts.isPropertyAccessExpression(node)) {
    leaf ??= node.name.text;
    node = node.expression;
  }
  if (!ts.isIdentifier(node)) return null;
  const binding = bound.get(node.text);
  if (!binding) return null;
  if (DS_MODULE.test(binding.from)) {
    const name = binding.imported === '*' ? leaf : binding.imported;
    return name === 'Icon' ? 'icon' : 'ds';
  }
  if (binding.from === uiDir || binding.from.startsWith(uiDir + path.sep)) return 'localUi';
  return null;
}

export function measure(srcDir) {
  const ts = createRequire(import.meta.url)('typescript');
  const uiDir = path.join(srcDir, 'components', 'ui');
  const t = { ds: 0, icon: 0, localUi: 0, raw: 0 };
  const screens = { total: 0, onDs: 0 };
  let files = 0;
  for (const file of tsxFiles(srcDir)) {
    files += 1;
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const bound = importBindings(ts, sf, file, srcDir);
    const row = { ds: 0, icon: 0, localUi: 0, raw: 0 };
    const visit = (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const kind = classify(ts, node.tagName, bound, uiDir);
        if (kind) row[kind] += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    for (const k of Object.keys(t)) t[k] += row[k];
    if (path.relative(srcDir, file).split(path.sep)[0] === 'pages') {
      screens.total += 1;
      if (row.ds > 0) screens.onDs += 1;
    }
  }
  const pct = (n, d) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);
  const primitives = t.ds + t.localUi + t.raw;
  return {
    ...t,
    primitives,
    share: pct(t.ds, primitives),
    shareInclIcon: pct(t.ds + t.icon, primitives + t.icon),
    files,
    screens,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const minAt = argv.indexOf('--min');
  const min = minAt === -1 ? null : Number(argv[minAt + 1]);
  if (minAt !== -1 && !Number.isFinite(min)) {
    console.error('ds-share: --min needs a number (percent)');
    process.exit(2);
  }
  const positional = argv.filter((a, i) => !a.startsWith('--') && (minAt === -1 || i !== minAt + 1));
  const webUi = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = measure(path.resolve(webUi, positional[0] ?? 'src'));
  if (result.files === 0 || result.primitives === 0) {
    console.error('ds-share: no primitive use sites found; refusing to report a share for an empty scan');
    process.exit(1);
  }
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `ds-share: ${result.ds} of ${result.primitives} primitive use sites on the design system = ${result.share}% ` +
        `(${result.ds} ds, ${result.localUi} local components/ui, ${result.raw} raw h1-h3/button/select/table/input/textarea; ` +
        `${result.shareInclIcon}% counting ${result.icon} DS Icon sites); ` +
        `screens on the design system: ${result.screens.onDs} of ${result.screens.total} (pages/**/*.tsx)`,
    );
  }
  if (min !== null && result.share < min) {
    console.error(`ds-share: ${result.share}% is below the required ${min}%`);
    process.exit(1);
  }
}
