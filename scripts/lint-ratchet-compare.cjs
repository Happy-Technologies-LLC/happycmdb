'use strict';
// HAP-1951: the pure part of scripts/lint-ratchet.mjs. A "counts" map is { [file]: { [rule]: count } }.
// CommonJS so the jest unit config (tests/unit/scripts) can load it as well as the .mjs entry point.

const PARSE_ERROR = '(parse error)';

// Compare the current counts with the baseline. A pair is a regression when it has more findings than the
// baseline allows; a pair that is not in the baseline is allowed 0. `only` (package dir names) scopes the
// "improved" tally to the linted packages: the others were not run, so they must not read as fixed.
function compareCounts(baseline, current, only = []) {
  const regressions = [];
  let improved = 0;
  for (const file of Object.keys(current)) {
    for (const [rule, found] of Object.entries(current[file])) {
      const allowed = baseline[file]?.[rule] ?? 0;
      if (found > allowed) {
        regressions.push({ file, rule, allowed, found });
      }
    }
  }
  const scoped = (file) => only.length === 0 || only.some((n) => file.startsWith(`packages/${n}/`));
  for (const file of Object.keys(baseline).filter(scoped)) {
    for (const [rule, allowed] of Object.entries(baseline[file])) {
      improved += Math.max(0, allowed - (current[file]?.[rule] ?? 0));
    }
  }
  return { regressions, improved };
}

// The baseline `--update` writes. Without `allowRaise` it is min(baseline, current) per (file, rule) pair: a pair
// that is not in the baseline is not added and a count above the baseline is not raised (both come back in
// `refused`); a pair with no findings left drops out. With `allowRaise` it is the current counts as they are
// (a renamed file, for example, needs its pairs written under the new path).
function nextBaseline(baseline, current, allowRaise = false) {
  const next = {};
  const refused = [];
  for (const file of Object.keys(current)) {
    for (const [rule, found] of Object.entries(current[file])) {
      const allowed = baseline[file]?.[rule];
      let write = found;
      if (!allowRaise && (allowed === undefined || found > allowed)) {
        refused.push({ file, rule, allowed: allowed ?? 0, found });
        if (allowed === undefined) {
          continue;
        }
        write = allowed;
      }
      next[file] ??= {};
      next[file][rule] = write;
    }
  }
  return { next, refused };
}

function total(counts) {
  let n = 0;
  for (const rules of Object.values(counts)) {
    for (const c of Object.values(rules)) {
      n += c;
    }
  }
  return n;
}

module.exports = { PARSE_ERROR, compareCounts, nextBaseline, total };
