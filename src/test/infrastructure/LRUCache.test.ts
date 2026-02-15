/**
 * LRU Cache Tests
 * 
 * Comprehensive test suite for the LRU Cache implementation.
 * Tests caching behavior, TTL functionality, and memory management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LRUCache } from '../../infrastructure/cache/LRUCache';

describe('LRUCache', () => {
  let cache: LRUCache<string>;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (cache) {
      cache.destroy();
    }
    vi.useRealTimers();
  });

  describe('Basic Operations', () => {
    beforeEach(() => {
      cache = new LRUCache<string>({
        maxSize: 3,
        defaultTTL: 10000 // 10 seconds
      });
    });

    it('should store and retrieve values', () => {
      const result = cache.set('key1', 'value1');
      expect(result.isSuccess).toBe(true);

      const getValue = cache.get('key1');
      expect(getValue.isSuccess).toBe(true);
      expect(getValue.getValue()).toBe('value1');
    });

    it('should return null for non-existent keys', () => {
      const result = cache.get('nonexistent');
      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toBe(null);
    });

    it('should check key existence', () => {
      cache.set('key1', 'value1');
      expect(cache.has('key1')).toBe(true);
      expect(cache.has('key2')).toBe(false);
    });

    it('should delete keys', () => {
      cache.set('key1', 'value1');
      expect(cache.has('key1')).toBe(true);
      
      const deleted = cache.delete('key1');
      expect(deleted).toBe(true);
      expect(cache.has('key1')).toBe(false);
    });

    it('should return false when deleting non-existent key', () => {
      const deleted = cache.delete('nonexistent');
      expect(deleted).toBe(false);
    });

    it('should get cache size', () => {
      expect(cache.size()).toBe(0);
      
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      expect(cache.size()).toBe(2);
    });

    it('should check if cache is empty', () => {
      expect(cache.isEmpty()).toBe(true);
      
      cache.set('key1', 'value1');
      expect(cache.isEmpty()).toBe(false);
    });

    it('should check if cache is full', () => {
      expect(cache.isFull()).toBe(false);
      
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');
      expect(cache.isFull()).toBe(true);
    });
  });

  describe('LRU Eviction', () => {
    beforeEach(() => {
      cache = new LRUCache<string>({
        maxSize: 3,
        defaultTTL: 10000
      });
    });

    it('should evict least recently used item when at capacity', () => {
      const evictedItems: string[] = [];
      
      cache = new LRUCache<string>({
        maxSize: 3,
        defaultTTL: 10000,
        onEvict: (key, value) => {
          evictedItems.push(key);
        }
      });

      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');
      cache.set('key4', 'value4'); // Should evict key1

      expect(evictedItems).toContain('key1');
      expect(cache.has('key1')).toBe(false);
      expect(cache.has('key2')).toBe(true);
      expect(cache.has('key3')).toBe(true);
      expect(cache.has('key4')).toBe(true);
    });

    it('should update access order on get', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      // Access key1 to make it most recently used
      cache.get('key1');

      // Add new item - should evict key2 (least recently used)
      cache.set('key4', 'value4');

      expect(cache.has('key1')).toBe(true);
      expect(cache.has('key2')).toBe(false);
      expect(cache.has('key3')).toBe(true);
      expect(cache.has('key4')).toBe(true);
    });

    it('should update access order on set for existing keys', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      // Update key1 to make it most recently used
      cache.set('key1', 'updated_value1');

      // Add new item - should evict key2 (least recently used)
      cache.set('key4', 'value4');

      expect(cache.has('key1')).toBe(true);
      expect(cache.get('key1').getValue()).toBe('updated_value1');
      expect(cache.has('key2')).toBe(false);
      expect(cache.has('key3')).toBe(true);
      expect(cache.has('key4')).toBe(true);
    });
  });

  describe('TTL (Time To Live)', () => {
    beforeEach(() => {
      cache = new LRUCache<string>({
        maxSize: 10,
        defaultTTL: 5000 // 5 seconds
      });
    });

    it('should expire items after TTL', () => {
      cache.set('key1', 'value1');
      expect(cache.has('key1')).toBe(true);

      // Advance time past TTL
      vi.advanceTimersByTime(6000);
      
      expect(cache.has('key1')).toBe(false);
      
      const result = cache.get('key1');
      expect(result.getValue()).toBe(null);
    });

    it('should use custom TTL when provided', () => {
      cache.set('key1', 'value1', 1000); // 1 second TTL
      cache.set('key2', 'value2'); // Default TTL (5 seconds)

      // Advance 2 seconds
      vi.advanceTimersByTime(2000);

      expect(cache.has('key1')).toBe(false);
      expect(cache.has('key2')).toBe(true);
    });

    it('should get TTL for existing keys', () => {
      cache.set('key1', 'value1', 5000);
      
      const ttlResult = cache.getTTL('key1');
      expect(ttlResult.isSuccess).toBe(true);
      expect(ttlResult.getValue()).toBeGreaterThan(4000);
      expect(ttlResult.getValue()).toBeLessThanOrEqual(5000);
    });

    it('should return null TTL for non-existent keys', () => {
      const ttlResult = cache.getTTL('nonexistent');
      expect(ttlResult.isSuccess).toBe(true);
      expect(ttlResult.getValue()).toBe(null);
    });

    it('should set TTL for existing keys', () => {
      cache.set('key1', 'value1');
      
      const setTTLResult = cache.setTTL('key1', 1000);
      expect(setTTLResult.isSuccess).toBe(true);
      expect(setTTLResult.getValue()).toBe(true);

      // Advance time past new TTL
      vi.advanceTimersByTime(1500);
      expect(cache.has('key1')).toBe(false);
    });

    it('should call onExpire callback when items expire', () => {
      const expiredItems: string[] = [];
      
      cache = new LRUCache<string>({
        maxSize: 10,
        defaultTTL: 1000,
        onExpire: (key, value) => {
          expiredItems.push(key);
        }
      });

      cache.set('key1', 'value1');
      
      // Advance time to trigger expiration
      vi.advanceTimersByTime(1500);
      cache.get('key1'); // This should trigger expiration check

      expect(expiredItems).toContain('key1');
    });
  });

  describe('Batch Operations', () => {
    beforeEach(() => {
      cache = new LRUCache<string>({
        maxSize: 10,
        defaultTTL: 10000
      });
    });

    it('should get multiple values', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      const result = cache.getMany(['key1', 'key2', 'key4']);
      expect(result.isSuccess).toBe(true);
      
      const values = result.getValue();
      expect(values.get('key1')).toBe('value1');
      expect(values.get('key2')).toBe('value2');
      expect(values.has('key4')).toBe(false);
    });

    it('should set multiple values', () => {
      const entries = new Map([
        ['key1', 'value1'],
        ['key2', 'value2'],
        ['key3', 'value3']
      ]);

      const result = cache.setMany(entries);
      expect(result.isSuccess).toBe(true);

      expect(cache.get('key1').getValue()).toBe('value1');
      expect(cache.get('key2').getValue()).toBe('value2');
      expect(cache.get('key3').getValue()).toBe('value3');
    });

    it('should get all keys', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      const keys = cache.keys();
      expect(keys).toContain('key1');
      expect(keys).toContain('key2');
      expect(keys).toContain('key3');
      expect(keys).toHaveLength(3);
    });

    it('should get all values', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      const values = cache.values();
      expect(values).toContain('value1');
      expect(values).toContain('value2');
      expect(values).toContain('value3');
      expect(values).toHaveLength(3);
    });
  });

  describe('Statistics', () => {
    beforeEach(() => {
      cache = new LRUCache<string>({
        maxSize: 5,
        defaultTTL: 10000
      });
    });

    it('should track cache statistics', () => {
      // Add some items
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      // Access some items (hits)
      cache.get('key1');
      cache.get('key2');
      
      // Try to get non-existent item (miss)
      cache.get('key4');

      const stats = cache.getStats();
      expect(stats.size).toBe(3);
      expect(stats.maxSize).toBe(5);
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(0.67, 2);
    });

    it('should reset statistics', () => {
      cache.set('key1', 'value1');
      cache.get('key1');
      cache.get('key2'); // miss

      let stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);

      cache.resetStats();
      
      stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });

  describe('Cleanup', () => {
    beforeEach(() => {
      cache = new LRUCache<string>({
        maxSize: 10,
        defaultTTL: 1000
      });
    });

    it('should manually cleanup expired entries', () => {
      cache.set('key1', 'value1', 500);
      cache.set('key2', 'value2', 1500);
      cache.set('key3', 'value3', 2000);

      // Advance time to expire first item
      vi.advanceTimersByTime(1000);

      const cleanedCount = cache.cleanup();
      expect(cleanedCount).toBe(1);
      expect(cache.has('key1')).toBe(false);
      expect(cache.has('key2')).toBe(true);
      expect(cache.has('key3')).toBe(true);
    });

    it('should cleanup expired entries based on TTL', () => {
      cache = new LRUCache<string>({
        maxSize: 10,
        defaultTTL: 500
      });

      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      // Advance time past TTL for key1 and key2
      vi.advanceTimersByTime(600);

      // Add key3 (fresh, not expired)
      cache.set('key3', 'value3');

      const cleanedCount = cache.cleanup();
      expect(cleanedCount).toBe(2); // key1 and key2 should be cleaned up
      expect(cache.has('key3')).toBe(true);
    });

    it('should clear all entries', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      expect(cache.size()).toBe(3);
      
      cache.clear();
      
      expect(cache.size()).toBe(0);
      expect(cache.isEmpty()).toBe(true);
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      cache = new LRUCache<string>({
        maxSize: 5,
        defaultTTL: 10000
      });
    });

    it('should handle errors gracefully in callbacks', () => {
      const errorCallback = vi.fn().mockImplementation(() => {
        throw new Error('Callback error');
      });

      cache = new LRUCache<string>({
        maxSize: 2,
        defaultTTL: 10000,
        onEvict: errorCallback
      });

      // This should not throw even though callback throws
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      const result = cache.set('key3', 'value3'); // Should trigger eviction and callback error

      expect(errorCallback).toHaveBeenCalled();
      // Callback error causes set to return failure; eviction happened but insertion aborted
      expect(result.isFailure).toBe(true);
      expect(cache.size()).toBe(1); // key1 evicted, key3 not added, only key2 remains

      // Replace cache to avoid afterEach destroy calling the throwing callback
      cache = new LRUCache<string>({ maxSize: 5, defaultTTL: 10000 });
    });
  });

  describe('Memory Management', () => {
    it('should handle large numbers of entries efficiently', () => {
      cache = new LRUCache<string>({
        maxSize: 1000,
        defaultTTL: 10000
      });

      // Add many entries
      for (let i = 0; i < 1000; i++) {
        cache.set(`key${i}`, `value${i}`);
      }

      expect(cache.size()).toBe(1000);
      expect(cache.isFull()).toBe(true);

      // Access some entries to change order
      for (let i = 0; i < 100; i++) {
        cache.get(`key${i}`);
      }

      // Add more entries to trigger eviction
      for (let i = 1000; i < 1100; i++) {
        cache.set(`key${i}`, `value${i}`);
      }

      expect(cache.size()).toBe(1000);
      
      // First 100 entries should still exist (recently accessed)
      for (let i = 0; i < 100; i++) {
        expect(cache.has(`key${i}`)).toBe(true);
      }
    });
  });
});