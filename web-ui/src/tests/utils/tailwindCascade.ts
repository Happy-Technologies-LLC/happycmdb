// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { compile } from 'tailwindcss';

/**
 * jsdom applies no Tailwind CSS, so a utility that is silently overridden by a
 * sibling utility on the same element (the design-system `cn` is a plain class
 * join, not tailwind-merge) is invisible to a class-presence assertion. This
 * compiles the element's real class list with the repo's Tailwind and a minimal
 * cascade (importance, then stylesheet order) and returns the declaration that
 * wins. Variant utilities (`sm:`, `hover:`) are not modelled: they are skipped.
 */
const themeCss = readFileSync(createRequire(import.meta.url).resolve('tailwindcss/theme.css'), 'utf8');

export async function winningDeclaration(
  className: string,
  property: string,
): Promise<string | undefined> {
  const candidates = className.split(/\s+/).filter((c) => c && !c.includes(':'));
  const compiler = await compile(`${themeCss}\n@tailwind utilities;`);
  const css = compiler.build(candidates);
  const root = new Map<string, string>();
  const rootBlock = /:root, :host \{([^}]*)\}/.exec(css);
  for (const m of rootBlock?.[1].matchAll(/(--[\w-]+):\s*([^;]+);/g) ?? []) root.set(m[1], m[2].trim());

  let winner: { value: string; important: boolean } | undefined;
  for (const rule of css.matchAll(/^\.((?:\\.|[^\s{\\])+)\s*\{([^}]*)\}/gm)) {
    const selectorClass = rule[1].replace(/\\(.)/g, '$1');
    if (!candidates.includes(selectorClass)) continue;
    for (const decl of rule[2].matchAll(/([\w-]+):\s*([^;]+);/g)) {
      if (decl[1] !== property) continue;
      const important = /!important\s*$/.test(decl[2]);
      if (winner?.important && !important) continue;
      winner = { value: decl[2].replace(/\s*!important\s*$/, '').trim(), important };
    }
  }
  return winner?.value.replace(/var\((--[\w-]+)\)/g, (_, v: string) => root.get(v) ?? `var(${v})`);
}
