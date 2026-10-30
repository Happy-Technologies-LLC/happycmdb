// HAP-1211 C: the SPA requests no third-party font, so a 'self'-only CSP keeps its brand fonts.
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const REPO = resolve(__dirname, '../../..');
const SRC = resolve(REPO, 'web-ui/src');
const REMOTE =
  /(?:@import|url\()\s*(?:url\()?\s*['"]?(?:https?:)?\/\/[^'")\s;]*|fonts\.(?:googleapis|gstatic)\.com/g;
const REMOTE_TAG = /<(?:link|script)\b[^>]*\b(?:href|src)\s*=\s*["']?(?:https?:)?\/\/[^>]*>/gi;

it('web-ui CSS loads no stylesheet or font from another origin', () => {
  const all = readdirSync(SRC, { recursive: true }) as string[];
  const files = all.filter((f) => f.endsWith('.css'));
  expect(files).toContain('styles/ds/tokens/fonts.css');
  const hits = files.flatMap((f) =>
    [...readFileSync(resolve(SRC, f), 'utf8').matchAll(REMOTE)].map((m) => `${f}: ${m[0]}`)
  );
  expect(hits).toEqual([]);
});

it('web-ui/index.html links, loads or imports nothing from another origin', () => {
  const html = readFileSync(resolve(REPO, 'web-ui/index.html'), 'utf8');
  expect([...(html.match(REMOTE_TAG) ?? []), ...(html.match(REMOTE) ?? [])]).toEqual([]);
});

it('the font variables lead with the bundled Inter Variable / Jost Variable faces', () => {
  const fonts = readFileSync(resolve(SRC, 'styles/ds/tokens/fonts.css'), 'utf8');
  expect(fonts).toMatch(/--font-display:\s*"Inter Variable",/);
  expect(fonts).toMatch(/--font-body:\s*"Jost Variable",/);
});

it('the edge CSP connect-src does not list api.happycmdb.io, which the built SPA never calls', () => {
  const conf = readFileSync(resolve(REPO, 'infrastructure/docker/nginx.conf'), 'utf8');
  expect(conf).toMatch(/connect-src 'self'/);
  expect(conf).not.toMatch(/connect-src [^;"]*api\.happycmdb\.io/);
});

it('no non-test web-ui/src file calls a localhost or 127.0.0.1 origin, which the CSP blocks (HAP-1234)', () => {
  const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => /\.(?:[cm]?[jt]sx?|html)$/.test(f) && !/(?:\.test\.|__tests__)/.test(f));
  expect(files).toContain('components/discovery/AgentList.tsx');
  const hits = files.filter((f) => /localhost:3000|(?:https?:)?\/\/(?:localhost|127\.0\.0\.1)\b/.test(readFileSync(resolve(SRC, f), 'utf8')));
  expect(hits).toEqual([]);
});
