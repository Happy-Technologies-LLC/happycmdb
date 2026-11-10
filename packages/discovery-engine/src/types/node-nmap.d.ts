// Type declarations for node-nmap package

declare module 'node-nmap' {
  import { EventEmitter } from 'events';

  export interface NmapHost {
    _ip: string;
    hostname?: string;
    mac?: string;
    vendor?: string;
    status?: string;
    openPorts?: Array<{
      _port: number;
      _protocol: string;
      service?: string;
    }>;
    osNmap?: string;
  }

  export class QuickScan extends EventEmitter {
    constructor(range: string, options?: any);
    startScan(): void;
    on(event: 'complete', listener: (data: NmapHost[]) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
  }
}
