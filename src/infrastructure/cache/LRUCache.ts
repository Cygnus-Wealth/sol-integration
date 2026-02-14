/**
 * LRU Cache Implementation
 * 
 * Memory-efficient Least Recently Used cache with TTL support.
 * Browser-compatible implementation for caching in decentralized applications.
 */

import { Result } from '../../domain/shared/Result';
import { DomainError, CacheError } from '../../domain/shared/DomainError';

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  lastAccessed: number;
  accessCount: number;
}

export interface CacheOptions {
  maxSize: number;
  defaultTTL?: number; // milliseconds
  onEvict?: (key: string, value: any) => void;
  onExpire?: (key: string, value: any) => void;
}

export interface CacheStats {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
  hitRate: number;
  averageAccessCount: number;
  oldestEntry?: number; // timestamp
  newestEntry?: number; // timestamp
}

export class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private accessOrder: Set<string> = new Set();
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    expirations: 0
  };

  private readonly maxSize: number;
  private readonly defaultTTL: number;
  private readonly onEvict?: (key: string, value: T) => void;
  private readonly onExpire?: (key: string, value: T) => void;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(options: CacheOptions) {
    this.maxSize = options.maxSize;
    this.defaultTTL = options.defaultTTL || 30000; // 30 seconds default
    this.onEvict = options.onEvict;
    this.onExpire = options.onExpire;

    // Start periodic cleanup every 30 seconds
    if (typeof window === 'undefined') {
      // Only set timer in non-browser environments
      this.cleanupTimer = setInterval(() => {
        this.cleanup();
      }, 30000);
    }
  }

  /**
   * Get value from cache
   */
  get(key: string): Result<T | null, DomainError> {
    try {
      const entry = this.cache.get(key);
      
      if (!entry) {
        this.stats.misses++;
        return Result.ok(null);
      }

      const now = Date.now();
      
      // Check if expired
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        this.accessOrder.delete(key);
        this.stats.expirations++;
        this.stats.misses++;
        
        if (this.onExpire) {
          this.onExpire(key, entry.value);
        }
        
        return Result.ok(null);
      }

      // Update access information
      entry.lastAccessed = now;
      entry.accessCount++;
      
      // Update access order (move to end)
      this.accessOrder.delete(key);
      this.accessOrder.add(key);
      
      this.stats.hits++;
      return Result.ok(entry.value);
    } catch (error) {
      return Result.fail(
        new CacheError('get', error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  /**
   * Set value in cache
   */
  set(key: string, value: T, ttl?: number): Result<void, DomainError> {
    try {
      const now = Date.now();
      const expirationTime = now + (ttl || this.defaultTTL);
      
      // If key exists, update it
      if (this.cache.has(key)) {
        const entry = this.cache.get(key)!;
        entry.value = value;
        entry.expiresAt = expirationTime;
        entry.lastAccessed = now;
        entry.accessCount++;
        
        // Move to end of access order
        this.accessOrder.delete(key);
        this.accessOrder.add(key);
        
        return Result.ok(undefined);
      }

      // Evict LRU if at capacity
      if (this.cache.size >= this.maxSize) {
        this.evictLRU();
      }

      // Add new entry
      const entry: CacheEntry<T> = {
        value,
        expiresAt: expirationTime,
        lastAccessed: now,
        accessCount: 1
      };

      this.cache.set(key, entry);
      this.accessOrder.add(key);

      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new CacheError('set', error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return false;
    }
    
    return true;
  }

  /**
   * Delete key from cache
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    this.cache.delete(key);
    this.accessOrder.delete(key);
    
    if (this.onEvict) {
      this.onEvict(key, entry.value);
    }
    
    return true;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    if (this.onEvict) {
      for (const [key, entry] of this.cache) {
        this.onEvict(key, entry.value);
      }
    }
    
    this.cache.clear();
    this.accessOrder.clear();
    this.resetStats();
  }

  /**
   * Get multiple values
   */
  getMany(keys: string[]): Result<Map<string, T>, DomainError> {
    try {
      const results = new Map<string, T>();
      
      for (const key of keys) {
        const result = this.get(key);
        if (result.isSuccess && result.getValue() !== null) {
          results.set(key, result.getValue()!);
        }
      }
      
      return Result.ok(results);
    } catch (error) {
      return Result.fail(
        new CacheError('getMany', error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  /**
   * Set multiple values
   */
  setMany(entries: Map<string, T>, ttl?: number): Result<void, DomainError> {
    try {
      for (const [key, value] of entries) {
        const result = this.set(key, value, ttl);
        if (result.isFailure) {
          return result;
        }
      }
      
      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new CacheError('setMany', error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  /**
   * Get all keys
   */
  keys(): string[] {
    // Only return keys for non-expired entries
    const validKeys: string[] = [];
    const now = Date.now();
    
    for (const [key, entry] of this.cache) {
      if (now <= entry.expiresAt) {
        validKeys.push(key);
      }
    }
    
    return validKeys;
  }

  /**
   * Get all values
   */
  values(): T[] {
    const validValues: T[] = [];
    const now = Date.now();
    
    for (const entry of this.cache.values()) {
      if (now <= entry.expiresAt) {
        validValues.push(entry.value);
      }
    }
    
    return validValues;
  }

  /**
   * Get cache size
   */
  size(): number {
    this.cleanup(); // Clean expired entries first
    return this.cache.size;
  }

  /**
   * Check if cache is empty
   */
  isEmpty(): boolean {
    return this.size() === 0;
  }

  /**
   * Check if cache is full
   */
  isFull(): boolean {
    return this.cache.size >= this.maxSize;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    this.cleanup(); // Clean expired entries first
    
    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRate = totalRequests > 0 ? this.stats.hits / totalRequests : 0;
    
    let totalAccessCount = 0;
    let oldestEntry: number | undefined;
    let newestEntry: number | undefined;
    
    for (const entry of this.cache.values()) {
      totalAccessCount += entry.accessCount;
      
      if (!oldestEntry || entry.lastAccessed < oldestEntry) {
        oldestEntry = entry.lastAccessed;
      }
      
      if (!newestEntry || entry.lastAccessed > newestEntry) {
        newestEntry = entry.lastAccessed;
      }
    }
    
    const averageAccessCount = this.cache.size > 0 ? totalAccessCount / this.cache.size : 0;
    
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      expirations: this.stats.expirations,
      hitRate,
      averageAccessCount,
      oldestEntry,
      newestEntry
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      expirations: 0
    };
  }

  /**
   * Manually trigger cleanup of expired entries
   */
  cleanup(): number {
    const now = Date.now();
    const expiredKeys: string[] = [];
    
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        expiredKeys.push(key);
      }
    }
    
    for (const key of expiredKeys) {
      const entry = this.cache.get(key)!;
      this.cache.delete(key);
      this.accessOrder.delete(key);
      this.stats.expirations++;
      
      if (this.onExpire) {
        this.onExpire(key, entry.value);
      }
    }
    
    return expiredKeys.length;
  }

  /**
   * Set TTL for existing key
   */
  setTTL(key: string, ttl: number): Result<boolean, DomainError> {
    try {
      const entry = this.cache.get(key);
      if (!entry) {
        return Result.ok(false);
      }
      
      entry.expiresAt = Date.now() + ttl;
      return Result.ok(true);
    } catch (error) {
      return Result.fail(
        new CacheError('setTTL', error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  /**
   * Get TTL for existing key
   */
  getTTL(key: string): Result<number | null, DomainError> {
    try {
      const entry = this.cache.get(key);
      if (!entry) {
        return Result.ok(null);
      }
      
      const now = Date.now();
      if (now > entry.expiresAt) {
        this.delete(key);
        return Result.ok(null);
      }
      
      return Result.ok(entry.expiresAt - now);
    } catch (error) {
      return Result.fail(
        new CacheError('getTTL', error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  /**
   * Evict least recently used entry
   */
  private evictLRU(): void {
    const firstKey = this.accessOrder.values().next().value;
    if (firstKey) {
      const entry = this.cache.get(firstKey)!;
      this.cache.delete(firstKey);
      this.accessOrder.delete(firstKey);
      this.stats.evictions++;
      
      if (this.onEvict) {
        this.onEvict(firstKey, entry.value);
      }
    }
  }

  /**
   * Destroy cache and cleanup
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.clear();
  }
}