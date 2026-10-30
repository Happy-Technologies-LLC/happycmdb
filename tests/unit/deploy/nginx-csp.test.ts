// HAP-1211 H0. nginx: a location with any add_header of its own drops every server-level one.
import { readFileSync } from 'fs';
import { resolve } from 'path';

const STATIC = /~\* .*\bjs\b/;
const STRICT = [
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
    expect(policy).not.toMatch(/connect-src [^;]*api\.happycmdb\.io/);
  }
});
