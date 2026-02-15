/**
 * Enhanced InMemoryAssetRepository Tests
 * 
 * Comprehensive test suite for the enhanced asset repository implementation.
 * Tests caching, indexing, search functionality, and metrics.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { InMemoryAssetRepository } from '../../infrastructure/repositories/InMemoryAssetRepository';
import { SolanaAsset } from '../../domain/asset/aggregates/SolanaAsset';
import { PublicKeyVO } from '../../domain/asset/valueObjects/PublicKeyVO';
import { AssetFilter } from '../../domain/repositories/IAssetRepository';

/** Generate a deterministic valid Solana address for testing */
function testMintAddress(index: number): string {
  const bytes = Buffer.alloc(32);
  bytes[0] = Math.floor(index / 256) + 1;
  bytes[1] = index % 256;
  return new PublicKey(bytes).toBase58();
}

describe('InMemoryAssetRepository', () => {
  let repository: InMemoryAssetRepository;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (repository) {
      repository.destroy();
    }
    vi.useRealTimers();
  });

  describe('Basic Operations', () => {
    beforeEach(() => {
      repository = new InMemoryAssetRepository({
        maxAssets: 100,
        assetCacheTTL: 300000, // 5 minutes
        enableMetrics: true
      });
    });

    it('should find asset by mint', async () => {
      const asset = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        verified: true
      });

      await repository.save(asset);

      const mint = PublicKeyVO.create('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      const result = await repository.findByMint(mint);
      
      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toBeDefined();
      expect(result.getValue()?.getSymbol()).toBe('USDC');
    });

    it('should return null for non-existent mint', async () => {
      const mint = PublicKeyVO.create('11111111111111111111111111111111');
      const result = await repository.findByMint(mint);
      
      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toBe(null);
    });

    it('should find multiple assets by mints', async () => {
      const asset1 = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6
      });

      const asset2 = SolanaAsset.createToken('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', {
        name: 'Tether',
        symbol: 'USDT',
        decimals: 6
      });

      await repository.save(asset1);
      await repository.save(asset2);

      const mints = [
        PublicKeyVO.create('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        PublicKeyVO.create('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
        PublicKeyVO.create('11111111111111111111111111111111') // Non-existent
      ];

      const result = await repository.findByMints(mints);
      
      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toHaveLength(2);
    });

    it('should save and retrieve asset', async () => {
      const asset = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        verified: true
      });

      const saveResult = await repository.save(asset);
      expect(saveResult.isSuccess).toBe(true);

      const mint = PublicKeyVO.create('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      const existsResult = await repository.exists(mint);
      expect(existsResult.isSuccess).toBe(true);
      expect(existsResult.getValue()).toBe(true);
    });

    it('should save many assets', async () => {
      const assets = [
        SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6
        }),
        SolanaAsset.createToken('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', {
          name: 'Tether',
          symbol: 'USDT',
          decimals: 6
        })
      ];

      const result = await repository.saveMany(assets);
      expect(result.isSuccess).toBe(true);

      const countResult = await repository.count();
      expect(countResult.isSuccess).toBe(true);
      expect(countResult.getValue()).toBeGreaterThanOrEqual(2); // Includes common assets
    });
  });

  describe('Search and Indexing', () => {
    beforeEach(() => {
      repository = new InMemoryAssetRepository({
        maxAssets: 100,
        enableMetrics: true
      });
    });

    it('should find assets by symbol', async () => {
      const asset = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6
      });

      await repository.save(asset);

      const result = await repository.findBySymbol('USDC');
      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toHaveLength(1);
      expect(result.getValue()[0].getSymbol()).toBe('USDC');
    });

    it('should find assets by symbol case-insensitive', async () => {
      const asset = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6
      });

      await repository.save(asset);

      const result = await repository.findBySymbol('usdc');
      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toHaveLength(1);
    });

    it('should get verified assets', async () => {
      const verifiedAsset = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        verified: true
      });

      const unverifiedAsset = SolanaAsset.createToken('11111111111111111111111111111112', {
        name: 'Test Token',
        symbol: 'TEST',
        decimals: 9,
        verified: false
      });

      await repository.save(verifiedAsset);
      await repository.save(unverifiedAsset);

      const result = await repository.getVerifiedAssets();
      expect(result.isSuccess).toBe(true);
      
      const verified = result.getValue();
      const usdcAsset = verified.find(asset => asset.getSymbol() === 'USDC');
      expect(usdcAsset).toBeDefined();
      expect(usdcAsset?.isVerified()).toBe(true);
    });

    it('should search with complex filters', async () => {
      const tokenAsset = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        verified: true
      });

      const nftAsset = SolanaAsset.createNFT(testMintAddress(200), {
        name: 'Test NFT',
        symbol: 'TNFT',
        decimals: 0,
        verified: false
      });

      await repository.save(tokenAsset);
      await repository.save(nftAsset);

      // Search for verified tokens
      const filter: AssetFilter = {
        type: 'token',
        verified: true
      };

      const result = await repository.search(filter);
      expect(result.isSuccess).toBe(true);
      
      const results = result.getValue();
      expect(results.some(asset => asset.getSymbol() === 'USDC')).toBe(true);
      expect(results.every(asset => asset.isToken() && asset.isVerified())).toBe(true);
    });

    it('should search by name', async () => {
      const asset = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6
      });

      await repository.save(asset);

      const result = await repository.searchByName('USD');
      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toHaveLength(1);
      expect(result.getValue()[0].getName()).toBe('USD Coin');
    });

    it('should search by partial name', async () => {
      const asset = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6
      });

      await repository.save(asset);

      const result = await repository.searchByName('coin');
      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toHaveLength(1);
    });

    it('should search with mint addresses filter', async () => {
      const asset1 = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6
      });

      const asset2 = SolanaAsset.createToken('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', {
        name: 'Tether',
        symbol: 'USDT',
        decimals: 6
      });

      await repository.save(asset1);
      await repository.save(asset2);

      const filter: AssetFilter = {
        mintAddresses: ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']
      };

      const result = await repository.search(filter);
      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toHaveLength(1);
      expect(result.getValue()[0].getSymbol()).toBe('USDC');
    });
  });

  describe('Caching and TTL', () => {
    beforeEach(() => {
      repository = new InMemoryAssetRepository({
        maxAssets: 10,
        assetCacheTTL: 5000, // 5 seconds
        enableMetrics: true
      });
    });

    it('should expire assets after TTL', async () => {
      const asset = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6
      });

      await repository.save(asset);

      const mint = PublicKeyVO.create('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      
      // Should exist initially
      let existsResult = await repository.exists(mint);
      expect(existsResult.getValue()).toBe(true);

      // Advance time past TTL
      vi.advanceTimersByTime(6000);

      // Should be expired now
      existsResult = await repository.exists(mint);
      expect(existsResult.getValue()).toBe(false);
    });

    it('should evict LRU assets when at capacity', async () => {
      // Fill cache to capacity
      for (let i = 0; i < 10; i++) {
        const asset = SolanaAsset.createToken(testMintAddress(i), {
          name: `Token ${i}`,
          symbol: `TK${i}`,
          decimals: 9
        });
        await repository.save(asset);
      }

      // Access first asset to make it recently used
      const firstMint = PublicKeyVO.create(testMintAddress(0));
      await repository.findByMint(firstMint);

      // Add another asset - should evict LRU (not the first one)
      const newAsset = SolanaAsset.createToken(testMintAddress(10), {
        name: 'New Token',
        symbol: 'NEW',
        decimals: 9
      });
      await repository.save(newAsset);

      // First asset should still exist (recently accessed)
      const firstExists = await repository.exists(firstMint);
      expect(firstExists.getValue()).toBe(true);

      // New asset should exist
      const newMint = PublicKeyVO.create(testMintAddress(10));
      const newExists = await repository.exists(newMint);
      expect(newExists.getValue()).toBe(true);
    });
  });

  describe('Metrics and Statistics', () => {
    beforeEach(() => {
      repository = new InMemoryAssetRepository({
        maxAssets: 100,
        enableMetrics: true
      });
    });

    it('should track cache metrics', async () => {
      const asset = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6
      });

      await repository.save(asset);

      const mint = PublicKeyVO.create('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      
      // Hit
      await repository.findByMint(mint);
      
      // Miss
      await repository.findByMint(PublicKeyVO.create('11111111111111111111111111111111'));

      const metrics = repository.getMetrics();
      expect(metrics.cacheHits).toBeGreaterThan(0);
      expect(metrics.cacheMisses).toBeGreaterThan(0);
      expect(metrics.totalAssets).toBeGreaterThan(0);
    });

    it('should track search operations', async () => {
      const asset = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6
      });

      await repository.save(asset);

      await repository.search({ type: 'token' });
      await repository.findBySymbol('USDC');
      await repository.getVerifiedAssets();

      const metrics = repository.getMetrics();
      expect(metrics.searchOperations).toBeGreaterThan(0);
      expect(metrics.indexLookups).toBeGreaterThan(0);
    });

    it('should get cache statistics', async () => {
      const asset = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6
      });

      await repository.save(asset);

      const cacheStats = repository.getCacheStats();
      expect(cacheStats.size).toBeGreaterThan(0);
      expect(cacheStats.maxSize).toBe(100);
    });
  });

  describe('Configuration Management', () => {
    beforeEach(() => {
      repository = new InMemoryAssetRepository({
        maxAssets: 50,
        enableMetrics: true,
        autoCleanup: false
      });
    });

    it('should get configuration', () => {
      const config = repository.getConfig();
      expect(config.maxAssets).toBe(50);
      expect(config.enableMetrics).toBe(true);
      expect(config.autoCleanup).toBe(false);
    });

    it('should update configuration', () => {
      repository.updateConfig({
        maxAssets: 200,
        enableMetrics: false
      });

      const config = repository.getConfig();
      expect(config.maxAssets).toBe(200);
      expect(config.enableMetrics).toBe(false);
    });
  });

  describe('Cleanup and Maintenance', () => {
    beforeEach(() => {
      repository = new InMemoryAssetRepository({
        maxAssets: 100,
        assetCacheTTL: 1000, // 1 second
        autoCleanup: false
      });
    });

    it('should manually cleanup expired entries', async () => {
      const asset = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6
      });

      await repository.save(asset);

      // Advance time to expire entry
      vi.advanceTimersByTime(2000);

      const cleanupResult = await repository.cleanup();
      expect(cleanupResult.isSuccess).toBe(true);
      expect(cleanupResult.getValue()).toBeGreaterThan(0);
    });

    it('should clear all assets', async () => {
      const asset = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6
      });

      await repository.save(asset);

      let countResult = await repository.count();
      expect(countResult.getValue()).toBeGreaterThan(0);

      const clearResult = await repository.clear();
      expect(clearResult.isSuccess).toBe(true);

      // Should still have common assets after clear
      countResult = await repository.count();
      expect(countResult.getValue()).toBeGreaterThan(0); // Common assets like SOL
    });

    it('should count assets with filter', async () => {
      const tokenAsset = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        verified: true
      });

      const nftAsset = SolanaAsset.createNFT(testMintAddress(200), {
        name: 'Test NFT',
        symbol: 'TNFT',
        decimals: 0
      });

      await repository.save(tokenAsset);
      await repository.save(nftAsset);

      const tokenCountResult = await repository.count({ type: 'token' });
      expect(tokenCountResult.isSuccess).toBe(true);
      expect(tokenCountResult.getValue()).toBeGreaterThanOrEqual(1);

      const nftCountResult = await repository.count({ type: 'nft' });
      expect(nftCountResult.isSuccess).toBe(true);
      expect(nftCountResult.getValue()).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Common Assets Initialization', () => {
    beforeEach(() => {
      repository = new InMemoryAssetRepository();
    });

    it('should initialize with common assets', async () => {
      // SOL native mint should be present (stored as wSOL after common token init overwrites native)
      const solMint = PublicKeyVO.create('So11111111111111111111111111111111111111112');
      const solResult = await repository.findByMint(solMint);
      expect(solResult.isSuccess).toBe(true);
      expect(solResult.getValue()?.getSymbol()).toBe('wSOL');

      // USDC should be present
      const usdcResult = await repository.findBySymbol('USDC');
      expect(usdcResult.isSuccess).toBe(true);
      expect(usdcResult.getValue().length).toBeGreaterThan(0);
    });

    it('should have verified common assets', async () => {
      const verifiedResult = await repository.getVerifiedAssets();
      expect(verifiedResult.isSuccess).toBe(true);

      const verified = verifiedResult.getValue();
      expect(verified.length).toBeGreaterThan(0);

      // wSOL should be verified (native SOL gets overwritten by wSOL common token)
      const sol = verified.find(asset => asset.getSymbol() === 'wSOL');
      expect(sol).toBeDefined();
      expect(sol?.isVerified()).toBe(true);
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      repository = new InMemoryAssetRepository();
    });

    it('should handle cache errors gracefully', async () => {
      // Try to get from a destroyed repository (cache is cleared)
      repository.destroy();

      const mint = PublicKeyVO.create('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      const result = await repository.findByMint(mint);

      // Destroyed cache returns success with null (cache is empty, not broken)
      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toBe(null);
    });

    it('should handle empty search results', async () => {
      const result = await repository.findBySymbol('NONEXISTENT');
      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toHaveLength(0);
    });

    it('should handle invalid search queries', async () => {
      const result = await repository.searchByName('ab'); // Too short
      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toHaveLength(0);
    });
  });

  describe('Performance', () => {
    beforeEach(() => {
      repository = new InMemoryAssetRepository({
        maxAssets: 1000,
        enableMetrics: true
      });
    });

    it('should handle large numbers of assets efficiently', async () => {
      const assets: SolanaAsset[] = [];

      // Create 100 test assets with valid Solana addresses
      for (let i = 0; i < 100; i++) {
        const asset = SolanaAsset.createToken(testMintAddress(i), {
          name: `Test Token ${i}`,
          symbol: `TEST${i}`,
          decimals: 9,
          verified: i % 2 === 0 // Every other asset is verified
        });
        assets.push(asset);
      }

      const start = Date.now();
      await repository.saveMany(assets);
      const saveTime = Date.now() - start;

      expect(saveTime).toBeLessThan(1000); // Should be fast

      // Test search performance
      const searchStart = Date.now();
      const verifiedResult = await repository.search({ verified: true });
      const searchTime = Date.now() - searchStart;

      expect(searchTime).toBeLessThan(100); // Search should be very fast
      expect(verifiedResult.isSuccess).toBe(true);
      expect(verifiedResult.getValue().length).toBe(53); // Half of 100 + 3 verified common assets
    });

    it('should maintain performance with frequent access', async () => {
      const asset = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6
      });

      await repository.save(asset);
      const mint = PublicKeyVO.create('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

      // Access the same asset many times
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        await repository.findByMint(mint);
      }
      const totalTime = Date.now() - start;

      expect(totalTime).toBeLessThan(1000); // Should be very fast due to caching
    });
  });
});