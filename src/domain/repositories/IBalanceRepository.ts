/**
 * Balance Repository Interface
 * 
 * Manages balance caching and retrieval for Solana wallets.
 * Provides efficient access to balance snapshots.
 */

import { PublicKeyVO } from '../asset/valueObjects/PublicKeyVO';
import { TokenAmount } from '../asset/valueObjects/TokenAmount';
import { Result } from '../shared/Result';
import { DomainError } from '../shared/DomainError';

export interface BalanceSnapshot {
  walletAddress: PublicKeyVO;
  mintAddress: PublicKeyVO;
  balance: TokenAmount;
  tokenAccount?: PublicKeyVO;
  slot: number; // Solana slot number for consistency
  timestamp: Date;
}

export interface BalanceCacheEntry {
  snapshot: BalanceSnapshot;
  ttl: number; // Time-to-live in milliseconds
  cachedAt: Date;
}

export interface IBalanceRepository {
  /**
   * Get cached balance for a wallet and token
   */
  getBalance(
    wallet: PublicKeyVO,
    mint: PublicKeyVO
  ): Promise<Result<BalanceCacheEntry | null, DomainError>>;

  /**
   * Get all cached balances for a wallet
   */
  getWalletBalances(
    wallet: PublicKeyVO
  ): Promise<Result<BalanceCacheEntry[], DomainError>>;

  /**
   * Save balance snapshot
   */
  saveBalance(
    snapshot: BalanceSnapshot,
    ttl?: number
  ): Promise<Result<void, DomainError>>;

  /**
   * Save multiple balance snapshots
   */
  saveBalances(
    snapshots: BalanceSnapshot[],
    ttl?: number
  ): Promise<Result<void, DomainError>>;

  /**
   * Check if balance is stale
   */
  isStale(
    wallet: PublicKeyVO,
    mint: PublicKeyVO,
    maxAge: number
  ): Promise<Result<boolean, DomainError>>;

  /**
   * Invalidate cached balances for a wallet
   */
  invalidateWallet(wallet: PublicKeyVO): Promise<Result<void, DomainError>>;

  /**
   * Invalidate specific balance
   */
  invalidateBalance(
    wallet: PublicKeyVO,
    mint: PublicKeyVO
  ): Promise<Result<void, DomainError>>;

  /**
   * Get cache statistics
   */
  getStats(): Promise<Result<{
    totalEntries: number;
    staleEntries: number;
    averageAge: number;
    hitRate: number;
  }, DomainError>>;

  /**
   * Clear all cached balances
   */
  clear(): Promise<Result<void, DomainError>>;

  /**
   * Prune stale entries
   */
  pruneStale(maxAge: number): Promise<Result<number, DomainError>>;
}