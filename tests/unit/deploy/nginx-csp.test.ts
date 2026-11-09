// HAP-1211 H0. nginx: a location with any add_header of its own drops every server-level one.
import { readFileSync } from 'fs';
import { resolve } from 'path';

const STATIC = /~\* .*\bjs\b/;
const STRICT = [
  "default-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
];
const ADD_HEADER = /\badd_header\s+(\S+)\s+(?:"([^"]*)"|'([^']*)'|([^\s;]+))(?:\s+(always))?\s*;/g;
const addHeaders = (text: string) =>
  [...text.matchAll(ADD_HEADER)].map(([, n, dq, sq, v, a]) => [n, dq ?? sq ?? v, a ?? '']);

it.each(['web-ui/nginx.conf', 'infrastructure/docker/nginx.conf'])('%s: SPA CSP', (file) => {
  const conf = readFileSync(resolve(__dirname, '../../..', file), 'utf8').replace(/#.*$/gm, '');
  const server = conf.split(/^server\s*\{/m).find((s) => STATIC.test(s))!;
  const inherited = addHeaders(server.replace(/\blocation[^{]*\{[^}]*\}/g, ''));
  const locations = [...server.matchAll(/\blocation\s+([^{]*?)\s*\{([^}]*)\}/g)];
  const spa = locations.filter(([, head]) => head === '/' || STATIC.test(head));
  expect(spa).toHaveLength(2);
  const own = spa.map(([, , body]) => addHeaders(body));
  for (const headers of [inherited, ...own.map((h) => (h.length > 0 ? h : inherited))]) {
    expect(headers.map(([n]) => n)).toEqual(expect.arrayContaining(inherited.map(([n]) => n)));
    const csp = headers.filter(([n]) => n === 'Content-Security-Policy');
    expect(csp).toHaveLength(1);
    const [[, policy, always]] = csp;
    expect(always).toBe('always');
    expect(policy.split(/\s*;\s*/)).toEqual(expect.arrayContaining(STRICT));
    expect(policy.match(/(?:^|;)\s*default-src\b/g)).toHaveLength(1);
    expect(policy).not.toMatch(/connect-src [^;]*api\.happycmdb\.io/);
  }
});

// HAP-1230. The SPA opens ws(s)://host/ws; the shipped web-ui conf must hand that upgrade to the API.
it('web-ui/nginx.conf: /ws forwards the WebSocket upgrade to the API and keeps the server headers', () => {
  const conf = readFileSync(resolve(__dirname, '../../..', 'web-ui/nginx.conf'), 'utf8').replace(/#.*$/gm, '');
  const [http, server] = conf.split(/^server\s*\{/m);
  // conf.d/default.conf is included at http level: the map must sit outside the server block.
  expect(http).toMatch(/\bmap\s+\$http_upgrade\s+\$connection_upgrade\s*\{\s*default\s+upgrade\s*;\s*''\s+close\s*;\s*\}/);
  expect(server).not.toMatch(/\bmap\s/);
  const body = (head: string) => [...server.matchAll(/\blocation\s+([^{]*?)\s*\{([^}]*)\}/g)].find(([, h]) => h === head)?.[2] ?? '';
  const arg = (text: string, name: string) => text.match(new RegExp(`\\b${name}\\s+([^;]+);`))?.[1].trim();
  const ws = body('= /ws');
  expect(ws).not.toBe('');
  expect(arg(ws, 'proxy_pass')).toBe(arg(body('/api'), 'proxy_pass'));
  expect(arg(ws, 'proxy_http_version')).toBe('1.1');
  expect(arg(ws, 'proxy_set_header Upgrade')).toBe('$http_upgrade');
  expect(arg(ws, 'proxy_set_header Connection')).toBe('$connection_upgrade');
  expect(parseInt(arg(ws, 'proxy_read_timeout')!, 10)).toBeGreaterThanOrEqual(60);
  // A location with its own add_header would drop the server-level CSP and friends.
  expect(ws).not.toMatch(/\badd_header\b/);
});
