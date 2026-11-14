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

// HAP-1210 S2b (H0-F1): script-src 'self' blocks any inline script, so the SPA shell must carry none.
const INLINE_SCRIPT = /<script\b(?![^>]*\ssrc\s*=)[^>]*>/gi;
it('web-ui/index.html has no inline <script> (one without src)', () => {
  expect('<script type="module" src="/a.js"></script><SCRIPT\n type="module">x</SCRIPT>'.match(INLINE_SCRIPT)).toHaveLength(1);
  expect(readFileSync(resolve(REPO, 'web-ui/index.html'), 'utf8').match(INLINE_SCRIPT)).toBeNull();
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

// HAP-1279 F-5: a loopback or wildcard-bind origin, with or without a scheme or port: localhost:3000, //localhost, 127.0.0.1, 0.0.0.0, [::1].
const LOCAL_ORIGIN =
  /localhost:3000|(?:https?:)?\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?![\w.])|(?<![\w.])(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+/;
it('the local-origin pattern matches loopback and wildcard origins and nothing near-miss', () => {
  const hits = ['http://localhost:3000/api', "'//localhost'", 'localhost:3000', 'http://127.0.0.1', 'https://127.0.0.1:8443/x', 'http://0.0.0.0:3000', '//0.0.0.0', 'http://[::1]', '//[::1]:3000', 'https://[::1]/a', '0.0.0.0:8080', '[::1]:3000', 'fetch("127.0.0.1:3000")'];
  const misses = ['http://localhost.example.com', 'http://127.0.0.10', '10.0.0.0/8', 'CMDB_NETWORKS=10.0.0.0/8,172.16.0.0/12', '0.0.0.0', '::1', 'http://[::1a]', 'x0.0.0.0:80', '1127.0.0.1:80', 'https://example.com:3000'];
  expect([hits.filter((h) => !LOCAL_ORIGIN.test(h)), misses.filter((m) => LOCAL_ORIGIN.test(m))]).toEqual([[], []]);
});

it('no non-test web-ui/src file calls a localhost, 127.0.0.1, 0.0.0.0 or [::1] origin, which the CSP blocks (HAP-1234)', () => {
  const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => /\.(?:[cm]?[jt]sx?|html)$/.test(f) && !/(?:\.test\.|__tests__)/.test(f));
  expect(files).toContain('components/discovery/AgentList.tsx');
  const hits = files.filter((f) => LOCAL_ORIGIN.test(readFileSync(resolve(SRC, f), 'utf8')));
  expect(hits).toEqual([]);
});
