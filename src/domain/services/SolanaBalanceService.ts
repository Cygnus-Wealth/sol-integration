/**
 * Solana Balance Service
 * 
 * Domain service orchestrating balance fetching, caching, and aggregation.
 * Implements retry logic, fallback strategies, and progressive loading.
 */

import { PublicKeyVO } from '../asset/valueObjects/PublicKeyVO';
import { TokenAmount } from '../asset/valueObjects/TokenAmount';
import { SolanaAsset } from '../asset/aggregates/SolanaAsset';
import { IAssetRepository } from '../repositories/IAssetRepository';
import { IBalanceRepository, BalanceSnapshot } from '../repositories/IBalanceRepository';
import { Result } from '../shared/Result';
import { DomainError, NetworkError, TimeoutError } from '../shared/DomainError';

export interface WalletBalance {
  wallet: PublicKeyVO;
  nativeBalance: TokenAmount;
  tokenBalances: TokenBalance[];
  totalAccounts: number;
  lastUpdated: Date;
  fromCache: boolean;
}

export interface TokenBalance {
  mint: PublicKeyVO;
  tokenAccount: PublicKeyVO;
  balance: TokenAmount;
  asset?: SolanaAsset;
}

export interface BalanceFetchOptions {
  includeZeroBalances?: boolean;
  forceRefresh?: boolean;
  maxCacheAge?: number; // milliseconds
  includeNFTs?: boolean;
  progressCallback?: (progress: number, message: string) => void;
}

export interface ISolanaConnection {
  getBalance(wallet: PublicKeyVO): Promise<Result<bigint, DomainError>>;
  getTokenAccounts(wallet: PublicKeyVO): Promise<Result<TokenAccountInfo[], DomainError>>;
  getSlot(): Promise<Result<number, DomainError>>;
  getMultipleAccounts(addresses: PublicKeyVO[]): Promise<Result<any[], DomainError>>;
}

export interface TokenAccountInfo {
  pubkey: PublicKeyVO;
  mint: PublicKeyVO;
  amount: string;
  decimals: number;
  uiAmount?: number;
}

export class SolanaBalanceService {
  private readonly DEFAULT_CACHE_TTL = 30000; // 30 seconds
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 1000; // 1 second

  constructor(
    private connection: ISolanaConnection,
    private assetRepository: IAssetRepository,
    private balanceRepository: IBalanceRepository
  ) {}

  /**
   * Fetch complete wallet balance
   */
  async fetchWalletBalance(
    wallet: string,
    options: BalanceFetchOptions = {}
  ): Promise<Result<WalletBalance, DomainError>> {
    try {
      const walletKey = PublicKeyVO.create(wallet);
      const maxCacheAge = options.maxCacheAge ?? this.DEFAULT_CACHE_TTL;

      // Check cache first unless force refresh
      if (!options.forceRefresh) {
        const cachedResult = await this.getCachedBalance(walletKey, maxCacheAge);
        if (cachedResult.isSuccess() && cachedResult.getValue()) {
          options.progressCallback?.(100, 'Loaded from cache');
          return Result.ok(cachedResult.getValue()!);
        }
      }

      options.progressCallback?.(10, 'Fetching native SOL balance');

      // Fetch native SOL balance with retry
      const nativeBalanceResult = await this.fetchNativeBalanceWithRetry(walletKey);
      if (nativeBalanceResult.isFailure()) {
        return Result.fail(nativeBalanceResult.getError());
      }

      options.progressCallback?.(30, 'Fetching token accounts');

      // Fetch token accounts
      const tokenAccountsResult = await this.fetchTokenAccountsWithRetry(walletKey);
      if (tokenAccountsResult.isFailure()) {
        return Result.fail(tokenAccountsResult.getError());
      }

      const tokenAccounts = tokenAccountsResult.getValue();
      const tokenBalances: TokenBalance[] = [];

      // Process token accounts
      let processedCount = 0;
      for (const account of tokenAccounts) {
        if (!options.includeZeroBalances && account.amount === '0') {
          continue;
        }

        // Fetch asset metadata
        const assetResult = await this.assetRepository.findByMint(account.mint);
        const asset = assetResult.isSuccess() ? assetResult.getValue() : undefined;

        // Skip NFTs if not requested
        if (!options.includeNFTs && asset?.isNFT()) {
          continue;
        }

        tokenBalances.push({
          mint: account.mint,
          tokenAccount: account.pubkey,
          balance: TokenAmount.fromTokenUnits(account.amount, account.decimals),
          asset: asset || undefined
        });

        processedCount++;
        const progress = 30 + (processedCount / tokenAccounts.length) * 60;
        options.progressCallback?.(
          Math.min(90, progress),
          `Processing token ${processedCount}/${tokenAccounts.length}`
        );
      }

      // Get current slot for consistency
      const slotResult = await this.connection.getSlot();
      const slot = slotResult.isSuccess() ? slotResult.getValue() : 0;

      // Create wallet balance
      const walletBalance: WalletBalance = {
        wallet: walletKey,
        nativeBalance: nativeBalanceResult.getValue(),
        tokenBalances,
        totalAccounts: 1 + tokenBalances.length,
        lastUpdated: new Date(),
        fromCache: false
      };

      // Cache the results
      await this.cacheWalletBalance(walletKey, walletBalance, slot);

      options.progressCallback?.(100, 'Balance fetch complete');

      return Result.ok(walletBalance);

    } catch (error) {
      return Result.fail(
        new NetworkError(
          error instanceof Error ? error.message : 'Unknown error',
          wallet
        )
      );
    }
  }

  /**
   * Fetch native SOL balance with retry logic
   */
  private async fetchNativeBalanceWithRetry(
    wallet: PublicKeyVO
  ): Promise<Result<TokenAmount, DomainError>> {
    let lastError: DomainError | undefined;

    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      const result = await this.connection.getBalance(wallet);
      
      if (result.isSuccess()) {
        return Result.ok(TokenAmount.fromLamports(result.getValue()));
      }

      lastError = result.getError();

      // Don't retry for non-retryable errors
      if (!(lastError instanceof NetworkError) || !lastError.retryable) {
        break;
      }

      // Wait before retry with exponential backoff
      if (attempt < this.MAX_RETRIES - 1) {
        await this.delay(this.RETRY_DELAY * Math.pow(2, attempt));
      }
    }

    return Result.fail(
      lastError || new NetworkError('All retry attempts failed', wallet.toString())
    );
  }

  /**
   * Fetch token accounts with retry logic
   */
  private async fetchTokenAccountsWithRetry(
    wallet: PublicKeyVO
  ): Promise<Result<TokenAccountInfo[], DomainError>> {
    let lastError: DomainError | undefined;

    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      const result = await this.connection.getTokenAccounts(wallet);
      
      if (result.isSuccess()) {
        return result;
      }

      lastError = result.getError();

      // Don't retry for non-retryable errors
      if (!(lastError instanceof NetworkError) || !lastError.retryable) {
        break;
      }

      // Wait before retry
      if (attempt < this.MAX_RETRIES - 1) {
        await this.delay(this.RETRY_DELAY * Math.pow(2, attempt));
      }
    }

    return Result.fail(
      lastError || new NetworkError('All retry attempts failed', wallet.toString())
    );
  }

  /**
   * Get cached balance if available and fresh
   */
  private async getCachedBalance(
    wallet: PublicKeyVO,
    maxAge: number
  ): Promise<Result<WalletBalance | null, DomainError>> {
    const cachedBalancesResult = await this.balanceRepository.getWalletBalances(wallet);
    
    if (cachedBalancesResult.isFailure()) {
      return Result.ok(null); // Cache miss is not an error
    }

    const cachedBalances = cachedBalancesResult.getValue();
    if (cachedBalances.length === 0) {
      return Result.ok(null);
    }

    // Check if any cached entry is stale
    const now = Date.now();
    const isStale = cachedBalances.some(
      entry => now - entry.cachedAt.getTime() > maxAge
    );

    if (isStale) {
      return Result.ok(null);
    }

    // Reconstruct wallet balance from cache
    const nativeEntry = cachedBalances.find(
      entry => entry.snapshot.mintAddress.toBase58() === 'So11111111111111111111111111111111111111112'
    );

    if (!nativeEntry) {
      return Result.ok(null);
    }

    const tokenBalances: TokenBalance[] = [];
    for (const entry of cachedBalances) {
      if (entry.snapshot.mintAddress.toBase58() === 'So11111111111111111111111111111111111111112') {
        continue;
      }

      const assetResult = await this.assetRepository.findByMint(entry.snapshot.mintAddress);
      const asset = assetResult.isSuccess() ? assetResult.getValue() : undefined;

      tokenBalances.push({
        mint: entry.snapshot.mintAddress,
        tokenAccount: entry.snapshot.tokenAccount!,
        balance: entry.snapshot.balance,
        asset: asset || undefined
      });
    }

    return Result.ok({
      wallet,
      nativeBalance: nativeEntry.snapshot.balance,
      tokenBalances,
      totalAccounts: 1 + tokenBalances.length,
      lastUpdated: nativeEntry.cachedAt,
      fromCache: true
    });
  }

  /**
   * Cache wallet balance
   */
  private async cacheWalletBalance(
    wallet: PublicKeyVO,
    balance: WalletBalance,
    slot: number
  ): Promise<void> {
    const snapshots: BalanceSnapshot[] = [];

    // Cache native balance
    snapshots.push({
      walletAddress: wallet,
      mintAddress: PublicKeyVO.create('So11111111111111111111111111111111111111112'),
      balance: balance.nativeBalance,
      slot,
      timestamp: balance.lastUpdated
    });

    // Cache token balances
    for (const tokenBalance of balance.tokenBalances) {
      snapshots.push({
        walletAddress: wallet,
        mintAddress: tokenBalance.mint,
        balance: tokenBalance.balance,
        tokenAccount: tokenBalance.tokenAccount,
        slot,
        timestamp: balance.lastUpdated
      });
    }

    await this.balanceRepository.saveBalances(snapshots, this.DEFAULT_CACHE_TTL);
  }

  /**
   * Batch fetch balances for multiple wallets
   */
  async batchFetchBalances(
    wallets: string[],
    options: BalanceFetchOptions = {}
  ): Promise<Map<string, Result<WalletBalance, DomainError>>> {
    const results = new Map<string, Result<WalletBalance, DomainError>>();
    
    // Process in parallel with concurrency limit
    const concurrencyLimit = 5;
    const chunks = this.chunkArray(wallets, concurrencyLimit);
    
    for (const chunk of chunks) {
      const promises = chunk.map(async (wallet) => {
        const result = await this.fetchWalletBalance(wallet, options);
        return { wallet, result };
      });
      
      const chunkResults = await Promise.all(promises);
      chunkResults.forEach(({ wallet, result }) => {
        results.set(wallet, result);
      });
    }
    
    return results;
  }

  /**
   * Invalidate cache for a wallet
   */
  async invalidateCache(wallet: string): Promise<Result<void, DomainError>> {
    try {
      const walletKey = PublicKeyVO.create(wallet);
      return await this.balanceRepository.invalidateWallet(walletKey);
    } catch (error) {
      return Result.fail(
        new CacheError('invalidate', 'Failed to invalidate cache')
      );
    }
  }

  /**
   * Helper to chunk array for parallel processing
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Helper for delays
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}