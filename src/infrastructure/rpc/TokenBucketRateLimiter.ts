/**
 * Token Bucket Rate Limiter
 *
 * Controls request rate per RPC endpoint using the token bucket algorithm.
 * Supports burst capacity and smooth refill rates.
 */

export interface TokenBucketConfig {
  requestsPerSecond: number;
  burstCapacity: number;
}

export class TokenBucketRateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms
  private lastRefillTime: number;

  constructor(config: TokenBucketConfig) {
    this.maxTokens = config.burstCapacity;
    this.tokens = config.burstCapacity;
    this.refillRate = config.requestsPerSecond / 1000;
    this.lastRefillTime = Date.now();
  }

  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  async acquire(timeoutMs: number = 5000): Promise<boolean> {
    if (this.tryAcquire()) {
      return true;
    }

    const deadline = Date.now() + timeoutMs;
    const waitMs = this.getWaitTimeMs();

    if (Date.now() + waitMs > deadline) {
      return false;
    }

    await this.sleep(waitMs);
    return this.tryAcquire();
  }

  getAvailableTokens(): number {
    this.refill();
    return this.tokens;
  }

  getWaitTimeMs(): number {
    this.refill();
    if (this.tokens >= 1) {
      return 0;
    }
    const deficit = 1 - this.tokens;
    return Math.ceil(deficit / this.refillRate);
  }

  reset(): void {
    this.tokens = this.maxTokens;
    this.lastRefillTime = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;
    if (elapsed <= 0) return;

    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefillTime = now;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
