import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TokenBucketRateLimiter } from '../../infrastructure/rpc/TokenBucketRateLimiter';

describe('TokenBucketRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('tryAcquire', () => {
    it('should allow requests up to burst capacity', () => {
      const limiter = new TokenBucketRateLimiter({
        requestsPerSecond: 10,
        burstCapacity: 5,
      });

      for (let i = 0; i < 5; i++) {
        expect(limiter.tryAcquire()).toBe(true);
      }
      expect(limiter.tryAcquire()).toBe(false);
    });

    it('should refill tokens over time', () => {
      const limiter = new TokenBucketRateLimiter({
        requestsPerSecond: 10,
        burstCapacity: 5,
      });

      // Exhaust all tokens
      for (let i = 0; i < 5; i++) {
        limiter.tryAcquire();
      }
      expect(limiter.tryAcquire()).toBe(false);

      // Advance 200ms = 2 tokens refilled (10/sec = 0.01/ms * 200ms = 2)
      vi.advanceTimersByTime(200);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
    });

    it('should not exceed burst capacity on refill', () => {
      const limiter = new TokenBucketRateLimiter({
        requestsPerSecond: 10,
        burstCapacity: 3,
      });

      // Advance time without consuming - should not go above 3
      vi.advanceTimersByTime(10000);
      expect(limiter.getAvailableTokens()).toBe(3);
    });
  });

  describe('getWaitTimeMs', () => {
    it('should return 0 when tokens are available', () => {
      const limiter = new TokenBucketRateLimiter({
        requestsPerSecond: 10,
        burstCapacity: 5,
      });

      expect(limiter.getWaitTimeMs()).toBe(0);
    });

    it('should return positive wait time when empty', () => {
      const limiter = new TokenBucketRateLimiter({
        requestsPerSecond: 10,
        burstCapacity: 1,
      });

      limiter.tryAcquire(); // exhaust
      const wait = limiter.getWaitTimeMs();
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(100); // 1 token at 10/sec = 100ms
    });
  });

  describe('reset', () => {
    it('should restore tokens to burst capacity', () => {
      const limiter = new TokenBucketRateLimiter({
        requestsPerSecond: 10,
        burstCapacity: 5,
      });

      for (let i = 0; i < 5; i++) {
        limiter.tryAcquire();
      }
      expect(limiter.getAvailableTokens()).toBe(0);

      limiter.reset();
      expect(limiter.getAvailableTokens()).toBe(5);
    });
  });

  describe('acquire (async)', () => {
    it('should resolve immediately when tokens available', async () => {
      const limiter = new TokenBucketRateLimiter({
        requestsPerSecond: 10,
        burstCapacity: 5,
      });

      const result = await limiter.acquire();
      expect(result).toBe(true);
    });

    it('should return false if timeout exceeded', async () => {
      const limiter = new TokenBucketRateLimiter({
        requestsPerSecond: 1,
        burstCapacity: 1,
      });

      limiter.tryAcquire(); // exhaust

      // Timeout of 0ms with no tokens
      const promise = limiter.acquire(0);
      const result = await promise;
      expect(result).toBe(false);
    });
  });
});
