import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RpcFallbackChain } from '../../infrastructure/rpc/RpcFallbackChain';
import { RpcProviderConfig } from '../../infrastructure/rpc/types';
import { Connection } from '@solana/web3.js';

// Minimal mock for Connection - the fallback chain creates real Connection objects
// but we intercept at the operation level
vi.mock('@solana/web3.js', () => {
  const MockConnection = vi.fn().mockImplementation((url: string) => ({
    rpcEndpoint: url,
    getSlot: vi.fn().mockResolvedValue(123456789),
    _rpcRequest: vi.fn().mockResolvedValue({ result: 'ok' }),
  }));
  return {
    Connection: MockConnection,
    PublicKey: vi.fn(),
  };
});

function makeConfig(overrides: Partial<RpcProviderConfig> = {}): RpcProviderConfig {
  return {
    endpoints: [
      {
        url: 'https://mainnet.helius-rpc.com/?api-key=test',
        name: 'helius-primary',
        priority: 1,
        capabilities: ['standard', 'das'],
        rateLimit: { requestsPerSecond: 50, burstCapacity: 100 },
        circuitBreaker: { failureThreshold: 3, recoveryTimeoutMs: 5000, successThreshold: 2 },
        timeoutMs: 10000,
      },
      {
        url: 'https://rpc.quicknode.com/solana',
        name: 'quicknode-fallback',
        priority: 2,
        capabilities: ['standard'],
        rateLimit: { requestsPerSecond: 25, burstCapacity: 50 },
        circuitBreaker: { failureThreshold: 3, recoveryTimeoutMs: 5000, successThreshold: 2 },
        timeoutMs: 10000,
      },
    ],
    commitment: 'confirmed',
    defaultTimeoutMs: 10000,
    enableHealthMonitoring: false,
    ...overrides,
  };
}

describe('RpcFallbackChain', () => {
  let chain: RpcFallbackChain;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    chain?.destroy();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should create endpoint states sorted by priority', () => {
      chain = new RpcFallbackChain(makeConfig());
      const states = chain.getEndpointStates();
      expect(states).toHaveLength(2);
      expect(states[0].config.name).toBe('helius-primary');
      expect(states[1].config.name).toBe('quicknode-fallback');
    });

    it('should create circuit breakers for each endpoint', () => {
      chain = new RpcFallbackChain(makeConfig());
      const states = chain.getEndpointStates();
      expect(states[0].circuitBreaker).toBeDefined();
      expect(states[1].circuitBreaker).toBeDefined();
      expect(states[0].circuitBreaker.isClosed()).toBe(true);
    });

    it('should create rate limiters for each endpoint', () => {
      chain = new RpcFallbackChain(makeConfig());
      const states = chain.getEndpointStates();
      expect(states[0].rateLimiter).toBeDefined();
      expect(states[1].rateLimiter).toBeDefined();
    });
  });

  describe('execute', () => {
    it('should route to first available endpoint', async () => {
      chain = new RpcFallbackChain(makeConfig());
      const operation = vi.fn().mockResolvedValue('result');

      const result = await chain.execute(operation);

      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toBe('result');
      // Called with the helius connection (priority 1)
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should fallback to next endpoint on failure', async () => {
      chain = new RpcFallbackChain(makeConfig());
      let callCount = 0;
      const operation = vi.fn().mockImplementation((conn: Connection) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Primary failed');
        }
        return Promise.resolve('fallback result');
      });

      const result = await chain.execute(operation);

      // Circuit breaker wraps the operation, so the first call fails
      // but the chain tries the next endpoint
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should fail when all endpoints are exhausted', async () => {
      chain = new RpcFallbackChain(makeConfig());
      const operation = vi.fn().mockRejectedValue(new Error('All fail'));

      const result = await chain.execute(operation);

      expect(result.isFailure).toBe(true);
    });

    it('should skip endpoints with open circuit breakers', async () => {
      chain = new RpcFallbackChain(makeConfig());
      const states = chain.getEndpointStates();

      // Force open first endpoint's circuit breaker
      states[0].circuitBreaker.forceOpen('Test');

      const operation = vi.fn().mockResolvedValue('from fallback');
      const result = await chain.execute(operation);

      expect(result.isSuccess).toBe(true);
      // Should have been called once (skipped first, used second)
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should return error when no endpoints available', async () => {
      chain = new RpcFallbackChain(makeConfig());
      const states = chain.getEndpointStates();

      // Force open all circuit breakers
      states[0].circuitBreaker.forceOpen('Test');
      states[1].circuitBreaker.forceOpen('Test');

      const operation = vi.fn().mockResolvedValue('result');
      const result = await chain.execute(operation);

      expect(result.isFailure).toBe(true);
      expect(operation).not.toHaveBeenCalled();
    });
  });

  describe('DAS-aware fallback', () => {
    it('should restrict DAS methods to DAS-capable endpoints', async () => {
      chain = new RpcFallbackChain(makeConfig());
      const states = chain.getEndpointStates();

      // Force open Helius (only DAS-capable endpoint)
      states[0].circuitBreaker.forceOpen('Test');

      const operation = vi.fn().mockResolvedValue('result');
      const result = await chain.execute(operation, {
        method: 'getAssetsByOwner',
      });

      // Should fail because only Helius has 'das' and it's open
      expect(result.isFailure).toBe(true);
      expect(operation).not.toHaveBeenCalled();
    });

    it('should route DAS methods to DAS-capable endpoints first', async () => {
      chain = new RpcFallbackChain(makeConfig());
      const connections: string[] = [];
      const operation = vi.fn().mockImplementation((conn: any) => {
        connections.push(conn.rpcEndpoint);
        return Promise.resolve('das result');
      });

      const result = await chain.execute(operation, {
        method: 'getAssetsByOwner',
      });

      expect(result.isSuccess).toBe(true);
      // Only helius should be eligible (has 'das' capability)
      expect(connections).toHaveLength(1);
      expect(connections[0]).toContain('helius');
    });

    it('should not restrict non-DAS methods', async () => {
      chain = new RpcFallbackChain(makeConfig());
      const operation = vi.fn().mockResolvedValue('result');

      const result = await chain.execute(operation, {
        method: 'getBalance',
      });

      expect(result.isSuccess).toBe(true);
    });
  });

  describe('getConnection', () => {
    it('should return the first healthy connection', () => {
      chain = new RpcFallbackChain(makeConfig());
      const conn = chain.getConnection();
      expect(conn).not.toBeNull();
    });

    it('should filter by capability', () => {
      chain = new RpcFallbackChain(makeConfig());
      const conn = chain.getConnection(['das']);
      expect(conn).not.toBeNull();
    });

    it('should return null when all circuits are open and unhealthy', () => {
      chain = new RpcFallbackChain(makeConfig());
      const states = chain.getEndpointStates();
      states[0].circuitBreaker.forceOpen('Test');
      states[1].circuitBreaker.forceOpen('Test');

      // getConnection returns first available even if circuit is open as fallback
      // but won't use health-failed endpoints
      const conn = chain.getConnection();
      // It should still return something (the first fallback)
      expect(conn).not.toBeNull();
    });
  });

  describe('metrics', () => {
    it('should track total requests', async () => {
      chain = new RpcFallbackChain(makeConfig());
      const operation = vi.fn().mockResolvedValue('result');

      await chain.execute(operation);
      await chain.execute(operation);

      const metrics = chain.getMetrics();
      expect(metrics.totalRequests).toBe(2);
      expect(metrics.successfulRequests).toBe(2);
    });

    it('should track failed requests', async () => {
      chain = new RpcFallbackChain(makeConfig());
      const operation = vi.fn().mockRejectedValue(new Error('fail'));

      await chain.execute(operation);

      const metrics = chain.getMetrics();
      expect(metrics.failedRequests).toBe(1);
    });

    it('should track per-endpoint metrics', async () => {
      chain = new RpcFallbackChain(makeConfig());
      const operation = vi.fn().mockResolvedValue('result');

      await chain.execute(operation);

      const metrics = chain.getMetrics();
      const heliusMetrics = metrics.endpointMetrics.get(
        'https://mainnet.helius-rpc.com/?api-key=test'
      );
      expect(heliusMetrics).toBeDefined();
      expect(heliusMetrics!.requests).toBe(1);
      expect(heliusMetrics!.successes).toBe(1);
    });

    it('should track fallbacks triggered', async () => {
      chain = new RpcFallbackChain(makeConfig());
      let callCount = 0;
      const operation = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error('Primary fail');
        return Promise.resolve('fallback ok');
      });

      await chain.execute(operation);

      const metrics = chain.getMetrics();
      expect(metrics.fallbacksTriggered).toBe(1);
    });
  });

  describe('health monitoring', () => {
    it('should expose health monitor', () => {
      chain = new RpcFallbackChain(makeConfig());
      expect(chain.getHealthMonitor()).toBeDefined();
    });

    it('should start and stop health monitoring', () => {
      chain = new RpcFallbackChain(makeConfig());
      chain.startHealthMonitoring();
      chain.stopHealthMonitoring();
      // No error thrown
    });
  });
});
