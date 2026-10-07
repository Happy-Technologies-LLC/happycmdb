// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/discovery-engine/src/workers/ssh-discovery.worker.ts

import { NodeSSH, SSHExecCommandResponse } from 'node-ssh';
import { logger, withRetry, resolveDiscoveryHost, connectDiscoveryHost, DISCOVERY_TARGET_REFUSED } from '@cmdb/common';
import { DiscoveredCI, DiscoveryConfig, Relationship } from '@cmdb/common';

/**
 * SSH Discovery Worker
 *
 * Performs agentless discovery of Linux/Unix servers via SSH connection.
 * Collects comprehensive system information including:
 * - System identification (hostname, OS, kernel)
 * - Hardware details (CPU, memory, disks)
 * - Network configuration (interfaces, IP addresses)
 * - Running processes and services
 * - Installed packages
 *
 * Implements retry logic and comprehensive error handling.
 * Confidence score: 0.9 (SSH-based discovery is highly reliable but depends on permissions)
 */
export class SSHDiscoveryWorker {
  /**
   * Discover a single host via SSH
   */
  async discoverHost(
    jobId: string,
    host: string,
    username: string,
    privateKeyPath?: string,
    password?: string
  ): Promise<DiscoveredCI> {
    return withRetry(
      async () => {
        const destination = await connectDiscoveryHost(host, await resolveDiscoveryHost(host));
        const ssh = new NodeSSH();

        try {
          // Connect to host
          const connectionConfig: any = {
            host: destination,
            username,
            readyTimeout: 10000,
            keepaliveInterval: 5000,
          };

          if (privateKeyPath) {
            connectionConfig.privateKeyPath = privateKeyPath;
          } else if (password) {
            connectionConfig.password = password;
          } else {
            throw new Error('Either privateKeyPath or password must be provided');
          }

          await ssh.connect(connectionConfig);

          logger.info('SSH connection established', { host });

          // Execute all discovery commands in parallel
          const [
            hostnameResult,
            osReleaseResult,
            kernelResult,
            cpuInfoResult,
            memInfoResult,
            diskInfoResult,
            processesResult,
            networkResult,
            uptimeResult,
            packageCountResult,
            servicesResult,
            usersResult,
            ipRouteResult,
            dnsResult,
            firewallResult,
            cronJobsResult,
            mountsResult,
          ] = await Promise.allSettled([
            ssh.execCommand('hostname'),
            ssh.execCommand('cat /etc/os-release'),
            ssh.execCommand('uname -r'),
            ssh.execCommand('lscpu'),
            ssh.execCommand('free -h'),
            ssh.execCommand('df -h'),
            ssh.execCommand('ps aux | wc -l'),
            ssh.execCommand('ip addr show'),
            ssh.execCommand('uptime -p'),
            this.detectPackageManager(ssh),
            ssh.execCommand('systemctl list-units --type=service --state=running --no-pager'),
            ssh.execCommand('who'),
            ssh.execCommand('ip route'),
            ssh.execCommand('cat /etc/resolv.conf'),
            this.checkFirewall(ssh),
            ssh.execCommand('crontab -l'),
            ssh.execCommand('mount'),
          ]);

          // Parse results
          const hostname = this.getCommandOutput(hostnameResult);
          const osRelease = this.parseOsRelease(this.getCommandOutput(osReleaseResult));
          const kernel = this.getCommandOutput(kernelResult);
          const cpuInfo = this.parseCpuInfo(this.getCommandOutput(cpuInfoResult));
          const memInfo = this.parseMemInfo(this.getCommandOutput(memInfoResult));
          const diskInfo = this.parseDiskInfo(this.getCommandOutput(diskInfoResult));
          const processCount = parseInt(this.getCommandOutput(processesResult).trim()) - 1;
          const networkInfo = this.parseNetworkInfo(this.getCommandOutput(networkResult));
          const uptime = this.getCommandOutput(uptimeResult);
          const packageCount = parseInt(this.getCommandOutput(packageCountResult)) || 0;
          const services = this.parseServices(this.getCommandOutput(servicesResult));
          const users = this.parseUsers(this.getCommandOutput(usersResult));
          const routes = this.parseRoutes(this.getCommandOutput(ipRouteResult));
          const dns = this.parseDNS(this.getCommandOutput(dnsResult));
          const firewall = this.getCommandOutput(firewallResult);
          const cronJobs = this.parseCronJobs(this.getCommandOutput(cronJobsResult));
          const mounts = this.parseMounts(this.getCommandOutput(mountsResult));

          // Get additional system information
          const [
            selinuxResult,
            timezoneResult,
            localeResult,
            loadAvgResult,
            blockDevicesResult,
          ] = await Promise.allSettled([
            ssh.execCommand('getenforce'),
            ssh.execCommand('timedatectl show --property=Timezone --value'),
            ssh.execCommand('locale | grep LANG='),
            ssh.execCommand('cat /proc/loadavg'),
            ssh.execCommand('lsblk -J'),
          ]);

          const selinux = this.getCommandOutput(selinuxResult);
          const timezone = this.getCommandOutput(timezoneResult);
          const locale = this.getCommandOutput(localeResult).replace('LANG=', '');
          const loadAvg = this.parseLoadAvg(this.getCommandOutput(loadAvgResult));
          const blockDevices = this.parseBlockDevices(this.getCommandOutput(blockDevicesResult));

          ssh.dispose();

          // Determine OS family
          const osFamily = this.determineOSFamily(osRelease);

          return {
            _id: `ssh-${hostname || host}`,
            external_id: hostname || host,
            name: hostname || host,
            _type: 'server',
            status: 'active',
            discovered_at: new Date().toISOString(),
            discovery_job_id: jobId,
            discovery_provider: 'ssh',
            confidence_score: 0.9,
            metadata: {
              host,
              hostname,
              _os: {
                _name: osRelease['NAME'] || 'Unknown',
                _version: osRelease['VERSION'] || 'Unknown',
                _version_id: osRelease['VERSION_ID'],
                _pretty_name: osRelease['PRETTY_NAME'],
                _id: osRelease['ID'],
                _id_like: osRelease['ID_LIKE'],
                _family: osFamily,
              },
              _kernel: {
                _version: kernel,
                _architecture: cpuInfo.architecture,
              },
              _cpu: cpuInfo,
              _memory: memInfo,
              _disks: diskInfo,
              _block_devices: blockDevices,
              _mounts: mounts,
              _process_count: processCount,
              _network: {
                _interfaces: networkInfo,
                _routes: routes,
                _dns_servers: dns,
              },
              _system: {
                _uptime: uptime,
                _load_average: loadAvg,
                _timezone: timezone,
                _locale: locale,
                _selinux: selinux,
              },
              _packages: {
                _count: packageCount,
              },
              _services: {
                _running: services,
                _count: services.length,
              },
              _users: {
                _logged_in: users,
                _count: users.length,
              },
              _security: {
                _firewall_status: firewall,
                _selinux_status: selinux,
              },
              _automation: {
                _cron_jobs: cronJobs,
                _cron_job_count: cronJobs.length,
              },
            },
          };
        } catch (error) {
          logger.error('SSH discovery failed', { host, error: (error as Error).message });
          throw error;
        } finally {
          ssh.dispose();
        }
      },
      {
        maxAttempts: 3,
        initialDelay: 2000,
        operationName: 'discoverHost',
      }
    );
  }

  /**
   * Main discovery method called by the discovery processor
   */
  async discover(config: any): Promise<DiscoveredCI[]> {
    const jobId = config._jobId || `ssh-${Date.now()}`;

    // Handle various config formats
    let targets = [];
    if (config._targets) {
      targets = config._targets;
    } else if (config.hosts) {
      targets = config.hosts;
    } else if (config._config?.targets) {
      targets = config._config.targets;
    } else if (config._config?.hosts) {
      targets = config._config.hosts;
    }

    if (!targets || targets.length === 0) {
      logger.warn('No SSH targets provided in config', { jobId, targetCount: 0 });
      return [];
    }

    logger.info('SSH discovery starting', { jobId, targetCount: targets.length });
    return this.discoverHosts(jobId, targets);
  }

  /**
   * Discover multiple hosts in parallel
   */
  async discoverHosts(
    jobId: string,
    hosts: Array<{
      host: string;
      username: string;
      privateKeyPath?: string;
      password?: string;
    }>
  ): Promise<DiscoveredCI[]> {
    await Promise.all(hosts.map(({ host }) => resolveDiscoveryHost(host)));
    logger.info('Starting SSH discovery for multiple hosts', {
      jobId,
      hostCount: hosts.length,
    });

    const results = await Promise.allSettled(
      hosts.map(({ host, username, privateKeyPath, password }) =>
        this.discoverHost(jobId, host, username, privateKeyPath, password)
      )
    );

    const cis: DiscoveredCI[] = [];
    results.forEach(result => {
      if (result.status === 'fulfilled') {
        cis.push(result.value);
      } else {
        if (result.reason instanceof Error && result.reason.message === DISCOVERY_TARGET_REFUSED) {
          throw result.reason;
        }
        logger.error('SSH discovery failed for host', { jobId, error: result.reason });
      }
    });

    logger.info('SSH discovery completed', {
      jobId,
      discovered: cis.length,
      failed: hosts.length - cis.length,
    });

    return cis;
  }

  private getCommandOutput(result: PromiseSettledResult<SSHExecCommandResponse>): string {
    if (result.status === 'fulfilled' && result.value.stdout) {
      return result.value.stdout.trim();
    }
    return '';
  }

  private parseOsRelease(output: string): Record<string, string> {
    const lines = output.split('\n');
    const result: Record<string, string> = {};
    for (const line of lines) {
      const [key, value] = line.split('=');
      if (key && value) {
        result[key] = value.replace(/^["']|["']$/g, '');
      }
    }
    return result;
  }

  private parseCpuInfo(output: string): Record<string, any> {
    const lines = output.split('\n');
    const result: Record<string, any> = {};

    for (const line of lines) {
      if (line.includes('Architecture:')) {
        result.architecture = line.split(':')[1]?.trim();
      } else if (line.includes('CPU(s):')) {
        const match = line.match(/CPU\(s\):\s+(\d+)/);
        if (match) result.count = parseInt(match[1]);
      } else if (line.includes('Model name:')) {
        result.model = line.split(':')[1]?.trim();
      } else if (line.includes('CPU MHz:')) {
        result.mhz = parseFloat(line.split(':')[1]?.trim() || '0');
      } else if (line.includes('CPU max MHz:')) {
        result.max_mhz = parseFloat(line.split(':')[1]?.trim() || '0');
      } else if (line.includes('CPU min MHz:')) {
        result.min_mhz = parseFloat(line.split(':')[1]?.trim() || '0');
      } else if (line.includes('Thread(s) per core:')) {
        result.threads_per_core = parseInt(line.split(':')[1]?.trim() || '1');
      } else if (line.includes('Core(s) per socket:')) {
        result.cores_per_socket = parseInt(line.split(':')[1]?.trim() || '1');
      } else if (line.includes('Socket(s):')) {
        result.sockets = parseInt(line.split(':')[1]?.trim() || '1');
      } else if (line.includes('Vendor ID:')) {
        result.vendor = line.split(':')[1]?.trim();
      } else if (line.includes('Virtualization:')) {
        result.virtualization = line.split(':')[1]?.trim();
      } else if (line.includes('Hypervisor vendor:')) {
        result.hypervisor = line.split(':')[1]?.trim();
      }
    }

    return result;
  }

  private parseMemInfo(output: string): Record<string, any> {
    const lines = output.split('\n');
    const result: Record<string, any> = {};

    if (lines[1]) {
      const parts = lines[1].split(/\s+/);
      result.total = parts[1];
      result.used = parts[2];
      result.free = parts[3];
      result.shared = parts[4];
      result.buff_cache = parts[5];
      result.available = parts[6];
    }

    // Also parse swap if available
    if (lines[2]) {
      const swapParts = lines[2].split(/\s+/);
      result.swap = {
        _total: swapParts[1],
        _used: swapParts[2],
        _free: swapParts[3],
      };
    }

    return result;
  }

  private parseDiskInfo(output: string): Array<Record<string, any>> {
    const lines = output.split('\n').slice(1); // Skip header
    return lines
      .filter((line) => line.trim())
      .map((line) => {
        const parts = line.split(/\s+/);
        return {
          _filesystem: parts[0],
          _size: parts[1],
          _used: parts[2],
          _available: parts[3],
          _use_percent: parts[4],
          _mount_point: parts[5],
        };
      });
  }

  private parseNetworkInfo(output: string): Array<Record<string, any>> {
    const interfaces: Array<Record<string, any>> = [];
    const blocks = output.split('\n\n');

    for (const block of blocks) {
      const lines = block.split('\n');
      const ifMatch = lines[0]?.match(/^\d+:\s+(\S+):/);

      if (ifMatch) {
        const iface: Record<string, any> = {
          _name: ifMatch[1],
          _addresses: [],
          _mac: undefined,
          _state: undefined,
        };

        for (const line of lines) {
          if (line.includes('state ')) {
            const stateMatch = line.match(/state\s+(\S+)/);
            if (stateMatch) iface._state = stateMatch[1];
          }
          if (line.includes('link/ether ')) {
            const macMatch = line.match(/link\/ether\s+(\S+)/);
            if (macMatch) iface._mac = macMatch[1];
          }
          if (line.includes('inet ')) {
            const addrMatch = line.match(/inet\s+(\S+)/);
            if (addrMatch) {
              iface._addresses.push({
                _type: 'ipv4',
                _address: addrMatch[1],
              });
            }
          }
          if (line.includes('inet6 ')) {
            const addr6Match = line.match(/inet6\s+(\S+)/);
            if (addr6Match) {
              iface._addresses.push({
                _type: 'ipv6',
                _address: addr6Match[1],
              });
            }
          }
        }

        interfaces.push(iface);
      }
    }

    return interfaces;
  }

  private parseServices(output: string): string[] {
    const lines = output.split('\n').slice(1); // Skip header
    const services: string[] = [];

    for (const line of lines) {
      const match = line.match(/^\s*(\S+\.service)/);
      if (match) {
        services.push(match[1].replace('.service', ''));
      }
    }

    return services;
  }

  private parseUsers(output: string): Array<Record<string, any>> {
    const lines = output.split('\n');
    const users: Array<Record<string, any>> = [];

    for (const line of lines) {
      if (line.trim()) {
        const parts = line.split(/\s+/);
        if (parts[0]) {
          users.push({
            _username: parts[0],
            _terminal: parts[1],
            _login_time: parts.slice(2).join(' '),
          });
        }
      }
    }

    return users;
  }

  private parseRoutes(output: string): Array<Record<string, any>> {
    const lines = output.split('\n');
    const routes: Array<Record<string, any>> = [];

    for (const line of lines) {
      if (line.trim() && !line.startsWith('default')) {
        const parts = line.split(/\s+/);
        if (parts[0] && parts[0] !== 'default') {
          routes.push({
            _destination: parts[0],
            _gateway: parts[2] === 'via' ? parts[3] : 'direct',
            _interface: parts[parts.length - 1],
          });
        }
      } else if (line.startsWith('default')) {
        const parts = line.split(/\s+/);
        routes.push({
          _destination: 'default',
          _gateway: parts[2],
          _interface: parts[4],
        });
      }
    }

    return routes;
  }

  private parseDNS(output: string): string[] {
    const lines = output.split('\n');
    const servers: string[] = [];

    for (const line of lines) {
      if (line.startsWith('nameserver')) {
        const server = line.split(/\s+/)[1];
        if (server) servers.push(server);
      }
    }

    return servers;
  }

  private parseCronJobs(output: string): string[] {
    if (output.includes('no crontab')) {
      return [];
    }

    const lines = output.split('\n');
    return lines.filter(line => line.trim() && !line.startsWith('#'));
  }

  private parseMounts(output: string): Array<Record<string, any>> {
    const lines = output.split('\n');
    const mounts: Array<Record<string, any>> = [];

    for (const line of lines) {
      if (line.trim()) {
        const parts = line.split(/\s+/);
        mounts.push({
          _device: parts[0],
          _mount_point: parts[2],
          _filesystem_type: parts[4],
          _options: parts[5]?.replace(/[()]/g, '').split(','),
        });
      }
    }

    return mounts;
  }

  private parseLoadAvg(output: string): Record<string, any> {
    const parts = output.split(/\s+/);
    return {
      '1min': parseFloat(parts[0] || '0'),
      '5min': parseFloat(parts[1] || '0'),
      '15min': parseFloat(parts[2] || '0'),
      _running_processes: parts[3]?.split('/')[0],
      _total_processes: parts[3]?.split('/')[1],
    };
  }

  private parseBlockDevices(output: string): Array<Record<string, any>> {
    try {
      const data = JSON.parse(output);
      return data.blockdevices || [];
    } catch {
      return [];
    }
  }

  private async detectPackageManager(ssh: NodeSSH): Promise<SSHExecCommandResponse> {
    // Try different package managers
    const commands = [
      'rpm -qa | wc -l',          // RPM-based (RHEL, CentOS, Fedora)
      'dpkg -l | wc -l',          // Debian-based (Ubuntu, Debian)
      'pacman -Q | wc -l',        // Arch-based
      'apk list | wc -l',         // Alpine
    ];

    for (const cmd of commands) {
      try {
        const result = await ssh.execCommand(cmd);
        if (result.code === 0 && result.stdout) {
          return result;
        }
      } catch {
        continue;
      }
    }

    return { stdout: '0', stderr: '', code: 0, signal: null };
  }

  private async checkFirewall(ssh: NodeSSH): Promise<SSHExecCommandResponse> {
    // Try different firewall commands
    const commands = [
      'firewall-cmd --state',         // firewalld
      'ufw status',                   // ufw
      'iptables -L -n | head -n 5',   // iptables
    ];

    for (const cmd of commands) {
      try {
        const result = await ssh.execCommand(cmd);
        if (result.code === 0) {
          return result;
        }
      } catch {
        continue;
      }
    }

    return { stdout: 'unknown', stderr: '', code: 0, signal: null };
  }

  private determineOSFamily(osRelease: Record<string, string>): string {
    const id = (osRelease['ID'] || '').toLowerCase();
    const idLike = (osRelease['ID_LIKE'] || '').toLowerCase();

    if (id.includes('ubuntu') || id.includes('debian') || idLike.includes('debian')) {
      return 'debian';
    } else if (id.includes('rhel') || id.includes('centos') || id.includes('fedora') || idLike.includes('rhel') || idLike.includes('fedora')) {
      return 'redhat';
    } else if (id.includes('suse') || idLike.includes('suse')) {
      return 'suse';
    } else if (id.includes('arch')) {
      return 'arch';
    } else if (id.includes('alpine')) {
      return 'alpine';
    }

    return 'unknown';
  }

  /**
   * Infers relationships between discovered servers
   */
  inferRelationships(discoveredCIs: DiscoveredCI[]): Relationship[] {
    const relationships: Relationship[] = [];

    // Create lookup maps
    const serversBySubnet = new Map<string, DiscoveredCI[]>();

    // Build lookup maps
    for (const ci of discoveredCIs) {
      const metadata = ci.metadata as any;

      // Index servers by subnet (first 3 octets of IP)
      if (metadata.network?.interfaces) {
        for (const iface of metadata.network.interfaces) {
          for (const addr of iface.addresses || []) {
            if (addr.type === 'ipv4' && !addr.address.startsWith('127.')) {
              const subnet = addr.address.split('/')[0].split('.').slice(0, 3).join('.');
              if (!serversBySubnet.has(subnet)) {
                serversBySubnet.set(subnet, []);
              }
              serversBySubnet.get(subnet)!.push(ci);
            }
          }
        }
      }
    }

    // Infer relationships based on network proximity
    for (const ci of discoveredCIs) {
      const metadata = ci.metadata as any;

      // Servers on same subnet: LOCATED_IN relationship
      if (metadata.network?.interfaces) {
        for (const iface of metadata.network.interfaces) {
          for (const addr of iface.addresses || []) {
            if (addr.type === 'ipv4' && !addr.address.startsWith('127.')) {
              const subnet = addr.address.split('/')[0].split('.').slice(0, 3).join('.');
              const serversInSubnet = serversBySubnet.get(subnet) || [];

              for (const otherServer of serversInSubnet) {
                if (otherServer._id !== ci._id) {
                  relationships.push({
                    _from_id: ci._id,
                    _to_id: otherServer._id,
                    _type: 'LOCATED_IN',
                    properties: {
                      subnet,
                      confidence: 0.7,
                      inferred_from: 'same_subnet',
                    },
                  });
                }
              }
            }
          }
        }
      }
    }

    logger.info('Inferred SSH discovery relationships', {
      count: relationships.length,
    });

    return relationships;
  }
}
