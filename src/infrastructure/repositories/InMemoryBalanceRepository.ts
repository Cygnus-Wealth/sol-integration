/**
 * In-Memory Balance Repository
 * 
 * Browser-compatible balance caching implementation.
 * Provides LRU cache with TTL support for balance snapshots.
 */

import { PublicKeyVO } from '../../domain/asset/valueObjects/PublicKeyVO';
import { IBalanceRepository, BalanceSnapshot, BalanceCacheEntry } from '../../domain/repositories/IBalanceRepository';
import { Result } from '../../domain/shared/Result';
import { DomainError, CacheError } from '../../domain/shared/DomainError';

interface CacheMetrics {
  hits: number;
  misses: number;
  evictions: number;
}

export class InMemoryBalanceRepository implements IBalanceRepository {
  private cache: Map<string, BalanceCacheEntry> = new Map();
  private accessOrder: string[] = [];
  private metrics: CacheMetrics = { hits: 0, misses: 0, evictions: 0 };
  private readonly maxEntries: number;
  private readonly defaultTTL: number = 30000; // 30 seconds
  private readonly environment: string;

  constructor(maxEntries: number = 1000, environment: string = 'testnet') {
    this.maxEntries = maxEntries;
    this.environment = environment;
  }

  private getCacheKey(wallet: PublicKeyVO, mint: PublicKeyVO): string {
    return `${this.environment}:${wallet.toBase58()}:${mint.toBase58()}`;
  }

  private updateAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(key);
  }

  private evictLRU(): void {
    if (this.cache.size >= this.maxEntries && this.accessOrder.length > 0) {
      const keyToEvict = this.accessOrder.shift()!;
      this.cache.delete(keyToEvict);
      this.metrics.evictions++;
    }
  }

  private isExpired(entry: BalanceCacheEntry): boolean {
    const now = Date.now();
    const age = now - entry.cachedAt.getTime();
    return age > entry.ttl;
  }

  async getBalance(
    wallet: PublicKeyVO,
    mint: PublicKeyVO
  ): Promise<Result<BalanceCacheEntry | null, DomainError>> {
    try {
      const key = this.getCacheKey(wallet, mint);
      const entry = this.cache.get(key);

      if (!entry) {
        this.metrics.misses++;
        return Result.ok(null);
      }

      if (this.isExpired(entry)) {
        this.cache.delete(key);
        const index = this.accessOrder.indexOf(key);
        if (index > -1) {
          this.accessOrder.splice(index, 1);
        }
        this.metrics.misses++;
        return Result.ok(null);
      }

      this.updateAccessOrder(key);
      this.metrics.hits++;
      return Result.ok(entry);
    } catch (error) {
      return Result.fail(
        new CacheError('getBalance', error instanceof Error ? error.message : undefined)
      );
    }
  }

  async getWalletBalances(
    wallet: PublicKeyVO
  ): Promise<Result<BalanceCacheEntry[], DomainError>> {
    try {
      const walletPrefix = `${this.environment}:${wallet.toBase58()}:`;
      const entries: BalanceCacheEntry[] = [];

      for (const [key, entry] of this.cache.entries()) {
        if (key.startsWith(walletPrefix)) {
          if (!this.isExpired(entry)) {
            entries.push(entry);
            this.updateAccessOrder(key);
            this.metrics.hits++;
          } else {
            this.cache.delete(key);
            const index = this.accessOrder.indexOf(key);
            if (index > -1) {
              this.accessOrder.splice(index, 1);
            }
          }
        }
      }

      if (entries.length === 0) {
        this.metrics.misses++;
      }

      return Result.ok(entries);
    } catch (error) {
      return Result.fail(
        new CacheError('getWalletBalances', error instanceof Error ? error.message : undefined)
      );
    }
  }

  async saveBalance(
    snapshot: BalanceSnapshot,
    ttl?: number
  ): Promise<Result<void, DomainError>> {
    try {
      const key = this.getCacheKey(snapshot.walletAddress, snapshot.mintAddress);
      
      // Evict LRU if at capacity
      if (!this.cache.has(key)) {
        this.evictLRU();
      }

      const entry: BalanceCacheEntry = {
        snapshot,
        ttl: ttl || this.defaultTTL,
        cachedAt: new Date()
      };

      this.cache.set(key, entry);
      this.updateAccessOrder(key);

      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new CacheError('saveBalance', error instanceof Error ? error.message : undefined)
      );
    }
  }

  async saveBalances(
    snapshots: BalanceSnapshot[],
    ttl?: number
  ): Promise<Result<void, DomainError>> {
    try {
      for (const snapshot of snapshots) {
        const result = await this.saveBalance(snapshot, ttl);
        if (result.isFailure()) {
          return result;
        }
      }
      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new CacheError('saveBalances', error instanceof Error ? error.message : undefined)
      );
    }
  }

  async isStale(
    wallet: PublicKeyVO,
    mint: PublicKeyVO,
    maxAge: number
  ): Promise<Result<boolean, DomainError>> {
    try {
      const key = this.getCacheKey(wallet, mint);
      const entry = this.cache.get(key);

      if (!entry) {
        return Result.ok(true); // No entry means stale
      }

      const age = Date.now() - entry.cachedAt.getTime();
      return Result.ok(age > maxAge);
    } catch (error) {
      return Result.fail(
        new CacheError('isStale', error instanceof Error ? error.message : undefined)
      );
    }
  }

  async invalidateWallet(wallet: PublicKeyVO): Promise<Result<void, DomainError>> {
    try {
      const walletPrefix = `${this.environment}:${wallet.toBase58()}:`;
      const keysToDelete: string[] = [];

      for (const key of this.cache.keys()) {
        if (key.startsWith(walletPrefix)) {
          keysToDelete.push(key);
        }
      }

      for (const key of keysToDelete) {
        this.cache.delete(key);
        const index = this.accessOrder.indexOf(key);
        if (index > -1) {
          this.accessOrder.splice(index, 1);
        }
      }

      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new CacheError('invalidateWallet', error instanceof Error ? error.message : undefined)
      );
    }
  }

  async invalidateBalance(
    wallet: PublicKeyVO,
    mint: PublicKeyVO
  ): Promise<Result<void, DomainError>> {
    try {
      const key = this.getCacheKey(wallet, mint);
      this.cache.delete(key);
      
      const index = this.accessOrder.indexOf(key);
      if (index > -1) {
        this.accessOrder.splice(index, 1);
      }

      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new CacheError('invalidateBalance', error instanceof Error ? error.message : undefined)
      );
    }
  }

  async getStats(): Promise<Result<{
    totalEntries: number;
    staleEntries: number;
    averageAge: number;
    hitRate: number;
  }, DomainError>> {
    try {
      const now = Date.now();
      let staleCount = 0;
      let totalAge = 0;
      let validEntries = 0;

      for (const entry of this.cache.values()) {
        const age = now - entry.cachedAt.getTime();
        if (age > entry.ttl) {
          staleCount++;
        } else {
          totalAge += age;
          validEntries++;
        }
      }

      const totalRequests = this.metrics.hits + this.metrics.misses;
      const hitRate = totalRequests > 0 ? this.metrics.hits / totalRequests : 0;

      return Result.ok({
        totalEntries: this.cache.size,
        staleEntries: staleCount,
        averageAge: validEntries > 0 ? totalAge / validEntries : 0,
        hitRate
      });
    } catch (error) {
      return Result.fail(
        new CacheError('getStats', error instanceof Error ? error.message : undefined)
      );
    }
  }

  async clear(): Promise<Result<void, DomainError>> {
    try {
      this.cache.clear();
      this.accessOrder = [];
      this.metrics = { hits: 0, misses: 0, evictions: 0 };
      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new CacheError('clear', error instanceof Error ? error.message : undefined)
      );
    }
  }

  async pruneStale(maxAge: number): Promise<Result<number, DomainError>> {
    try {
      const now = Date.now();
      const keysToDelete: string[] = [];

      for (const [key, entry] of this.cache.entries()) {
        const age = now - entry.cachedAt.getTime();
        if (age > maxAge || this.isExpired(entry)) {
          keysToDelete.push(key);
        }
      }

      for (const key of keysToDelete) {
        this.cache.delete(key);
        const index = this.accessOrder.indexOf(key);
        if (index > -1) {
          this.accessOrder.splice(index, 1);
        }
      }

      return Result.ok(keysToDelete.length);
    } catch (error) {
      return Result.fail(
        new CacheError('pruneStale', error instanceof Error ? error.message : undefined)
      );
    }
  }
}