import {
  LendingPosition,
  StakedPosition,
  LiquidityPosition,
} from '@cygnus-wealth/data-models';

/**
 * Aggregated DeFi positions for a wallet on Solana
 */
export interface DeFiPositions {
  lendingPositions: LendingPosition[];
  stakedPositions: StakedPosition[];
  liquidityPositions: LiquidityPosition[];
}

/**
 * Configuration for DeFiService
 */
export interface DeFiServiceConfig {
  enableCache: boolean;
  cacheTTL: number;
  maxRetries: number;
  retryDelay: number;
}

/**
 * Interface for Solana DeFi protocol adapters.
 *
 * Each protocol (Marinade, Raydium, Jupiter, Orca) implements this interface
 * to provide read-only access to user DeFi positions on Solana.
 */
export interface ISolanaDeFiProtocol {
  /** Human-readable protocol name */
  readonly protocolName: string;

  /**
   * Fetches lending positions (supply/borrow) for an address.
   * Returns empty array if protocol has no lending.
   */
  getLendingPositions(address: string): Promise<LendingPosition[]>;

  /**
   * Fetches staked positions (liquid staking, vault deposits) for an address.
   * Returns empty array if protocol has no staking.
   */
  getStakedPositions(address: string): Promise<StakedPosition[]>;

  /**
   * Fetches liquidity positions (LP tokens, pool shares) for an address.
   * Returns empty array if protocol has no liquidity pools.
   */
  getLiquidityPositions(address: string): Promise<LiquidityPosition[]>;
}
