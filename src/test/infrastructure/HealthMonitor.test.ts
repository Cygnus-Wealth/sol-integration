import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HealthMonitor } from '../../infrastructure/rpc/HealthMonitor';

// Mock Connection - resolves synchronously to work with fake timers
function createMockConnection(opts: { healthy?: boolean; isHelius?: boolean } = {}) {
  const { healthy = true } = opts;
  const connection = {
    getSlot: vi.fn().mockImplementation(() => {
      if (!healthy) return Promise.reject(new Error('RPC error'));
      return Promise.resolve(123456789);
    }),
    _rpcRequest: vi.fn().mockImplementation(() => {
      if (!healthy) return Promise.reject(new Error('Helius health check failed'));
      return Promise.resolve({ result: 'ok' });
    }),
  };
  return connection as any;
}

describe('HealthMonitor', () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    monitor = new HealthMonitor({
      intervalMs: 10000,
      timeoutMs: 5000,
      unhealthyThreshold: 2,
      healthyThreshold: 2,
    });
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  describe('registerEndpoint', () => {
    it('should register an endpoint with healthy initial state', () => {
      const conn = createMockConnection();
      monitor.registerEndpoint('https://rpc.example.com', conn);

      const health = monitor.getHealth('https://rpc.example.com');
      expect(health).toBeDefined();
      expect(health!.isHealthy).toBe(true);
      expect(health!.consecutiveFailures).toBe(0);
    });

    it('should not overwrite existing health state on re-register', () => {
      const conn = createMockConnection();
      monitor.registerEndpoint('https://rpc.example.com', conn);

      const original = monitor.getHealth('https://rpc.example.com');
      monitor.registerEndpoint('https://rpc.example.com', conn);

      expect(monitor.getHealth('https://rpc.example.com')).toEqual(original);
    });
  });

  describe('unregisterEndpoint', () => {
    it('should remove endpoint from monitoring', () => {
      const conn = createMockConnection();
      monitor.registerEndpoint('https://rpc.example.com', conn);
      monitor.unregisterEndpoint('https://rpc.example.com');

      expect(monitor.getHealth('https://rpc.example.com')).toBeUndefined();
    });
  });

  describe('checkEndpoint', () => {
    it('should mark endpoint healthy on successful check', async () => {
      const conn = createMockConnection({ healthy: true });
      monitor.registerEndpoint('https://rpc.example.com', conn);

      const health = await monitor.checkEndpoint('https://rpc.example.com', conn);
      expect(health.isHealthy).toBe(true);
      expect(health.consecutiveSuccesses).toBe(1);
      expect(health.consecutiveFailures).toBe(0);
    });

    it('should increment failures on failed check', async () => {
      const conn = createMockConnection({ healthy: false });
      monitor.registerEndpoint('https://rpc.fail.com', conn);

      const health = await monitor.checkEndpoint('https://rpc.fail.com', conn);
      expect(health.consecutiveFailures).toBe(1);
      expect(health.error).toBeDefined();
    });

    it('should transition to unhealthy after threshold failures', async () => {
      const conn = createMockConnection({ healthy: false });
      monitor.registerEndpoint('https://rpc.fail.com', conn);

      await monitor.checkEndpoint('https://rpc.fail.com', conn);
      const health = await monitor.checkEndpoint('https://rpc.fail.com', conn);

      expect(health.isHealthy).toBe(false);
      expect(health.consecutiveFailures).toBe(2);
    });

    it('should use getHealth() for Helius endpoints', async () => {
      const conn = createMockConnection({ healthy: true, isHelius: true });
      const url = 'https://mainnet.helius-rpc.com/?api-key=test';
      monitor.registerEndpoint(url, conn);

      await monitor.checkEndpoint(url, conn);
      expect(conn._rpcRequest).toHaveBeenCalledWith('getHealth', []);
    });

    it('should use getSlot() for standard endpoints', async () => {
      const conn = createMockConnection({ healthy: true });
      const url = 'https://rpc.standard.com';
      monitor.registerEndpoint(url, conn);

      await monitor.checkEndpoint(url, conn);
      expect(conn.getSlot).toHaveBeenCalled();
    });

    it('should fire health change callback when status changes', async () => {
      const callback = vi.fn();
      monitor.setHealthChangeCallback(callback);

      const conn = createMockConnection({ healthy: false });
      monitor.registerEndpoint('https://rpc.fail.com', conn);

      // Need to hit unhealthyThreshold (2)
      await monitor.checkEndpoint('https://rpc.fail.com', conn);
      await monitor.checkEndpoint('https://rpc.fail.com', conn);

      expect(callback).toHaveBeenCalledWith(
        'https://rpc.fail.com',
        expect.objectContaining({ isHealthy: false })
      );
    });

    it('should recover to healthy after healthyThreshold successes', async () => {
      const failConn = createMockConnection({ healthy: false });
      const url = 'https://rpc.recover.com';
      monitor.registerEndpoint(url, failConn);

      // Make unhealthy
      await monitor.checkEndpoint(url, failConn);
      await monitor.checkEndpoint(url, failConn);
      expect(monitor.isHealthy(url)).toBe(false);

      // Now recover
      const goodConn = createMockConnection({ healthy: true });
      await monitor.checkEndpoint(url, goodConn);
      await monitor.checkEndpoint(url, goodConn);
      expect(monitor.isHealthy(url)).toBe(true);
    });
  });

  describe('checkAllEndpoints', () => {
    it('should check all registered endpoints', async () => {
      const conn1 = createMockConnection({ healthy: true });
      const conn2 = createMockConnection({ healthy: true });
      monitor.registerEndpoint('https://rpc1.com', conn1);
      monitor.registerEndpoint('https://rpc2.com', conn2);

      const results = await monitor.checkAllEndpoints();
      expect(results.size).toBe(2);
      expect(results.get('https://rpc1.com')?.isHealthy).toBe(true);
      expect(results.get('https://rpc2.com')?.isHealthy).toBe(true);
    });
  });

  describe('getAllHealth', () => {
    it('should return a copy of all health states', () => {
      const conn = createMockConnection();
      monitor.registerEndpoint('https://rpc.test.com', conn);

      const all = monitor.getAllHealth();
      expect(all.size).toBe(1);
      expect(all.get('https://rpc.test.com')).toBeDefined();
    });
  });
});
