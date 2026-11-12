// Resolve an executable from the nearest node_modules/.bin above `from`, so the scripts work
// under `node scripts/x.mjs` as well as `npm run`, which only adds .bin to PATH for its own children.
import { existsSync } from 'node:fs';
import path from 'node:path';

export function findBin(name, from) {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', '.bin', name);
    if (existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`${name} not found in any node_modules/.bin above ${from}`);
  }
}

// The installed design-system package directory (its package.json is not in the exports map).
export function designSystemDir(from) {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', '@happy-technologies', 'design-system');
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`@happy-technologies/design-system not installed above ${from}`);
  }
}
