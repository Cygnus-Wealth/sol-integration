/**
 * Asset Repository Interface
 * 
 * Defines the contract for asset data persistence and retrieval.
 * Abstracts storage implementation from domain logic.
 */

import { SolanaAsset } from '../asset/aggregates/SolanaAsset';
import { PublicKeyVO } from '../asset/valueObjects/PublicKeyVO';
import { Result } from '../shared/Result';
import { DomainError } from '../shared/DomainError';

export interface AssetFilter {
  type?: 'native' | 'token' | 'nft';
  verified?: boolean;
  symbol?: string;
  mintAddresses?: string[];
}

export interface IAssetRepository {
  /**
   * Find asset by mint address
   */
  findByMint(mint: PublicKeyVO): Promise<Result<SolanaAsset | null, DomainError>>;

  /**
   * Find multiple assets by mint addresses
   */
  findByMints(mints: PublicKeyVO[]): Promise<Result<SolanaAsset[], DomainError>>;

  /**
   * Find asset by symbol
   */
  findBySymbol(symbol: string): Promise<Result<SolanaAsset[], DomainError>>;

  /**
   * Get all verified assets
   */
  getVerifiedAssets(): Promise<Result<SolanaAsset[], DomainError>>;

  /**
   * Search assets with filters
   */
  search(filter: AssetFilter): Promise<Result<SolanaAsset[], DomainError>>;

  /**
   * Save or update asset
   */
  save(asset: SolanaAsset): Promise<Result<void, DomainError>>;

  /**
   * Save multiple assets
   */
  saveMany(assets: SolanaAsset[]): Promise<Result<void, DomainError>>;

  /**
   * Check if asset exists
   */
  exists(mint: PublicKeyVO): Promise<Result<boolean, DomainError>>;

  /**
   * Get asset count
   */
  count(filter?: AssetFilter): Promise<Result<number, DomainError>>;

  /**
   * Clear all assets (for testing/cache invalidation)
   */
  clear(): Promise<Result<void, DomainError>>;
}