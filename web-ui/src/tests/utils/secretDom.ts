// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1213: where a secret marker is readable from the DOM tree. The one legitimate place, an input's own
// `.value` property, is not part of the tree, so any hit here is a leak to extensions and DOM snapshots.

/** A unique, grep-neutral marker per call, so a stale value from another test cannot satisfy an assertion. */
export const secretMarker = (label: string): string =>
  `S3CR3T-${label}-${Math.random().toString(36).slice(2, 10)}`;

/** Every place in `root` (default: the whole body) whose serialized form, attribute or text contains `marker`. */
export function domLeaks(marker: string, root: HTMLElement = document.body): string[] {
  const leaks: string[] = [];
  if (root.innerHTML.includes(marker)) leaks.push('innerHTML');
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.includes(marker) || attr.value.includes(marker)) {
        leaks.push(`<${el.localName}> attribute ${attr.name}`);
      }
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue?.includes(marker)) {
      leaks.push(`text node in <${node.parentElement?.localName}>`);
    }
  }
  return leaks;
}
