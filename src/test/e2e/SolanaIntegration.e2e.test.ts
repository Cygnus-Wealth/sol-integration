import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair } from '@solana/web3.js';
import { SolanaIntegrationFacade } from '../../application/SolanaIntegrationFacade';
import { getDefaultEndpoints, getNetworkConfig } from '../../config/networks';

/**
 * E2E Tests for Solana Integration
 * These tests interact with Solana Testnet/Devnet
 *
 * To run these tests:
 * npm run test:e2e
 *
 * Note: These tests require network access and may be slower than unit tests
 */
describe('Solana Integration E2E Tests', () => {
  let facade: SolanaIntegrationFacade;
  let connection: Connection;

  // Test wallets with known balances on testnet/devnet
  // These are public addresses used for testing
  const TEST_WALLETS = {
    // Solana Labs test wallet (usually has SOL on devnet)
    DEVNET_WALLET: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
    // Another known test wallet
    TEST_WALLET_2: '7VHS8XAGP3ohBodZXpSLJpqJvjE5p5rWjGXFpRqc9gBU',
    // Empty wallet for testing zero balance
    EMPTY_WALLET: Keypair.generate().publicKey.toString(),
    // Known SPL token holder on devnet (USDC-Dev)
    TOKEN_HOLDER: 'GKNcUmNacSJo4S2Kq1DuYRYRGw3sNUfJ4tyqd198t6vQ',
    // Invalid address for error testing
    INVALID_ADDRESS: 'invalid-address-123'
  };

  // RPC endpoints resolved from network config
  const RPC_ENDPOINTS = getDefaultEndpoints('testnet');

  beforeAll(() => {
    // Initialize facade with testnet environment
    facade = new SolanaIntegrationFacade({
      environment: 'testnet',
      commitment: 'confirmed',
      cacheTTL: 5000, // Short cache for testing
      maxRetries: 2,
      enableCircuitBreaker: true,
      enableMetrics: true
    });

    // Initialize direct connection for validation
    connection = new Connection(getNetworkConfig('testnet').clusterUrl, 'confirmed');
  });

  afterAll(() => {
    // Clean up
    facade.clearCache();
  });

  describe('SOL Balance Fetching', () => {
    it('should fetch SOL balance for a valid wallet', async () => {
      const result = await facade.getSolanaBalance(TEST_WALLETS.DEVNET_WALLET);
      
      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        const balance = result.getValue();
        expect(typeof balance).toBe('number');
        expect(balance).toBeGreaterThanOrEqual(0);
        
        // Validate against direct RPC call
        const directBalance = await connection.getBalance(
          new PublicKey(TEST_WALLETS.DEVNET_WALLET)
        );
        expect(balance).toBeCloseTo(directBalance / LAMPORTS_PER_SOL, 6);
      }
    }, 30000); // 30 second timeout for network calls

    it('should return zero balance for empty wallet', async () => {
      const result = await facade.getSolanaBalance(TEST_WALLETS.EMPTY_WALLET);
      
      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        expect(result.getValue()).toBe(0);
      }
    }, 30000);

    it('should handle invalid addresses gracefully', async () => {
      const result = await facade.getSolanaBalance(TEST_WALLETS.INVALID_ADDRESS);
      
      expect(result.isFailure).toBe(true);
      if (result.isFailure) {
        expect(result.error.code).toContain('INVALID');
        expect(result.error.message).toContain('Invalid Solana public key');
      }
    });

    it('should use cache for repeated requests', async () => {
      const wallet = TEST_WALLETS.DEVNET_WALLET;
      
      // First call - should hit network
      const start1 = Date.now();
      const result1 = await facade.getSolanaBalance(wallet);
      const time1 = Date.now() - start1;
      
      expect(result1.isSuccess).toBe(true);
      
      // Second call - should use cache
      const start2 = Date.now();
      const result2 = await facade.getSolanaBalance(wallet);
      const time2 = Date.now() - start2;
      
      expect(result2.isSuccess).toBe(true);
      
      // Cache should be significantly faster
      expect(time2).toBeLessThan(time1 / 2);
      
      // Values should be identical
      if (result1.isSuccess && result2.isSuccess) {
        expect(result1.getValue()).toBe(result2.getValue());
      }
    }, 30000);
  });

  describe('SPL Token Balance Fetching', () => {
    it('should fetch SPL token balances for a wallet', async () => {
      const result = await facade.getTokenBalances(TEST_WALLETS.TOKEN_HOLDER);
      
      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        const tokens = result.getValue();
        expect(Array.isArray(tokens)).toBe(true);
        
        // Check token structure
        tokens.forEach(token => {
          expect(token).toHaveProperty('mint');
          expect(token).toHaveProperty('symbol');
          expect(token).toHaveProperty('name');
          expect(token).toHaveProperty('balance');
          expect(token).toHaveProperty('decimals');
          
          expect(typeof token.balance).toBe('number');
          expect(token.balance).toBeGreaterThanOrEqual(0);
          expect(typeof token.decimals).toBe('number');
        });
      }
    }, 30000);

    it('should return empty array for wallet with no tokens', async () => {
      const result = await facade.getTokenBalances(TEST_WALLETS.EMPTY_WALLET);
      
      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        expect(result.getValue()).toEqual([]);
      }
    }, 30000);
  });

  describe('Portfolio Snapshot', () => {
    it('should fetch complete portfolio snapshot', async () => {
      const result = await facade.getPortfolio(TEST_WALLETS.DEVNET_WALLET);
      
      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        const portfolio = result.getValue();
        
        // Validate portfolio structure
        expect(portfolio).toHaveProperty('address');
        expect(portfolio).toHaveProperty('totalValueUSD');
        expect(portfolio).toHaveProperty('solBalance');
        expect(portfolio).toHaveProperty('tokenCount');
        expect(portfolio).toHaveProperty('nftCount');
        expect(portfolio).toHaveProperty('tokens');
        expect(portfolio).toHaveProperty('nfts');
        expect(portfolio).toHaveProperty('lastUpdated');
        
        // Validate data types
        expect(portfolio.address).toBe(TEST_WALLETS.DEVNET_WALLET);
        expect(typeof portfolio.totalValueUSD).toBe('number');
        expect(typeof portfolio.solBalance).toBe('number');
        expect(typeof portfolio.tokenCount).toBe('number');
        expect(typeof portfolio.nftCount).toBe('number');
        expect(Array.isArray(portfolio.tokens)).toBe(true);
        expect(Array.isArray(portfolio.nfts)).toBe(true);
        expect(portfolio.lastUpdated).toBeInstanceOf(Date);
        
        // SOL balance should match individual query
        const balanceResult = await facade.getSolanaBalance(TEST_WALLETS.DEVNET_WALLET);
        if (balanceResult.isSuccess) {
          expect(portfolio.solBalance).toBeCloseTo(balanceResult.getValue(), 6);
        }
      }
    }, 60000); // 60 second timeout for comprehensive portfolio fetch
  });

  describe('NFT Fetching', () => {
    it('should fetch NFTs for a wallet', async () => {
      const result = await facade.getNFTs(TEST_WALLETS.TOKEN_HOLDER);
      
      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        const nfts = result.getValue();
        expect(Array.isArray(nfts)).toBe(true);
        
        // Check NFT structure
        nfts.forEach(nft => {
          expect(nft).toHaveProperty('mint');
          expect(nft).toHaveProperty('name');
          expect(nft).toHaveProperty('symbol');
          expect(nft).toHaveProperty('uri');
          
          expect(typeof nft.mint).toBe('string');
          expect(typeof nft.name).toBe('string');
          expect(typeof nft.symbol).toBe('string');
          expect(typeof nft.uri).toBe('string');
        });
      }
    }, 30000);
  });

  describe('Connection Health and Failover', () => {
    it('should handle RPC endpoint failover', async () => {
      // Create facade with primary endpoint that might fail
      const failoverFacade = new SolanaIntegrationFacade({
        rpcEndpoints: [
          'https://invalid-endpoint.com', // Will fail
          ...RPC_ENDPOINTS // Fallback endpoints
        ],
        commitment: 'confirmed',
        maxRetries: 3,
        enableCircuitBreaker: true
      });
      
      // Should still succeed using fallback endpoints
      const result = await failoverFacade.getSolanaBalance(TEST_WALLETS.DEVNET_WALLET);
      expect(result.isSuccess).toBe(true);
      
      // Check health metrics
      const metrics = failoverFacade.getHealthMetrics();
      expect(metrics).toBeDefined();
    }, 30000);

    it('should report connection health metrics', async () => {
      // Make a few requests
      await facade.getSolanaBalance(TEST_WALLETS.DEVNET_WALLET);
      await facade.getSolanaBalance(TEST_WALLETS.TEST_WALLET_2);
      
      const metrics = facade.getHealthMetrics();
      
      expect(metrics).toHaveProperty('endpoints');
      expect(metrics).toHaveProperty('requests');
      expect(metrics).toHaveProperty('failures');
      expect(metrics).toHaveProperty('avgResponseTime');
      
      expect(metrics.requests).toBeGreaterThan(0);
      expect(metrics.failures).toBeGreaterThanOrEqual(0);
      expect(metrics.avgResponseTime).toBeGreaterThan(0);
    });
  });

  describe('Cache Management', () => {
    it('should clear cache on demand', async () => {
      const wallet = TEST_WALLETS.DEVNET_WALLET;
      
      // Populate cache
      await facade.getSolanaBalance(wallet);
      
      // Clear cache
      facade.clearCache();
      
      // Next request should hit network (not cache)
      const start = Date.now();
      await facade.getSolanaBalance(wallet);
      const time = Date.now() - start;
      
      // Network call should take some time
      expect(time).toBeGreaterThan(10);
    }, 30000);
  });

  describe('Error Recovery', () => {
    it('should retry on transient errors', async () => {
      // This test validates retry logic by checking metrics
      const metrics1 = facade.getHealthMetrics();
      const initialRequests = metrics1.requests || 0;
      
      // Make a request that might need retries
      await facade.getSolanaBalance(TEST_WALLETS.DEVNET_WALLET);
      
      const metrics2 = facade.getHealthMetrics();
      const finalRequests = metrics2.requests || 0;
      
      // Should have made at least one request
      expect(finalRequests).toBeGreaterThan(initialRequests);
    }, 30000);
  });

  describe('Concurrent Requests', () => {
    it('should handle concurrent balance requests efficiently', async () => {
      const wallets = [
        TEST_WALLETS.DEVNET_WALLET,
        TEST_WALLETS.TEST_WALLET_2,
        TEST_WALLETS.TOKEN_HOLDER
      ];
      
      const start = Date.now();
      
      // Make concurrent requests
      const results = await Promise.all(
        wallets.map(wallet => facade.getSolanaBalance(wallet))
      );
      
      const time = Date.now() - start;
      
      // All should succeed
      results.forEach(result => {
        expect(result.isSuccess).toBe(true);
      });
      
      // Should complete reasonably quickly (parallel execution)
      expect(time).toBeLessThan(10000); // 10 seconds for 3 requests
    }, 30000);
  });
});