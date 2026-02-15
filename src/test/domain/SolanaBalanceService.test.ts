/**
 * Solana Balance Service Tests
 * 
 * Comprehensive test suite for the domain balance service.
 * Tests retry logic, caching, and error handling.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { SolanaBalanceService, ISolanaConnection, TokenAccountInfo } from '../../domain/services/SolanaBalanceService';
import { IAssetRepository } from '../../domain/repositories/IAssetRepository';
import { IBalanceRepository } from '../../domain/repositories/IBalanceRepository';
import { PublicKeyVO } from '../../domain/asset/valueObjects/PublicKeyVO';
import { TokenAmount } from '../../domain/asset/valueObjects/TokenAmount';
import { SolanaAsset } from '../../domain/asset/aggregates/SolanaAsset';
import { Result } from '../../domain/shared/Result';
import { NetworkError, TimeoutError } from '../../domain/shared/DomainError';

/** Generate a deterministic valid Solana address for testing */
function testAddress(index: number): string {
  const bytes = Buffer.alloc(32);
  bytes[0] = Math.floor(index / 256) + 1;
  bytes[1] = index % 256;
  return new PublicKey(bytes).toBase58();
}

describe('SolanaBalanceService', () => {
  let service: SolanaBalanceService;
  let mockConnection: ISolanaConnection;
  let mockAssetRepo: IAssetRepository;
  let mockBalanceRepo: IBalanceRepository;

  beforeEach(() => {
    // Create mock implementations
    mockConnection = {
      getBalance: vi.fn(),
      getTokenAccounts: vi.fn(),
      getSlot: vi.fn(),
      getMultipleAccounts: vi.fn()
    };

    mockAssetRepo = {
      findByMint: vi.fn(),
      findByMints: vi.fn(),
      findBySymbol: vi.fn(),
      getVerifiedAssets: vi.fn(),
      search: vi.fn(),
      save: vi.fn(),
      saveMany: vi.fn(),
      exists: vi.fn(),
      count: vi.fn(),
      clear: vi.fn()
    };

    mockBalanceRepo = {
      getBalance: vi.fn(),
      getWalletBalances: vi.fn(),
      saveBalance: vi.fn(),
      saveBalances: vi.fn(),
      isStale: vi.fn(),
      invalidateWallet: vi.fn(),
      invalidateBalance: vi.fn(),
      getStats: vi.fn(),
      clear: vi.fn(),
      pruneStale: vi.fn()
    };

    service = new SolanaBalanceService(
      mockConnection,
      mockAssetRepo,
      mockBalanceRepo
    );
  });

  describe('fetchWalletBalance', () => {
    const testWallet = '7VHS8XAGP3ohBodZXpSLJpqJvjE5p5rWjGXFpRqc9gBU';

    it('should fetch native SOL balance successfully', async () => {
      // Arrange
      const expectedBalance = BigInt(1000000000); // 1 SOL
      vi.mocked(mockConnection.getBalance).mockResolvedValue(
        Result.ok(expectedBalance)
      );
      vi.mocked(mockConnection.getTokenAccounts).mockResolvedValue(
        Result.ok([])
      );
      vi.mocked(mockConnection.getSlot).mockResolvedValue(
        Result.ok(123456)
      );
      vi.mocked(mockBalanceRepo.getWalletBalances).mockResolvedValue(
        Result.ok([])
      );
      vi.mocked(mockBalanceRepo.saveBalances).mockResolvedValue(
        Result.ok(undefined)
      );

      // Act
      const result = await service.fetchWalletBalance(testWallet);

      // Assert
      expect(result.isSuccess).toBe(true);
      const balance = result.getValue();
      expect(balance.wallet.toBase58()).toBe(testWallet);
      expect(balance.nativeBalance.getAmount()).toBe(expectedBalance.toString());
      expect(balance.tokenBalances).toHaveLength(0);
      expect(balance.fromCache).toBe(false);
    });

    it('should fetch token balances successfully', async () => {
      // Arrange
      const tokenInfo: TokenAccountInfo = {
        pubkey: PublicKeyVO.create(testAddress(101)),
        mint: PublicKeyVO.create('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), // USDC
        amount: '1000000', // 1 USDC
        decimals: 6,
        uiAmount: 1
      };

      const usdcAsset = SolanaAsset.createToken(
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        {
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6,
          verified: true
        }
      );

      vi.mocked(mockConnection.getBalance).mockResolvedValue(
        Result.ok(BigInt(1000000000))
      );
      vi.mocked(mockConnection.getTokenAccounts).mockResolvedValue(
        Result.ok([tokenInfo])
      );
      vi.mocked(mockConnection.getSlot).mockResolvedValue(
        Result.ok(123456)
      );
      vi.mocked(mockAssetRepo.findByMint).mockResolvedValue(
        Result.ok(usdcAsset)
      );
      vi.mocked(mockBalanceRepo.getWalletBalances).mockResolvedValue(
        Result.ok([])
      );
      vi.mocked(mockBalanceRepo.saveBalances).mockResolvedValue(
        Result.ok(undefined)
      );

      // Act
      const result = await service.fetchWalletBalance(testWallet, {
        includeZeroBalances: false
      });

      // Assert
      expect(result.isSuccess).toBe(true);
      const balance = result.getValue();
      expect(balance.tokenBalances).toHaveLength(1);
      expect(balance.tokenBalances[0].mint.toBase58()).toBe(tokenInfo.mint.toBase58());
      expect(balance.tokenBalances[0].balance.getUIAmount()).toBe(1);
      expect(balance.tokenBalances[0].asset?.getSymbol()).toBe('USDC');
    });

    it('should return cached balance when available and fresh', async () => {
      // Arrange
      const cachedEntry = {
        snapshot: {
          walletAddress: PublicKeyVO.create(testWallet),
          mintAddress: PublicKeyVO.create('So11111111111111111111111111111111111111112'),
          balance: TokenAmount.fromLamports(1000000000),
          slot: 123456,
          timestamp: new Date()
        },
        ttl: 30000,
        cachedAt: new Date()
      };

      vi.mocked(mockBalanceRepo.getWalletBalances).mockResolvedValue(
        Result.ok([cachedEntry])
      );

      // Act
      const result = await service.fetchWalletBalance(testWallet, {
        forceRefresh: false
      });

      // Assert
      expect(result.isSuccess).toBe(true);
      const balance = result.getValue();
      expect(balance.fromCache).toBe(true);
      expect(mockConnection.getBalance).not.toHaveBeenCalled();
    });

    it('should retry on network errors', async () => {
      // Arrange
      const networkError = new NetworkError('Connection failed', 'test-endpoint', true);
      const expectedBalance = BigInt(1000000000);

      vi.mocked(mockConnection.getBalance)
        .mockResolvedValueOnce(Result.fail(networkError))
        .mockResolvedValueOnce(Result.fail(networkError))
        .mockResolvedValueOnce(Result.ok(expectedBalance));

      vi.mocked(mockConnection.getTokenAccounts).mockResolvedValue(
        Result.ok([])
      );
      vi.mocked(mockConnection.getSlot).mockResolvedValue(
        Result.ok(123456)
      );
      vi.mocked(mockBalanceRepo.getWalletBalances).mockResolvedValue(
        Result.ok([])
      );
      vi.mocked(mockBalanceRepo.saveBalances).mockResolvedValue(
        Result.ok(undefined)
      );

      // Act
      const result = await service.fetchWalletBalance(testWallet);

      // Assert
      expect(result.isSuccess).toBe(true);
      expect(mockConnection.getBalance).toHaveBeenCalledTimes(3);
    });

    it('should fail after max retries', async () => {
      // Arrange
      const networkError = new NetworkError('Connection failed', 'test-endpoint', true);

      vi.mocked(mockConnection.getBalance)
        .mockResolvedValue(Result.fail(networkError));

      vi.mocked(mockBalanceRepo.getWalletBalances).mockResolvedValue(
        Result.ok([])
      );

      // Act
      const result = await service.fetchWalletBalance(testWallet);

      // Assert
      expect(result.isFailure).toBe(true);
      expect(result.getError().code).toBe('NETWORK_ERROR');
      expect(mockConnection.getBalance).toHaveBeenCalledTimes(3); // Max retries
    });

    it('should handle timeout errors', async () => {
      // Arrange
      const timeoutError = new TimeoutError('getBalance', 30000, 'test-endpoint');

      vi.mocked(mockConnection.getBalance)
        .mockResolvedValue(Result.fail(timeoutError));

      vi.mocked(mockBalanceRepo.getWalletBalances).mockResolvedValue(
        Result.ok([])
      );

      // Act
      const result = await service.fetchWalletBalance(testWallet);

      // Assert
      expect(result.isFailure).toBe(true);
      expect(result.getError()).toBeInstanceOf(TimeoutError);
    });

    it('should filter zero balances when requested', async () => {
      // Arrange
      const tokenAccounts: TokenAccountInfo[] = [
        {
          pubkey: PublicKeyVO.create(testAddress(101)),
          mint: PublicKeyVO.create('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
          amount: '1000000',
          decimals: 6,
          uiAmount: 1
        },
        {
          pubkey: PublicKeyVO.create(testAddress(102)),
          mint: PublicKeyVO.create('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
          amount: '0',
          decimals: 6,
          uiAmount: 0
        }
      ];

      vi.mocked(mockConnection.getBalance).mockResolvedValue(
        Result.ok(BigInt(1000000000))
      );
      vi.mocked(mockConnection.getTokenAccounts).mockResolvedValue(
        Result.ok(tokenAccounts)
      );
      vi.mocked(mockConnection.getSlot).mockResolvedValue(
        Result.ok(123456)
      );
      vi.mocked(mockAssetRepo.findByMint).mockResolvedValue(
        Result.ok(null)
      );
      vi.mocked(mockBalanceRepo.getWalletBalances).mockResolvedValue(
        Result.ok([])
      );
      vi.mocked(mockBalanceRepo.saveBalances).mockResolvedValue(
        Result.ok(undefined)
      );

      // Act
      const result = await service.fetchWalletBalance(testWallet, {
        includeZeroBalances: false
      });

      // Assert
      expect(result.isSuccess).toBe(true);
      const balance = result.getValue();
      expect(balance.tokenBalances).toHaveLength(1);
      expect(balance.tokenBalances[0].balance.getUIAmount()).toBe(1);
    });

    it('should track progress through callback', async () => {
      // Arrange
      const progressUpdates: Array<{ progress: number; message: string }> = [];
      const progressCallback = (progress: number, message: string) => {
        progressUpdates.push({ progress, message });
      };

      vi.mocked(mockConnection.getBalance).mockResolvedValue(
        Result.ok(BigInt(1000000000))
      );
      vi.mocked(mockConnection.getTokenAccounts).mockResolvedValue(
        Result.ok([])
      );
      vi.mocked(mockConnection.getSlot).mockResolvedValue(
        Result.ok(123456)
      );
      vi.mocked(mockBalanceRepo.getWalletBalances).mockResolvedValue(
        Result.ok([])
      );
      vi.mocked(mockBalanceRepo.saveBalances).mockResolvedValue(
        Result.ok(undefined)
      );

      // Act
      const result = await service.fetchWalletBalance(testWallet, {
        progressCallback
      });

      // Assert
      expect(result.isSuccess).toBe(true);
      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates[0].progress).toBe(10);
      expect(progressUpdates[progressUpdates.length - 1].progress).toBe(100);
    });
  });

  describe('batchFetchBalances', () => {
    it('should fetch balances for multiple wallets', async () => {
      // Arrange
      const wallets = [
        '7VHS8XAGP3ohBodZXpSLJpqJvjE5p5rWjGXFpRqc9gBU',
        testAddress(50)
      ];

      vi.mocked(mockConnection.getBalance).mockResolvedValue(
        Result.ok(BigInt(1000000000))
      );
      vi.mocked(mockConnection.getTokenAccounts).mockResolvedValue(
        Result.ok([])
      );
      vi.mocked(mockConnection.getSlot).mockResolvedValue(
        Result.ok(123456)
      );
      vi.mocked(mockBalanceRepo.getWalletBalances).mockResolvedValue(
        Result.ok([])
      );
      vi.mocked(mockBalanceRepo.saveBalances).mockResolvedValue(
        Result.ok(undefined)
      );

      // Act
      const results = await service.batchFetchBalances(wallets);

      // Assert
      expect(results.size).toBe(2);
      for (const [wallet, result] of results) {
        expect(result.isSuccess).toBe(true);
        expect(wallets.includes(wallet)).toBe(true);
      }
    });
  });

  describe('invalidateCache', () => {
    it('should invalidate cache for a wallet', async () => {
      // Arrange
      const wallet = '7VHS8XAGP3ohBodZXpSLJpqJvjE5p5rWjGXFpRqc9gBU';
      vi.mocked(mockBalanceRepo.invalidateWallet).mockResolvedValue(
        Result.ok(undefined)
      );

      // Act
      const result = await service.invalidateCache(wallet);

      // Assert
      expect(result.isSuccess).toBe(true);
      expect(mockBalanceRepo.invalidateWallet).toHaveBeenCalledWith(
        expect.objectContaining({
          _value: wallet
        })
      );
    });
  });
});