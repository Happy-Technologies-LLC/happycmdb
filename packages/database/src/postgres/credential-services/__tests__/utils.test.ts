// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { performance } from 'perf_hooks';
import { ipToInt, isIpIntInCidr, matchGlob } from '../utils';

const inCidr = (ip: string, cidr: string) => isIpIntInCidr(ipToInt(ip), cidr);

describe('matchGlob', () => {
  it('stays fast on a pattern whose repeated * made the regex form backtrack for seconds', () => {
    const started = performance.now();
    const matched = matchGlob('a'.repeat(60) + 'c', '*a'.repeat(6) + '*b');
    const elapsed = performance.now() - started;

    expect(matched).toBe(false);
    expect(elapsed).toBeLessThan(100);
  }, 5000);

  it('stays fast on a long hostile pattern and still finds a real match', () => {
    const hostile = '*a'.repeat(500) + '*b';
    const started = performance.now();
    expect(matchGlob('a'.repeat(500) + 'c', hostile)).toBe(false);
    expect(matchGlob('a'.repeat(600) + 'b', hostile)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  }, 5000);

  it('treats regex metacharacters as literals', () => {
    expect(matchGlob('evil.com', 'good.net|evil.com')).toBe(false);
    expect(matchGlob('x.y', 'x|y')).toBe(false);
    expect(matchGlob('a+b.example.com', 'a+b.example.com')).toBe(true);
    expect(matchGlob('aab.example.com', 'a+b.example.com')).toBe(false);
    expect(matchGlob('aaa!', '(a+)+')).toBe(false);
    expect(matchGlob('(a+)+', '(a+)+')).toBe(true);
    expect(matchGlob('ab', '[ab][ab]')).toBe(false);
    expect(matchGlob('a.b', 'a.b')).toBe(true);
    expect(matchGlob('axb', 'a.b')).toBe(false);
  });

  it('keeps the glob semantics of * and ?, case-insensitively', () => {
    expect(matchGlob('db1.example.com', '*.example.com')).toBe(true);
    expect(matchGlob('DB1.EXAMPLE.COM', '*.example.com')).toBe(true);
    expect(matchGlob('db1.example.com', '*.EXAMPLE.com')).toBe(true);
    expect(matchGlob('example.com', '*.example.com')).toBe(false);
    expect(matchGlob('db1.example.com', 'db?.example.com')).toBe(true);
    expect(matchGlob('db12.example.com', 'db?.example.com')).toBe(false);
    expect(matchGlob('db.example.com', 'db?.example.com')).toBe(false);
    expect(matchGlob('anything.at.all', '*')).toBe(true);
    expect(matchGlob('', '*')).toBe(true);
    expect(matchGlob('web-01.prod.example.com', 'web-*.*.example.com')).toBe(true);
    expect(matchGlob('web-01.example.com', 'web-*.*.example.com')).toBe(false);
    expect(matchGlob('abcabc', '*abc')).toBe(true);
    expect(matchGlob('abcabd', '*abc')).toBe(false);
    expect(matchGlob('abc', 'abc**')).toBe(true);
  });

  it('matches the empty pattern only against the empty hostname', () => {
    expect(matchGlob('', '')).toBe(true);
    expect(matchGlob('host', '')).toBe(false);
    expect(matchGlob('', 'host')).toBe(false);
  });

  it('does not let a pattern match a longer or shorter hostname', () => {
    expect(matchGlob('host1', 'host')).toBe(false);
    expect(matchGlob('hos', 'host')).toBe(false);
    expect(matchGlob('host', 'host')).toBe(true);
  });
});

describe('ipToInt', () => {
  it('parses a dotted quad and refuses everything else with null', () => {
    expect(ipToInt('10.1.2.3')).toBe(0x0a010203);
    expect(ipToInt('255.255.255.255')).toBe(0xffffffff);
    expect(ipToInt('1.2.3')).toBeNull();
    expect(ipToInt('1.2.3.256')).toBeNull();
    expect(ipToInt('a.b.c.d')).toBeNull();
    expect(ipToInt('')).toBeNull();
  });

  it('refuses an overlong input before it is split, so nothing is allocated for it', () => {
    const split = jest.spyOn(String.prototype, 'split');
    try {
      expect(ipToInt('1.'.repeat(5000) + '1')).toBeNull();
      expect(ipToInt('1'.repeat(16))).toBeNull();
      expect(split).not.toHaveBeenCalled();
      // 15 characters is the longest valid address and is still parsed
      expect(ipToInt('255.255.255.255')).not.toBeNull();
      expect(split).toHaveBeenCalledTimes(1);
    } finally {
      split.mockRestore();
    }
  });
});

describe('isIpIntInCidr', () => {
  it('matches the whole IPv4 space for /0 and honours real prefixes', () => {
    expect(inCidr('10.1.2.3', '0.0.0.0/0')).toBe(true);
    expect(inCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(inCidr('10.1.2.3', '11.0.0.0/8')).toBe(false);
    expect(inCidr('10.1.2.3', '10.1.2.3/32')).toBe(true);
    expect(inCidr('10.1.2.4', '10.1.2.3/32')).toBe(false);
  });

  it('refuses out-of-range and non-numeric prefixes', () => {
    expect(inCidr('10.1.2.3', '10.1.2.3/33')).toBe(false);
    expect(inCidr('10.1.2.3', '10.1.2.3/-1')).toBe(false);
    expect(inCidr('10.1.2.3', '10.1.2.3/abc')).toBe(false);
  });

  it('matches nothing, without throwing, for an unparsed address or a malformed or oversize network', () => {
    expect(isIpIntInCidr(null, '0.0.0.0/0')).toBe(false);
    expect(inCidr('10.1.2.3', 'not-a-network/8')).toBe(false);
    expect(inCidr('10.1.2.3', '10.1.2.3')).toBe(false);
    expect(inCidr('10.1.2.3', '0.0.0.0/0' + '0'.repeat(100))).toBe(false);
  });
});
