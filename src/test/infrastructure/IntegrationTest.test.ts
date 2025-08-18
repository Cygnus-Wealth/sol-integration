/**
 * Infrastructure Integration Tests
 * 
 * Comprehensive integration tests demonstrating how all infrastructure components
 * work together to provide a complete Solana integration layer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Connection } from '@solana/web3.js';

// Infrastructure components
import { LRUCache } from '../../infrastructure/cache/LRUCache';
import { CircuitBreaker } from '../../infrastructure/resilience/CircuitBreaker';
import { RetryPolicy, RetryStrategy } from '../../infrastructure/resilience/RetryPolicy';
import { SolanaConnectionAdapter } from '../../infrastructure/connection/SolanaConnectionAdapter';
import { SolanaConnectionRepository } from '../../infrastructure/repositories/SolanaConnectionRepository';
import { InMemoryAssetRepository } from '../../infrastructure/repositories/InMemoryAssetRepository';
import { InMemoryBalanceRepository } from '../../infrastructure/repositories/InMemoryBalanceRepository';
import { SPLTokenAdapter } from '../../infrastructure/adapters/SPLTokenAdapter';
import { MetaplexAdapter } from '../../infrastructure/adapters/MetaplexAdapter';
import { ConnectionManager } from '../../infrastructure/managers/ConnectionManager';

// Domain types
import { PublicKeyVO } from '../../domain/asset/valueObjects/PublicKeyVO';
import { SolanaAsset } from '../../domain/asset/aggregates/SolanaAsset';
import { TokenAmount } from '../../domain/asset/valueObjects/TokenAmount';
import { ConnectionEndpoint } from '../../domain/repositories/IConnectionRepository';

// Mock external dependencies
vi.mock('@solana/web3.js');
vi.mock('@solana/spl-token');
vi.mock('@metaplex-foundation/js');

describe('Infrastructure Integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllTimers();
  });

  describe('Complete Solana Integration Stack', () => {
    let connectionRepo: SolanaConnectionRepository;
    let connectionManager: ConnectionManager;
    let assetRepo: InMemoryAssetRepository;
    let balanceRepo: InMemoryBalanceRepository;
    let splAdapter: SPLTokenAdapter;
    let metaplexAdapter: MetaplexAdapter;

    beforeEach(() => {
      // Initialize complete infrastructure stack
      connectionRepo = new SolanaConnectionRepository();
      connectionManager = new ConnectionManager(connectionRepo);
      
      assetRepo = new InMemoryAssetRepository({
        maxAssets: 1000,
        enableMetrics: true
      });
      
      balanceRepo = new InMemoryBalanceRepository(500);
      
      const mockConnection = {
        rpcEndpoint: 'https://api.mainnet-beta.solana.com',
        getAccountInfo: vi.fn(),
        getTokenAccountsByOwner: vi.fn(),
        getMultipleAccountsInfo: vi.fn(),
        getBalance: vi.fn(),
        getHealth: vi.fn().mockResolvedValue('ok'),
        getVersion: vi.fn(),
        getLatestBlockhash: vi.fn(),
        getSlot: vi.fn()
      } as any;
      
      splAdapter = new SPLTokenAdapter(mockConnection);
      metaplexAdapter = new MetaplexAdapter(mockConnection);
    });

    afterEach(async () => {
      await connectionManager.destroy();
      connectionRepo.destroy();
      assetRepo.destroy();
      metaplexAdapter.destroy();
    });

    it('should demonstrate complete portfolio aggregation workflow', async () => {
      // 1. Setup connection endpoints
      const mainnetEndpoint: Omit<ConnectionEndpoint, 'id' | 'healthScore' | 'lastHealthCheck'> = {
        url: 'https://api.mainnet-beta.solana.com',
        name: 'Mainnet Beta',
        network: 'mainnet-beta',
        priority: 100,
        maxConcurrency: 10,
        timeoutMs: 30000,
        isActive: true,
        features: ['get_balance', 'get_token_accounts', 'get_account_info'],
        rateLimit: {
          requestsPerSecond: 100,
          burstLimit: 200
        }
      };

      const backupEndpoint: Omit<ConnectionEndpoint, 'id' | 'healthScore' | 'lastHealthCheck'> = {
        url: 'https://rpc.ankr.com/solana',
        name: 'Ankr Backup',
        network: 'mainnet-beta',
        priority: 50,
        maxConcurrency: 5,
        timeoutMs: 30000,
        isActive: true,
        features: ['get_balance', 'get_token_accounts']
      };

      // Add endpoints to connection manager
      const mainnetResult = await connectionManager.addEndpoint(mainnetEndpoint);
      expect(mainnetResult.isSuccess()).toBe(true);

      const backupResult = await connectionManager.addEndpoint(backupEndpoint);
      expect(backupResult.isSuccess()).toBe(true);

      // Start health monitoring
      const healthResult = await connectionManager.startHealthMonitoring();
      expect(healthResult.isSuccess()).toBe(true);

      // 2. Setup asset repository with common tokens
      const usdcAsset = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        logoUri: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
        verified: true,
        coingeckoId: 'usd-coin'
      });

      const solAsset = SolanaAsset.createNative();

      const saveResult = await assetRepo.saveMany([usdcAsset, solAsset]);
      expect(saveResult.isSuccess()).toBe(true);

      // 3. Create mock portfolio data
      const walletAddress = PublicKeyVO.create('Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr');
      const usdcMint = PublicKeyVO.create('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      const solMint = PublicKeyVO.create('So11111111111111111111111111111111111111112');

      // 4. Cache balance snapshots
      const usdcBalance = {
        walletAddress,
        mintAddress: usdcMint,
        balance: TokenAmount.fromTokenUnits('1000000', 6), // 1 USDC
        slot: 150000000,
        timestamp: new Date()
      };

      const solBalance = {
        walletAddress,
        mintAddress: solMint,
        balance: TokenAmount.fromLamports('2000000000', 9), // 2 SOL
        slot: 150000000,
        timestamp: new Date()
      };

      await balanceRepo.saveBalances([usdcBalance, solBalance]);

      // 5. Test complete portfolio retrieval workflow
      
      // Get cached balances
      const walletBalancesResult = await balanceRepo.getWalletBalances(walletAddress);
      expect(walletBalancesResult.isSuccess()).toBe(true);
      expect(walletBalancesResult.getValue()).toHaveLength(2);

      // Get asset information
      const usdcAssetResult = await assetRepo.findByMint(usdcMint);
      expect(usdcAssetResult.isSuccess()).toBe(true);
      expect(usdcAssetResult.getValue()?.getSymbol()).toBe('USDC');

      // Search for verified assets
      const verifiedAssetsResult = await assetRepo.search({ verified: true });
      expect(verifiedAssetsResult.isSuccess()).toBe(true);
      expect(verifiedAssetsResult.getValue().length).toBeGreaterThan(0);

      // 6. Test connection management with failover
      const connectionStatusResult = await connectionManager.getConnectionStatus();
      expect(connectionStatusResult.isSuccess()).toBe(true);
      
      const status = connectionStatusResult.getValue();
      expect(status.totalEndpoints).toBe(2);
      expect(status.activeEndpoints).toBeGreaterThan(0);

      // 7. Verify metrics tracking
      const assetMetrics = assetRepo.getMetrics();
      expect(assetMetrics.totalAssets).toBeGreaterThan(0);
      expect(assetMetrics.cacheHits).toBeGreaterThan(0);

      const balanceStats = await balanceRepo.getStats();
      expect(balanceStats.isSuccess()).toBe(true);
      expect(balanceStats.getValue().totalEntries).toBe(2);

      const managerStats = connectionManager.getStats();
      expect(managerStats.totalConnections).toBe(2);
    });

    it('should handle resilience patterns under stress', async () => {
      // Setup connection with aggressive retry and circuit breaker
      const connectionAdapter = new SolanaConnectionAdapter({
        endpoint: 'https://api.mainnet-beta.solana.com',
        enableRetries: true,
        enableCircuitBreaker: true,
        maxRetries: 3,
        retryBaseDelay: 100,
        circuitBreakerConfig: {
          failureThreshold: 2,
          recoveryTimeout: 1000,
          successThreshold: 1,
          timeout: 500,
          monitoringPeriod: 5000
        }
      });

      // Test circuit breaker behavior
      expect(connectionAdapter.isCircuitOpen()).toBe(false);

      // Simulate failures to open circuit
      connectionAdapter.forceCircuitOpen('Simulated failure');
      expect(connectionAdapter.isCircuitOpen()).toBe(true);

      // Test recovery
      connectionAdapter.forceCircuitClosed('Simulated recovery');
      expect(connectionAdapter.isCircuitOpen()).toBe(false);

      const metrics = connectionAdapter.getMetrics();
      expect(metrics.endpoint).toBe('https://api.mainnet-beta.solana.com');
    });

    it('should demonstrate cache efficiency across components', async () => {
      // Create assets and balances
      const assets = Array.from({ length: 100 }, (_, i) => 
        SolanaAsset.createToken(`${i}${'1'.repeat(43)}`, {
          name: `Test Token ${i}`,
          symbol: `TEST${i}`,
          decimals: 9,
          verified: i % 2 === 0
        })
      );

      // Save assets and measure performance
      const saveStart = Date.now();
      await assetRepo.saveMany(assets);
      const saveTime = Date.now() - saveStart;
      expect(saveTime).toBeLessThan(1000); // Should be very fast

      // Test search performance
      const searchStart = Date.now();
      const verifiedResult = await assetRepo.search({ verified: true });
      const searchTime = Date.now() - searchStart;
      expect(searchTime).toBeLessThan(100); // Search should be very fast
      expect(verifiedResult.getValue()).toHaveLength(50);

      // Test name search performance
      const nameSearchStart = Date.now();
      const nameResult = await assetRepo.searchByName('Token');
      const nameSearchTime = Date.now() - nameSearchStart;
      expect(nameSearchTime).toBeLessThan(200);
      expect(nameResult.getValue().length).toBeGreaterThan(0);

      // Verify cache statistics
      const metrics = assetRepo.getMetrics();
      expect(metrics.totalAssets).toBe(100 + 4); // +4 for common assets
      expect(metrics.searchOperations).toBeGreaterThan(0);

      const cacheStats = assetRepo.getCacheStats();
      expect(cacheStats.hitRate).toBeGreaterThan(0);
    });

    it('should handle memory management efficiently', async () => {
      // Configure repository with limited cache size
      const limitedRepo = new InMemoryAssetRepository({
        maxAssets: 10,
        assetCacheTTL: 5000,
        enableMetrics: true
      });

      try {
        // Add more assets than cache can hold
        for (let i = 0; i < 20; i++) {
          const asset = SolanaAsset.createToken(`${i}${'1'.repeat(43)}`, {
            name: `Token ${i}`,
            symbol: `TK${i}`,
            decimals: 9
          });
          await limitedRepo.save(asset);
        }

        // Cache should not exceed maximum size
        const stats = limitedRepo.getCacheStats();
        expect(stats.size).toBeLessThanOrEqual(10);
        expect(stats.evictions).toBeGreaterThan(0);

        // Most recently added assets should still be accessible
        const lastAssetMint = PublicKeyVO.create(`19${'1'.repeat(43)}`);
        const lastAssetResult = await limitedRepo.findByMint(lastAssetMint);
        expect(lastAssetResult.getValue()).toBeDefined();

        // Verify metrics tracking
        const metrics = limitedRepo.getMetrics();
        expect(metrics.totalAssets).toBe(10);
        expect(metrics.cacheHits).toBeGreaterThan(0);
        expect(metrics.cacheMisses).toBeGreaterThan(0);
      } finally {
        limitedRepo.destroy();
      }
    });

    it('should handle TTL expiration correctly', async () => {
      // Create repository with short TTL
      const shortTTLRepo = new InMemoryAssetRepository({
        maxAssets: 100,
        assetCacheTTL: 1000, // 1 second
        enableMetrics: true
      });

      try {
        const asset = SolanaAsset.createToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
          name: 'Test Token',
          symbol: 'TEST',
          decimals: 9
        });

        await shortTTLRepo.save(asset);
        const mint = PublicKeyVO.create('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

        // Should exist initially
        let existsResult = await shortTTLRepo.exists(mint);
        expect(existsResult.getValue()).toBe(true);

        // Advance time past TTL
        vi.advanceTimersByTime(2000);

        // Should be expired now
        existsResult = await shortTTLRepo.exists(mint);
        expect(existsResult.getValue()).toBe(false);

        // Cleanup should remove expired entries
        const cleanupResult = await shortTTLRepo.cleanup();
        expect(cleanupResult.isSuccess()).toBe(true);
      } finally {
        shortTTLRepo.destroy();
      }
    });

    it('should demonstrate error recovery patterns', async () => {
      // Create circuit breaker that opens quickly
      const circuitBreaker = new CircuitBreaker('test-service', {
        failureThreshold: 2,
        recoveryTimeout: 1000,
        successThreshold: 1,
        timeout: 500,
        monitoringPeriod: 5000
      });

      // Create retry policy
      const retryPolicy = new RetryPolicy('test-operation', {
        maxAttempts: 3,
        baseDelay: 100,
        maxDelay: 1000,
        backoffMultiplier: 2,
        jitter: false,
        retryableErrors: ['NETWORK_ERROR']
      }, RetryStrategy.EXPONENTIAL_BACKOFF);

      // Simulate failing operation
      let callCount = 0;
      const failingOperation = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) {
          throw new Error('Network timeout');
        }
        return Promise.resolve('success');
      });

      // Test retry policy
      const retryPromise = retryPolicy.execute(failingOperation);
      vi.runAllTimers();
      const retryResult = await retryPromise;

      expect(retryResult.isSuccess()).toBe(true);
      expect(failingOperation).toHaveBeenCalledTimes(4); // 3 failures + 1 success

      // Test circuit breaker
      const failingCBOperation = vi.fn().mockRejectedValue(new Error('Service down'));
      
      // Trigger failures to open circuit
      await circuitBreaker.execute(failingCBOperation);
      await circuitBreaker.execute(failingCBOperation);

      expect(circuitBreaker.isOpen()).toBe(true);

      // Circuit should reject calls immediately
      const rejectedResult = await circuitBreaker.execute(failingCBOperation);
      expect(rejectedResult.isFailure()).toBe(true);
      expect(failingCBOperation).toHaveBeenCalledTimes(2); // No additional calls

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.failureCount).toBe(3); // 2 + 1 rejected
      expect(metrics.successRate).toBe(0);
    });
  });

  describe('Component Interoperability', () => {
    it('should work together with shared cache instances', () => {
      // Create shared cache
      const sharedCache = new LRUCache<string>({
        maxSize: 1000,
        defaultTTL: 300000
      });

      // Multiple components can share the same cache
      sharedCache.set('asset:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC');
      sharedCache.set('balance:Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr:USDC', '1000000');

      const assetResult = sharedCache.get('asset:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      const balanceResult = sharedCache.get('balance:Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr:USDC');

      expect(assetResult.getValue()).toBe('USDC');
      expect(balanceResult.getValue()).toBe('1000000');

      const stats = sharedCache.getStats();
      expect(stats.size).toBe(2);
      expect(stats.hits).toBe(2);

      sharedCache.destroy();
    });

    it('should handle cross-component error propagation', async () => {
      const mockConnection = {
        rpcEndpoint: 'https://failing-endpoint.com',
        getBalance: vi.fn().mockRejectedValue(new Error('Connection failed')),
        getHealth: vi.fn().mockRejectedValue(new Error('Health check failed'))
      } as any;

      const connectionAdapter = new SolanaConnectionAdapter({
        endpoint: 'https://failing-endpoint.com',
        enableRetries: true,
        enableCircuitBreaker: true
      });

      const splAdapter = new SPLTokenAdapter(mockConnection);

      // Both adapters should handle the same connection failures gracefully
      const healthResult = await connectionAdapter.checkHealth();
      expect(healthResult.isFailure()).toBe(true);

      const balanceResult = await connectionAdapter.getBalance(
        PublicKeyVO.create('Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr')
      );
      expect(balanceResult.isFailure()).toBe(true);

      // Error should not crash the system
      expect(connectionAdapter.isCircuitOpen()).toBe(false); // Might open after enough failures
    });

    it('should demonstrate configuration consistency', () => {
      const config = {
        maxCacheSize: 1000,
        cacheTTL: 300000,
        enableMetrics: true,
        timeout: 30000
      };

      // All components can use consistent configuration
      const assetRepo = new InMemoryAssetRepository({
        maxAssets: config.maxCacheSize,
        assetCacheTTL: config.cacheTTL,
        enableMetrics: config.enableMetrics
      });

      const balanceRepo = new InMemoryBalanceRepository(config.maxCacheSize);

      const connectionAdapter = new SolanaConnectionAdapter({
        endpoint: 'https://api.mainnet-beta.solana.com',
        timeout: config.timeout
      });

      // All components should reflect the shared configuration
      expect(assetRepo.getConfig().maxAssets).toBe(config.maxCacheSize);
      expect(assetRepo.getConfig().enableMetrics).toBe(config.enableMetrics);
      expect(connectionAdapter.getConfig().timeout).toBe(config.timeout);

      assetRepo.destroy();
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle high-throughput operations', async () => {
      const assetRepo = new InMemoryAssetRepository({
        maxAssets: 10000,
        enableMetrics: true
      });

      const balanceRepo = new InMemoryBalanceRepository(10000);

      try {
        // Simulate high-throughput asset operations
        const operations = [];
        
        for (let i = 0; i < 1000; i++) {
          const asset = SolanaAsset.createToken(`${i}${'1'.repeat(43)}`, {
            name: `High Throughput Token ${i}`,
            symbol: `HT${i}`,
            decimals: 9
          });
          
          operations.push(assetRepo.save(asset));
        }

        const start = Date.now();
        await Promise.all(operations);
        const duration = Date.now() - start;

        expect(duration).toBeLessThan(5000); // Should complete within 5 seconds

        // Verify all assets were saved
        const count = await assetRepo.count();
        expect(count.getValue()).toBeGreaterThanOrEqual(1000);

        const metrics = assetRepo.getMetrics();
        expect(metrics.totalAssets).toBeGreaterThanOrEqual(1000);
      } finally {
        assetRepo.destroy();
      }
    });

    it('should maintain performance under memory pressure', async () => {
      // Create repository with limited memory
      const constrainedRepo = new InMemoryAssetRepository({
        maxAssets: 100,
        assetCacheTTL: 10000,
        enableMetrics: true
      });

      try {
        // Add assets beyond capacity repeatedly
        for (let batch = 0; batch < 10; batch++) {
          const batchAssets = Array.from({ length: 50 }, (_, i) => 
            SolanaAsset.createToken(`${batch}_${i}${'1'.repeat(41)}`, {
              name: `Batch ${batch} Token ${i}`,
              symbol: `B${batch}T${i}`,
              decimals: 9
            })
          );

          await constrainedRepo.saveMany(batchAssets);
        }

        // Repository should maintain size limit
        const stats = constrainedRepo.getCacheStats();
        expect(stats.size).toBeLessThanOrEqual(100);
        expect(stats.evictions).toBeGreaterThan(0);

        // Performance should remain consistent
        const searchStart = Date.now();
        await constrainedRepo.search({ type: 'token' });
        const searchTime = Date.now() - searchStart;
        expect(searchTime).toBeLessThan(50); // Should remain fast
      } finally {
        constrainedRepo.destroy();
      }
    });
  });
});