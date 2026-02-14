/**
 * Enhanced In-Memory Asset Repository
 * 
 * Browser-compatible implementation of IAssetRepository with LRU caching.
 * Provides efficient asset storage with indexing and cache management.
 */

import { SolanaAsset } from '../../domain/asset/aggregates/SolanaAsset';
import { PublicKeyVO } from '../../domain/asset/valueObjects/PublicKeyVO';
import { IAssetRepository, AssetFilter } from '../../domain/repositories/IAssetRepository';
import { Result } from '../../domain/shared/Result';
import { DomainError, CacheError } from '../../domain/shared/DomainError';
import { LRUCache } from '../cache/LRUCache';

interface AssetRepositoryConfig {
  maxAssets?: number;
  assetCacheTTL?: number;
  enableMetrics?: boolean;
  autoCleanup?: boolean;
  cleanupInterval?: number;
}

interface RepositoryMetrics {
  totalAssets: number;
  cacheHits: number;
  cacheMisses: number;
  indexLookups: number;
  searchOperations: number;
  lastCleanup?: Date;
}

export class InMemoryAssetRepository implements IAssetRepository {
  private assetCache: LRUCache<SolanaAsset>;
  private symbolIndex: Map<string, Set<string>> = new Map();
  private typeIndex: Map<string, Set<string>> = new Map();
  private verifiedIndex: Set<string> = new Set();
  private nameIndex: Map<string, Set<string>> = new Map();
  private metrics: RepositoryMetrics;
  private config: AssetRepositoryConfig;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: AssetRepositoryConfig = {}) {
    this.config = {
      maxAssets: config.maxAssets || 10000,
      assetCacheTTL: config.assetCacheTTL || 1800000, // 30 minutes
      enableMetrics: config.enableMetrics !== false,
      autoCleanup: config.autoCleanup !== false,
      cleanupInterval: config.cleanupInterval || 300000, // 5 minutes
      ...config
    };

    this.assetCache = new LRUCache({
      maxSize: this.config.maxAssets,
      defaultTTL: this.config.assetCacheTTL,
      onEvict: (key, asset) => {
        this.removeFromIndexes(key, asset);
        if (this.config.enableMetrics) {
          console.debug(`Asset evicted from cache: ${key}`);
        }
      },
      onExpire: (key, asset) => {
        this.removeFromIndexes(key, asset);
        if (this.config.enableMetrics) {
          console.debug(`Asset expired in cache: ${key}`);
        }
      }
    });

    this.metrics = {
      totalAssets: 0,
      cacheHits: 0,
      cacheMisses: 0,
      indexLookups: 0,
      searchOperations: 0
    };

    this.initializeCommonAssets();
    
    if (this.config.autoCleanup) {
      this.startAutoCleanup();
    }
  }

  private initializeCommonAssets(): void {
    // Add native SOL
    const sol = SolanaAsset.createNative();
    this.save(sol);

    // Add common SPL tokens
    const commonTokens = [
      {
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        coingeckoId: 'usd-coin'
      },
      {
        mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        symbol: 'USDT',
        name: 'Tether',
        decimals: 6,
        coingeckoId: 'tether'
      },
      {
        mint: 'So11111111111111111111111111111111111111112',
        symbol: 'wSOL',
        name: 'Wrapped SOL',
        decimals: 9,
        coingeckoId: 'solana'
      }
    ];

    for (const token of commonTokens) {
      const asset = SolanaAsset.createToken(
        token.mint,
        {
          name: token.name,
          symbol: token.symbol,
          decimals: token.decimals,
          coingeckoId: token.coingeckoId,
          verified: true
        }
      );
      this.save(asset);
    }
  }

  async findByMint(mint: PublicKeyVO): Promise<Result<SolanaAsset | null, DomainError>> {
    try {
      const mintAddress = mint.toBase58();
      
      const cacheResult = this.assetCache.get(mintAddress);
      if (cacheResult.isFailure) {
        return Result.fail(cacheResult.getError());
      }

      const asset = cacheResult.getValue();
      
      if (this.config.enableMetrics) {
        if (asset) {
          this.metrics.cacheHits++;
        } else {
          this.metrics.cacheMisses++;
        }
      }

      return Result.ok(asset);
    } catch (error) {
      return Result.fail(
        new CacheError('findByMint', error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  async findByMints(mints: PublicKeyVO[]): Promise<Result<SolanaAsset[], DomainError>> {
    try {
      const assets: SolanaAsset[] = [];
      const mintAddresses = mints.map(mint => mint.toBase58());
      
      const cacheResult = this.assetCache.getMany(mintAddresses);
      if (cacheResult.isFailure) {
        return Result.fail(cacheResult.getError());
      }

      const cachedAssets = cacheResult.getValue();
      
      for (const mintAddress of mintAddresses) {
        const asset = cachedAssets.get(mintAddress);
        if (asset) {
          assets.push(asset);
          if (this.config.enableMetrics) {
            this.metrics.cacheHits++;
          }
        } else if (this.config.enableMetrics) {
          this.metrics.cacheMisses++;
        }
      }

      return Result.ok(assets);
    } catch (error) {
      return Result.fail(
        new CacheError('findByMints', error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  async findBySymbol(symbol: string): Promise<Result<SolanaAsset[], DomainError>> {
    try {
      if (this.config.enableMetrics) {
        this.metrics.indexLookups++;
      }

      const mintAddresses = this.symbolIndex.get(symbol.toUpperCase()) || new Set();
      const assets: SolanaAsset[] = [];
      
      for (const mint of mintAddresses) {
        const cacheResult = this.assetCache.get(mint);
        if (cacheResult.isSuccess && cacheResult.getValue()) {
          assets.push(cacheResult.getValue()!);
          if (this.config.enableMetrics) {
            this.metrics.cacheHits++;
          }
        } else if (this.config.enableMetrics) {
          this.metrics.cacheMisses++;
        }
      }
      
      return Result.ok(assets);
    } catch (error) {
      return Result.fail(
        new CacheError('findBySymbol', error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  async getVerifiedAssets(): Promise<Result<SolanaAsset[], DomainError>> {
    try {
      if (this.config.enableMetrics) {
        this.metrics.indexLookups++;
      }

      const verified: SolanaAsset[] = [];
      
      for (const mintAddress of this.verifiedIndex) {
        const cacheResult = this.assetCache.get(mintAddress);
        if (cacheResult.isSuccess && cacheResult.getValue()) {
          verified.push(cacheResult.getValue()!);
          if (this.config.enableMetrics) {
            this.metrics.cacheHits++;
          }
        } else if (this.config.enableMetrics) {
          this.metrics.cacheMisses++;
        }
      }
      
      return Result.ok(verified);
    } catch (error) {
      return Result.fail(
        new CacheError('getVerifiedAssets', error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  async search(filter: AssetFilter): Promise<Result<SolanaAsset[], DomainError>> {
    try {
      if (this.config.enableMetrics) {
        this.metrics.searchOperations++;
      }

      let candidateMints: Set<string> = new Set();
      let isFirstFilter = true;

      // Start with type filter if provided (most selective)
      if (filter.type) {
        const typeAssets = this.typeIndex.get(filter.type) || new Set();
        candidateMints = new Set(typeAssets);
        isFirstFilter = false;
      }

      // Apply verified filter
      if (filter.verified !== undefined) {
        const verifiedAssets = filter.verified ? this.verifiedIndex : new Set();
        if (isFirstFilter) {
          candidateMints = new Set(verifiedAssets);
          isFirstFilter = false;
        } else {
          candidateMints = new Set([...candidateMints].filter(mint => 
            filter.verified ? verifiedAssets.has(mint) : !verifiedAssets.has(mint)
          ));
        }
      }

      // Apply symbol filter
      if (filter.symbol) {
        const symbolAssets = this.symbolIndex.get(filter.symbol.toUpperCase()) || new Set();
        if (isFirstFilter) {
          candidateMints = new Set(symbolAssets);
          isFirstFilter = false;
        } else {
          candidateMints = new Set([...candidateMints].filter(mint => symbolAssets.has(mint)));
        }
      }

      // Apply mint addresses filter
      if (filter.mintAddresses && filter.mintAddresses.length > 0) {
        const mintSet = new Set(filter.mintAddresses);
        if (isFirstFilter) {
          candidateMints = mintSet;
          isFirstFilter = false;
        } else {
          candidateMints = new Set([...candidateMints].filter(mint => mintSet.has(mint)));
        }
      }

      // If no filters were applied, get all assets
      if (isFirstFilter) {
        candidateMints = new Set(this.assetCache.keys());
      }

      // Fetch assets from cache
      const results: SolanaAsset[] = [];
      for (const mint of candidateMints) {
        const cacheResult = this.assetCache.get(mint);
        if (cacheResult.isSuccess && cacheResult.getValue()) {
          results.push(cacheResult.getValue()!);
          if (this.config.enableMetrics) {
            this.metrics.cacheHits++;
          }
        } else if (this.config.enableMetrics) {
          this.metrics.cacheMisses++;
        }
      }

      return Result.ok(results);
    } catch (error) {
      return Result.fail(
        new CacheError('search', error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  async save(asset: SolanaAsset): Promise<Result<void, DomainError>> {
    try {
      const mint = asset.getMintAddress();
      
      // Save to cache
      const cacheResult = this.assetCache.set(mint, asset);
      if (cacheResult.isFailure) {
        return Result.fail(cacheResult.getError());
      }

      // Update indexes
      this.addToIndexes(mint, asset);

      if (this.config.enableMetrics) {
        this.metrics.totalAssets = this.assetCache.size();
      }

      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new CacheError('save', error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  async saveMany(assets: SolanaAsset[]): Promise<Result<void, DomainError>> {
    try {
      const assetMap = new Map<string, SolanaAsset>();
      
      // Prepare batch for cache
      for (const asset of assets) {
        assetMap.set(asset.getMintAddress(), asset);
      }

      const cacheResult = this.assetCache.setMany(assetMap);
      if (cacheResult.isFailure) {
        return Result.fail(cacheResult.getError());
      }

      // Update indexes
      for (const asset of assets) {
        this.addToIndexes(asset.getMintAddress(), asset);
      }

      if (this.config.enableMetrics) {
        this.metrics.totalAssets = this.assetCache.size();
      }

      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new CacheError('saveMany', error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  async exists(mint: PublicKeyVO): Promise<Result<boolean, DomainError>> {
    try {
      return Result.ok(this.assetCache.has(mint.toBase58()));
    } catch (error) {
      return Result.fail(
        new CacheError('exists', error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  async count(filter?: AssetFilter): Promise<Result<number, DomainError>> {
    try {
      if (!filter) {
        return Result.ok(this.assetCache.size());
      }

      const searchResult = await this.search(filter);
      if (searchResult.isFailure) {
        return Result.fail(searchResult.getError());
      }

      return Result.ok(searchResult.getValue().length);
    } catch (error) {
      return Result.fail(
        new CacheError('count', error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  async clear(): Promise<Result<void, DomainError>> {
    try {
      this.assetCache.clear();
      this.symbolIndex.clear();
      this.typeIndex.clear();
      this.verifiedIndex.clear();
      this.nameIndex.clear();
      
      if (this.config.enableMetrics) {
        this.metrics = {
          totalAssets: 0,
          cacheHits: 0,
          cacheMisses: 0,
          indexLookups: 0,
          searchOperations: 0,
          lastCleanup: new Date()
        };
      }

      this.initializeCommonAssets(); // Re-add common assets
      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new CacheError('clear', error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  // Enhanced functionality

  /**
   * Add asset to indexes
   */
  private addToIndexes(mint: string, asset: SolanaAsset): void {
    // Symbol index
    const symbol = asset.getSymbol().toUpperCase();
    if (!this.symbolIndex.has(symbol)) {
      this.symbolIndex.set(symbol, new Set());
    }
    this.symbolIndex.get(symbol)!.add(mint);

    // Type index
    const type = asset.isNative() ? 'native' : 
                 asset.isNFT() ? 'nft' : 'token';
    if (!this.typeIndex.has(type)) {
      this.typeIndex.set(type, new Set());
    }
    this.typeIndex.get(type)!.add(mint);

    // Verified index
    if (asset.isVerified()) {
      this.verifiedIndex.add(mint);
    }

    // Name index (for fuzzy search)
    const name = asset.getName().toLowerCase();
    const words = name.split(/\s+/);
    for (const word of words) {
      if (word.length > 2) { // Only index words longer than 2 characters
        if (!this.nameIndex.has(word)) {
          this.nameIndex.set(word, new Set());
        }
        this.nameIndex.get(word)!.add(mint);
      }
    }
  }

  /**
   * Remove asset from indexes
   */
  private removeFromIndexes(mint: string, asset: SolanaAsset): void {
    // Symbol index
    const symbol = asset.getSymbol().toUpperCase();
    const symbolSet = this.symbolIndex.get(symbol);
    if (symbolSet) {
      symbolSet.delete(mint);
      if (symbolSet.size === 0) {
        this.symbolIndex.delete(symbol);
      }
    }

    // Type index
    const type = asset.isNative() ? 'native' : 
                 asset.isNFT() ? 'nft' : 'token';
    const typeSet = this.typeIndex.get(type);
    if (typeSet) {
      typeSet.delete(mint);
      if (typeSet.size === 0) {
        this.typeIndex.delete(type);
      }
    }

    // Verified index
    this.verifiedIndex.delete(mint);

    // Name index
    const name = asset.getName().toLowerCase();
    const words = name.split(/\s+/);
    for (const word of words) {
      if (word.length > 2) {
        const wordSet = this.nameIndex.get(word);
        if (wordSet) {
          wordSet.delete(mint);
          if (wordSet.size === 0) {
            this.nameIndex.delete(word);
          }
        }
      }
    }
  }

  /**
   * Search assets by name (fuzzy search)
   */
  async searchByName(query: string): Promise<Result<SolanaAsset[], DomainError>> {
    try {
      if (this.config.enableMetrics) {
        this.metrics.searchOperations++;
      }

      const searchTerms = query.toLowerCase().split(/\s+/).filter(term => term.length > 2);
      if (searchTerms.length === 0) {
        return Result.ok([]);
      }

      let candidateMints: Set<string> = new Set();
      let isFirstTerm = true;

      for (const term of searchTerms) {
        const matchingMints = new Set<string>();
        
        // Find all words that start with the search term
        for (const [word, mints] of this.nameIndex) {
          if (word.startsWith(term)) {
            for (const mint of mints) {
              matchingMints.add(mint);
            }
          }
        }

        if (isFirstTerm) {
          candidateMints = matchingMints;
          isFirstTerm = false;
        } else {
          // Intersection with previous results
          candidateMints = new Set([...candidateMints].filter(mint => matchingMints.has(mint)));
        }
      }

      // Fetch assets from cache
      const results: SolanaAsset[] = [];
      for (const mint of candidateMints) {
        const cacheResult = this.assetCache.get(mint);
        if (cacheResult.isSuccess && cacheResult.getValue()) {
          results.push(cacheResult.getValue()!);
          if (this.config.enableMetrics) {
            this.metrics.cacheHits++;
          }
        } else if (this.config.enableMetrics) {
          this.metrics.cacheMisses++;
        }
      }

      return Result.ok(results);
    } catch (error) {
      return Result.fail(
        new CacheError('searchByName', error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  /**
   * Get repository metrics
   */
  getMetrics(): RepositoryMetrics {
    return { ...this.metrics };
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): any {
    return this.assetCache.getStats();
  }

  /**
   * Manually trigger cleanup
   */
  async cleanup(): Promise<Result<number, DomainError>> {
    try {
      const cleanedCount = this.assetCache.cleanup();
      
      if (this.config.enableMetrics) {
        this.metrics.lastCleanup = new Date();
      }

      return Result.ok(cleanedCount);
    } catch (error) {
      return Result.fail(
        new CacheError('cleanup', error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  /**
   * Start automatic cleanup
   */
  private startAutoCleanup(): void {
    if (typeof window === 'undefined') {
      // Only set timer in non-browser environments
      this.cleanupTimer = setInterval(() => {
        this.cleanup();
      }, this.config.cleanupInterval!);
    }
  }

  /**
   * Stop automatic cleanup
   */
  private stopAutoCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * Get repository configuration
   */
  getConfig(): AssetRepositoryConfig {
    return { ...this.config };
  }

  /**
   * Update repository configuration
   */
  updateConfig(updates: Partial<AssetRepositoryConfig>): void {
    const wasAutoCleanup = this.config.autoCleanup;
    Object.assign(this.config, updates);
    
    // Handle auto-cleanup changes
    if (wasAutoCleanup && !this.config.autoCleanup) {
      this.stopAutoCleanup();
    } else if (!wasAutoCleanup && this.config.autoCleanup) {
      this.startAutoCleanup();
    }
  }

  /**
   * Destroy repository and cleanup resources
   */
  destroy(): void {
    this.stopAutoCleanup();
    this.assetCache.destroy();
    this.symbolIndex.clear();
    this.typeIndex.clear();
    this.verifiedIndex.clear();
    this.nameIndex.clear();
  }
}