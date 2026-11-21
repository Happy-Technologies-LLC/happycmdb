// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { lookup } from 'dns/promises';
import { execFile } from 'child_process';
import { nmapTool } from '../nmap-tool';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('child_process', () => ({ execFile: jest.fn() }));

const mockedLookup = jest.mocked(lookup);
const mockedExecFile = jest.mocked(execFile);

/** Make the mocked nmap subprocess print `stdout`. */
function nmapPrints(stdout: string): void {
  mockedExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, { stdout, stderr: '' });
  }) as never);
}

function scan(params: Record<string, unknown> = {}): Promise<any> {
  return nmapTool.execute({ host: 'public.example', ...params });
}

function nmapXml(host: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nmaprun>
<!-- Nmap 7.94 scan initiated as: nmap -sT -p 22,80,443 -oX - 8.8.8.8 -->
<nmaprun scanner="nmap" args="nmap -sT -p 22,80,443 -oX - 8.8.8.8" start="1700000000" version="7.94">
<scaninfo type="connect" protocol="tcp" numservices="3" services="22,80,443"/>
${host}
<runstats><finished time="1700000001"/><hosts up="1" down="0" total="1"/></runstats>
</nmaprun>`;
}

function upHost(ports: string, extra = ''): string {
  return `<host starttime="1" endtime="2"><status state="up" reason="syn-ack" reason_ttl="0"/>
<address addr="8.8.8.8" addrtype="ipv4"/>
<ports>${ports}</ports>
${extra}
<times srtt="1000" rttvar="500" to="100000"/></host>`;
}

const SSH_OPEN = `<port protocol="tcp" portid="22"><state state="open" reason="syn-ack" reason_ttl="0"/><service name="ssh" product="OpenSSH" version="9.6" method="probed" conf="10"><cpe>cpe:/a:openbsd:openssh:9.6</cpe></service></port>`;
const HTTP_CLOSED = `<port protocol="tcp" portid="80"><state state="closed" reason="conn-refused" reason_ttl="0"/><service name="http" method="table" conf="3"/></port>`;
const HTTPS_FILTERED = `<port protocol="tcp" portid="443"><state state="filtered" reason="no-response" reason_ttl="0"/><service name="https" method="table" conf="3"/></port>`;

beforeEach(() => {
  mockedLookup.mockReset();
  mockedLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
  mockedExecFile.mockReset();
});

describe('nmap_scan parses nmap -oX output', () => {
  it('reports the open ssh port and ignores closed and filtered ports', async () => {
    nmapPrints(nmapXml(upHost(SSH_OPEN + HTTP_CLOSED + HTTPS_FILTERED)));

    await expect(scan({ ports: '22,80,443' })).resolves.toEqual({
      status: 'up',
      openPorts: [22],
      services: [{ port: 22, protocol: 'tcp', state: 'open', service: 'ssh', version: 'OpenSSH 9.6' }],
      osGuess: null,
    });
  });

  it('joins product, version and extrainfo with single spaces for a -sV scan', async () => {
    const http = `<port protocol="tcp" portid="80"><state state="open"/><service name="http" product="Apache httpd" version="2.4.58" extrainfo="(Ubuntu)" method="probed" conf="10"/></port>`;
    nmapPrints(nmapXml(upHost(http)));

    const result = await scan({ scanType: 'version' });

    expect(result.services).toEqual([
      { port: 80, protocol: 'tcp', state: 'open', service: 'http', version: 'Apache httpd 2.4.58 (Ubuntu)' },
    ]);
  });

  it('leaves version empty when nmap detected only a service name', async () => {
    const port = `<port protocol="tcp" portid="25"><state state="open"/><service name="smtp" method="table" conf="3"/></port>`;
    nmapPrints(nmapXml(upHost(port)));

    expect((await scan()).services[0]).toMatchObject({ service: 'smtp', version: '' });
  });

  it('reports down hosts with no ports', async () => {
    nmapPrints(nmapXml(`<host><status state="down" reason="no-response"/><address addr="8.8.8.8" addrtype="ipv4"/></host>`));

    await expect(scan()).resolves.toEqual({ status: 'down', openPorts: [], services: [], osGuess: null });
  });

  it('keeps status unknown when the host element has no usable status', async () => {
    nmapPrints(nmapXml(''));

    await expect(scan()).resolves.toEqual({ status: 'unknown', openPorts: [], services: [], osGuess: null });
  });

  it('takes the first osmatch as the OS guess', async () => {
    const os = `<os><osmatch name="Linux 5.15 - 6.1" accuracy="100" line="1"><osclass type="general purpose" vendor="Linux"/></osmatch><osmatch name="Linux 4.19" accuracy="90" line="2"/></os>`;
    nmapPrints(nmapXml(upHost(SSH_OPEN, os)));

    expect((await scan()).osGuess).toBe('Linux 5.15 - 6.1');
  });

  it('is not misled by the status of a hosthint element', async () => {
    const hint = `<hosthint><status state="up" reason="unknown-response" reason_ttl="0"/><address addr="8.8.8.8" addrtype="ipv4"/></hosthint>`;
    nmapPrints(nmapXml(hint + `<host><status state="down" reason="no-response"/></host>`));

    expect((await scan()).status).toBe('down');
  });

  it('decodes XML entities in attribute values exactly once', async () => {
    const port = `<port protocol="tcp" portid="8080"><state state="open"/><service name="a&amp;b" product="Acme &lt;Proxy&gt;" version="&quot;1.0&quot;" extrainfo="&amp;lt; &apos;x&apos;"/></port>`;
    nmapPrints(nmapXml(upHost(port)));

    expect((await scan()).services[0]).toMatchObject({
      service: 'a&b',
      version: `Acme <Proxy> "1.0" &lt; 'x'`,
    });
  });

  it('accepts a literal > inside a quoted attribute value', async () => {
    const port = `<port protocol="tcp" portid="9000"><state state="open"/><service name="x" product="a > b"/></port>`;
    nmapPrints(nmapXml(upHost(port)));

    expect((await scan()).services[0]).toMatchObject({ port: 9000, version: 'a > b' });
  });
});

describe('nmap_scan hostile and malformed output', () => {
  it('skips an open port whose portid is not a valid port number', async () => {
    const bad = ['abc', '', '-1', '0', '65536', '22x', '1e3'].map(
      (id) => `<port protocol="tcp" portid="${id}"><state state="open"/><service name="bogus"/></port>`,
    );
    nmapPrints(nmapXml(upHost(bad.join('') + SSH_OPEN)));

    const result = await scan();

    expect(result.openPorts).toEqual([22]);
    expect(result.services).toHaveLength(1);
  });

  it('skips a port with an unknown protocol', async () => {
    const port = `<port protocol="sctp" portid="22"><state state="open"/><service name="ssh"/></port>`;
    nmapPrints(nmapXml(upHost(port)));

    expect((await scan()).openPorts).toEqual([]);
  });

  it('keeps script-like service text as plain text', async () => {
    const port = `<port protocol="tcp" portid="80"><state state="open"/><service name="&lt;script&gt;alert(1)&lt;/script&gt;" product="&lt;img src=x onerror=1&gt;"/></port>`;
    nmapPrints(nmapXml(upHost(port)));

    const [service] = (await scan()).services;

    expect(service.service).toBe('<script>alert(1)</script>');
    expect(service.version).toBe('<img src=x onerror=1>');
  });

  it('does not take ports out of an XML comment', async () => {
    const comment = `<!-- <port protocol="tcp" portid="23"><state state="open"/></port> -->`;
    nmapPrints(nmapXml(upHost(SSH_OPEN + comment)));

    expect((await scan()).openPorts).toEqual([22]);
  });

  it('does not parse the old plain-text format', async () => {
    const text = 'Host is up (0.0010s latency).\nPORT   STATE SERVICE VERSION\n80/tcp open  http    nginx 1.25\n';
    nmapPrints(text);

    const result = await scan();

    expect(result.status).toBe('error');
    expect(result.openPorts).toEqual([]);
    expect(result.services).toEqual([]);
    expect(result.rawOutput).toBe(text);
  });

  it('truncates rawOutput of non-XML output to 500 characters', async () => {
    nmapPrints('x'.repeat(900));

    expect((await scan()).rawOutput).toHaveLength(500);
  });

  it('treats empty output as an error, not as nothing open', async () => {
    nmapPrints('');

    const result = await scan();

    expect(result.status).toBe('error');
    expect(result.openPorts).toEqual([]);
  });
});

describe('nmap_scan subprocess arguments', () => {
  it.each([
    ['quick', '-sT', undefined, ['--top-ports', '100']],
    ['version', '-sV', '22,80', ['-p', '22,80']],
  ])('passes %s scans to nmap with XML on stdout', async (scanType, flag, ports, portArgs) => {
    nmapPrints(nmapXml(upHost(SSH_OPEN)));

    await scan({ scanType, ports });

    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockedExecFile.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('nmap');
    expect(args).toEqual([flag, ...portArgs, '8.8.8.8', '-oX', '-']);
  });
});
