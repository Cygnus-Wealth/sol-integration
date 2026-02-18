/**
 * Health Monitor
 *
 * Periodically checks RPC endpoint health. Uses getHealth() for
 * Helius endpoints (which support it) and getSlot() for standard
 * Solana RPC endpoints.
 */

import { Connection } from '@solana/web3.js';

export interface EndpointHealth {
  endpointUrl: string;
  isHealthy: boolean;
  latencyMs: number;
  lastChecked: Date;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  error?: string;
}

export interface HealthMonitorConfig {
  intervalMs: number;
  timeoutMs: number;
  unhealthyThreshold: number;
  healthyThreshold: number;
}

const DEFAULT_CONFIG: HealthMonitorConfig = {
  intervalMs: 30000,
  timeoutMs: 5000,
  unhealthyThreshold: 3,
  healthyThreshold: 2,
};

export class HealthMonitor {
  private readonly config: HealthMonitorConfig;
  private readonly healthState: Map<string, EndpointHealth> = new Map();
  private intervalHandle?: ReturnType<typeof setInterval>;
  private readonly connections: Map<string, Connection> = new Map();
  private onHealthChange?: (url: string, health: EndpointHealth) => void;

  constructor(config: Partial<HealthMonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  registerEndpoint(url: string, connection: Connection): void {
    this.connections.set(url, connection);
    if (!this.healthState.has(url)) {
      this.healthState.set(url, {
        endpointUrl: url,
        isHealthy: true,
        latencyMs: 0,
        lastChecked: new Date(),
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
      });
    }
  }

  unregisterEndpoint(url: string): void {
    this.connections.delete(url);
    this.healthState.delete(url);
  }

  setHealthChangeCallback(callback: (url: string, health: EndpointHealth) => void): void {
    this.onHealthChange = callback;
  }

  start(): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      this.checkAllEndpoints();
    }, this.config.intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  async checkAllEndpoints(): Promise<Map<string, EndpointHealth>> {
    const checks = Array.from(this.connections.entries()).map(
      ([url, connection]) => this.checkEndpoint(url, connection)
    );
    await Promise.allSettled(checks);
    return new Map(this.healthState);
  }

  async checkEndpoint(url: string, connection?: Connection): Promise<EndpointHealth> {
    const conn = connection || this.connections.get(url);
    if (!conn) {
      throw new Error(`No connection registered for ${url}`);
    }

    const state = this.healthState.get(url) || {
      endpointUrl: url,
      isHealthy: true,
      latencyMs: 0,
      lastChecked: new Date(),
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    };

    const start = Date.now();
    try {
      await this.performHealthCheck(url, conn);
      const latency = Date.now() - start;

      state.latencyMs = latency;
      state.lastChecked = new Date();
      state.consecutiveFailures = 0;
      state.consecutiveSuccesses++;
      state.error = undefined;

      if (!state.isHealthy && state.consecutiveSuccesses >= this.config.healthyThreshold) {
        state.isHealthy = true;
        this.onHealthChange?.(url, state);
      }
    } catch (error) {
      const latency = Date.now() - start;
      state.latencyMs = latency;
      state.lastChecked = new Date();
      state.consecutiveSuccesses = 0;
      state.consecutiveFailures++;
      state.error = error instanceof Error ? error.message : String(error);

      if (state.isHealthy && state.consecutiveFailures >= this.config.unhealthyThreshold) {
        state.isHealthy = false;
        this.onHealthChange?.(url, state);
      }
    }

    this.healthState.set(url, state);
    return state;
  }

  getHealth(url: string): EndpointHealth | undefined {
    return this.healthState.get(url);
  }

  getAllHealth(): Map<string, EndpointHealth> {
    return new Map(this.healthState);
  }

  isHealthy(url: string): boolean {
    return this.healthState.get(url)?.isHealthy ?? false;
  }

  private async performHealthCheck(url: string, connection: Connection): Promise<void> {
    const isHelius = url.includes('helius');

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Health check timed out')), this.config.timeoutMs);
    });

    if (isHelius) {
      // Helius supports the getHealth RPC method
      const healthPromise = (connection as any)._rpcRequest('getHealth', []).then(
        (result: any) => {
          if (result?.result !== 'ok') {
            throw new Error(`Helius health check failed: ${JSON.stringify(result)}`);
          }
        }
      );
      await Promise.race([healthPromise, timeoutPromise]);
    } else {
      // Standard endpoints: use getSlot as health indicator
      const slotPromise = connection.getSlot();
      const slot = await Promise.race([slotPromise, timeoutPromise]);
      if (typeof slot !== 'number' || slot <= 0) {
        throw new Error(`Invalid slot returned: ${slot}`);
      }
    }
  }
}
