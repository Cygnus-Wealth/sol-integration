/**
 * Token Discovery Service
 * 
 * Domain service for discovering SPL tokens for a wallet.
 * Orchestrates token account discovery, metadata fetching, and asset creation.
 */

import { PublicKeyVO } from '../asset/valueObjects/PublicKeyVO';
import { TokenAmount } from '../asset/valueObjects/TokenAmount';
import { TokenMetadata } from '../asset/valueObjects/TokenMetadata';
import { SolanaAsset } from '../asset/aggregates/SolanaAsset';
import { NFTAsset, NFTMetaplexMetadata } from '../asset/entities/NFTAsset';
import { IAssetRepository } from '../repositories/IAssetRepository';
import { Result } from '../shared/Result';
import {
  DomainError,
  NetworkError,
  MetadataFetchError,
  NFTParseError,
  AssetNotFoundError,
  OperationError
} from '../shared/DomainError';

export interface TokenAccountData {
  pubkey: PublicKeyVO;
  mint: PublicKeyVO;
  owner: PublicKeyVO;
  amount: string;
  decimals: number;
  uiAmount?: number;
  state: 'initialized' | 'uninitialized' | 'frozen';
}

export interface SPLTokenMetadata {
  mint: PublicKeyVO;
  name: string;
  symbol: string;
  decimals: number;
  logoUri?: string;
  description?: string;
  website?: string;
  coingeckoId?: string;
  verified: boolean;
  supply?: string;
  tags: string[];
}

export interface DiscoveryOptions {
  includeZeroBalances?: boolean;
  includeNFTs?: boolean;
  includeUnverified?: boolean;
  batchSize?: number;
  maxRetries?: number;
  progressCallback?: (progress: number, message: string) => void;
}

export interface DiscoveryResult {
  tokens: SolanaAsset[];
  nfts: NFTAsset[];
  tokenAccounts: TokenAccountData[];
  totalProcessed: number;
  errors: DomainError[];
  lastUpdated: Date;
}

export interface ITokenDiscoveryConnection {
  getTokenAccountsByOwner(owner: PublicKeyVO): Promise<Result<TokenAccountData[], DomainError>>;
  getTokenMetadata(mint: PublicKeyVO): Promise<Result<SPLTokenMetadata | null, DomainError>>;
  getNFTMetadata(mint: PublicKeyVO): Promise<Result<NFTMetaplexMetadata | null, DomainError>>;
  getMultipleTokenMetadata(mints: PublicKeyVO[]): Promise<Result<Map<string, SPLTokenMetadata>, DomainError>>;
}

export class TokenDiscoveryService {
  private readonly DEFAULT_BATCH_SIZE = 50;
  private readonly DEFAULT_MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 1000;

  constructor(
    private connection: ITokenDiscoveryConnection,
    private assetRepository: IAssetRepository
  ) {}

  /**
   * Discover all tokens for a wallet
   */
  async discoverTokens(
    walletAddress: string,
    options: DiscoveryOptions = {}
  ): Promise<Result<DiscoveryResult, DomainError>> {
    try {
      const wallet = PublicKeyVO.create(walletAddress);
      const batchSize = options.batchSize ?? this.DEFAULT_BATCH_SIZE;
      
      options.progressCallback?.(5, 'Fetching token accounts');

      // Get all token accounts for the wallet
      const tokenAccountsResult = await this.connection.getTokenAccountsByOwner(wallet);
      if (tokenAccountsResult.isFailure) {
        return Result.fail(tokenAccountsResult.getError());
      }

      const tokenAccounts = tokenAccountsResult.getValue();
      
      // Filter accounts based on options
      const filteredAccounts = this.filterTokenAccounts(tokenAccounts, options);
      
      options.progressCallback?.(15, `Processing ${filteredAccounts.length} token accounts`);

      const result: DiscoveryResult = {
        tokens: [],
        nfts: [],
        tokenAccounts: filteredAccounts,
        totalProcessed: 0,
        errors: [],
        lastUpdated: new Date()
      };

      // Process in batches
      const batches = this.chunkArray(filteredAccounts, batchSize);
      let processedCount = 0;

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const batchProgress = 15 + ((i / batches.length) * 70);
        
        options.progressCallback?.(
          batchProgress,
          `Processing batch ${i + 1}/${batches.length}`
        );

        const batchResult = await this.processBatch(batch, options);
        
        result.tokens.push(...batchResult.tokens);
        result.nfts.push(...batchResult.nfts);
        result.errors.push(...batchResult.errors);
        processedCount += batch.length;
        
        result.totalProcessed = processedCount;
      }

      // Save discovered assets to repository
      options.progressCallback?.(90, 'Saving discovered assets');
      await this.saveDiscoveredAssets(result.tokens);

      options.progressCallback?.(100, 'Discovery complete');

      return Result.ok(result);

    } catch (error) {
      return Result.fail(
        new OperationError(
          'TOKEN_DISCOVERY_ERROR',
          error instanceof Error ? error.message : 'Unknown discovery error',
          { walletAddress }
        )
      );
    }
  }

  /**
   * Discover a specific token by mint address
   */
  async discoverToken(mintAddress: string): Promise<Result<SolanaAsset, DomainError>> {
    try {
      const mint = PublicKeyVO.create(mintAddress);
      
      // Check if already in repository
      const existingResult = await this.assetRepository.findByMint(mint);
      if (existingResult.isSuccess && existingResult.getValue()) {
        return Result.ok(existingResult.getValue()!);
      }

      // Fetch metadata
      const metadataResult = await this.connection.getTokenMetadata(mint);
      if (metadataResult.isFailure) {
        return Result.fail(metadataResult.getError());
      }

      const metadata = metadataResult.getValue();
      if (!metadata) {
        return Result.fail(new AssetNotFoundError(mintAddress, 'metadata'));
      }

      // Create asset
      const tokenMetadata = TokenMetadata.create({
        name: metadata.name,
        symbol: metadata.symbol,
        decimals: metadata.decimals,
        logoUri: metadata.logoUri,
        description: metadata.description,
        website: metadata.website,
        coingeckoId: metadata.coingeckoId,
        verified: metadata.verified,
        tags: metadata.tags
      });

      const asset = SolanaAsset.createToken(
        mintAddress,
        tokenMetadata.getValue(),
        metadata.supply,
        metadata.decimals
      );

      // Save to repository
      await this.assetRepository.save(asset);

      return Result.ok(asset);

    } catch (error) {
      return Result.fail(
        new MetadataFetchError(
          mintAddress,
          error instanceof Error ? error.message : 'Unknown error'
        )
      );
    }
  }

  /**
   * Refresh metadata for known tokens
   */
  async refreshTokenMetadata(
    mintAddresses: string[],
    options: { progressCallback?: (progress: number, message: string) => void } = {}
  ): Promise<Result<SolanaAsset[], DomainError>> {
    try {
      const mints = mintAddresses.map(addr => PublicKeyVO.create(addr));
      const refreshedAssets: SolanaAsset[] = [];
      
      options.progressCallback?.(10, 'Fetching updated metadata');

      // Batch fetch metadata
      const metadataResult = await this.connection.getMultipleTokenMetadata(mints);
      if (metadataResult.isFailure) {
        return Result.fail(metadataResult.getError());
      }

      const metadataMap = metadataResult.getValue();
      let processedCount = 0;

      options.progressCallback?.(30, 'Processing metadata updates');

      for (const [mintAddress, metadata] of metadataMap) {
        try {
          // Get existing asset
          const mint = PublicKeyVO.create(mintAddress);
          const existingResult = await this.assetRepository.findByMint(mint);
          
          if (existingResult.isSuccess && existingResult.getValue()) {
            const asset = existingResult.getValue()!;
            
            // Update metadata
            const updatedMetadata = {
              name: metadata.name,
              symbol: metadata.symbol,
              decimals: metadata.decimals,
              logoUri: metadata.logoUri,
              description: metadata.description,
              website: metadata.website,
              coingeckoId: metadata.coingeckoId,
              verified: metadata.verified
            };

            asset.updateMetadata(updatedMetadata);
            refreshedAssets.push(asset);
          }

          processedCount++;
          const progress = 30 + ((processedCount / metadataMap.size) * 60);
          options.progressCallback?.(
            progress,
            `Updated ${processedCount}/${metadataMap.size} assets`
          );

        } catch (error) {
          // Continue processing other assets even if one fails
          console.warn(`Failed to update metadata for ${mintAddress}:`, error);
        }
      }

      // Save updated assets
      options.progressCallback?.(95, 'Saving updated assets');
      if (refreshedAssets.length > 0) {
        await this.assetRepository.saveMany(refreshedAssets);
      }

      options.progressCallback?.(100, 'Refresh complete');

      return Result.ok(refreshedAssets);

    } catch (error) {
      return Result.fail(
        new OperationError(
          'METADATA_REFRESH_ERROR',
          error instanceof Error ? error.message : 'Unknown refresh error',
          { mintAddresses }
        )
      );
    }
  }

  /**
   * Process a batch of token accounts
   */
  private async processBatch(
    tokenAccounts: TokenAccountData[],
    options: DiscoveryOptions
  ): Promise<{
    tokens: SolanaAsset[];
    nfts: NFTAsset[];
    errors: DomainError[];
  }> {
    const tokens: SolanaAsset[] = [];
    const nfts: NFTAsset[] = [];
    const errors: DomainError[] = [];

    // Extract unique mints
    const uniqueMints = Array.from(
      new Set(tokenAccounts.map(account => account.mint.toBase58()))
    ).map(mint => PublicKeyVO.create(mint));

    // Batch fetch metadata for all mints
    const metadataResult = await this.connection.getMultipleTokenMetadata(uniqueMints);
    const metadataMap = metadataResult.isSuccess 
      ? metadataResult.getValue() 
      : new Map<string, SPLTokenMetadata>();

    // Process each token account
    for (const account of tokenAccounts) {
      try {
        const mintAddress = account.mint.toBase58();
        const metadata = metadataMap.get(mintAddress);

        if (!metadata) {
          // Try to fetch NFT metadata
          if (options.includeNFTs) {
            const nftResult = await this.processNFTAccount(account);
            if (nftResult.isSuccess) {
              nfts.push(nftResult.getValue());
              continue;
            }
          }
          
          errors.push(new MetadataFetchError(mintAddress, 'No metadata found'));
          continue;
        }

        // Skip unverified tokens if not requested
        if (!options.includeUnverified && !metadata.verified) {
          continue;
        }

        // Create token asset
        const tokenMetadata = TokenMetadata.create({
          name: metadata.name,
          symbol: metadata.symbol,
          decimals: metadata.decimals,
          logoUri: metadata.logoUri,
          description: metadata.description,
          website: metadata.website,
          coingeckoId: metadata.coingeckoId,
          verified: metadata.verified,
          tags: metadata.tags
        });

        const asset = SolanaAsset.createToken(
          mintAddress,
          tokenMetadata.getValue(),
          metadata.supply,
          metadata.decimals
        );

        tokens.push(asset);

      } catch (error) {
        errors.push(
          new OperationError(
            'TOKEN_PROCESSING_ERROR',
            error instanceof Error ? error.message : 'Unknown processing error',
            { mint: account.mint.toBase58() }
          )
        );
      }
    }

    return { tokens, nfts, errors };
  }

  /**
   * Process NFT token account
   */
  private async processNFTAccount(account: TokenAccountData): Promise<Result<NFTAsset, DomainError>> {
    try {
      const nftMetadataResult = await this.connection.getNFTMetadata(account.mint);
      if (nftMetadataResult.isFailure) {
        return Result.fail(nftMetadataResult.getError());
      }

      const metadata = nftMetadataResult.getValue();
      if (!metadata) {
        return Result.fail(new MetadataFetchError(account.mint.toBase58(), 'No NFT metadata'));
      }

      const nft = NFTAsset.fromMetaplexMetadata(
        account.mint.toBase58(),
        metadata,
        account.owner.toBase58()
      );

      return Result.ok(nft);

    } catch (error) {
      return Result.fail(
        new NFTParseError(
          account.mint.toBase58(),
          error instanceof Error ? error.message : 'Unknown NFT processing error'
        )
      );
    }
  }

  /**
   * Filter token accounts based on options
   */
  private filterTokenAccounts(
    accounts: TokenAccountData[],
    options: DiscoveryOptions
  ): TokenAccountData[] {
    return accounts.filter(account => {
      // Skip zero balances if not requested
      if (!options.includeZeroBalances && account.amount === '0') {
        return false;
      }

      // Skip frozen accounts
      if (account.state === 'frozen') {
        return false;
      }

      return true;
    });
  }

  /**
   * Save discovered assets to repository
   */
  private async saveDiscoveredAssets(assets: SolanaAsset[]): Promise<void> {
    if (assets.length === 0) return;

    try {
      // Check which assets are new
      const newAssets: SolanaAsset[] = [];
      
      for (const asset of assets) {
        const existingResult = await this.assetRepository.findByMint(asset.getMint());
        if (existingResult.isFailure || !existingResult.getValue()) {
          newAssets.push(asset);
        }
      }

      if (newAssets.length > 0) {
        await this.assetRepository.saveMany(newAssets);
      }
    } catch (error) {
      // Log error but don't fail the discovery process
      console.warn('Failed to save discovered assets:', error);
    }
  }

  /**
   * Chunk array into smaller arrays
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Get discovery statistics for a wallet
   */
  async getDiscoveryStats(walletAddress: string): Promise<Result<{
    totalTokenAccounts: number;
    uniqueTokens: number;
    verifiedTokens: number;
    nfts: number;
    lastDiscovery?: Date;
  }, DomainError>> {
    try {
      const wallet = PublicKeyVO.create(walletAddress);
      
      const tokenAccountsResult = await this.connection.getTokenAccountsByOwner(wallet);
      if (tokenAccountsResult.isFailure) {
        return Result.fail(tokenAccountsResult.getError());
      }

      const accounts = tokenAccountsResult.getValue();
      const uniqueMints = new Set(accounts.map(acc => acc.mint.toBase58()));
      
      // Get verified count from repository
      const verifiedResult = await this.assetRepository.getVerifiedAssets();
      const verifiedCount = verifiedResult.isSuccess 
        ? verifiedResult.getValue().filter(asset => 
            uniqueMints.has(asset.getMintAddress())
          ).length
        : 0;

      return Result.ok({
        totalTokenAccounts: accounts.length,
        uniqueTokens: uniqueMints.size,
        verifiedTokens: verifiedCount,
        nfts: accounts.filter(acc => acc.amount === '1' && acc.decimals === 0).length,
        lastDiscovery: new Date() // This would come from cache in real implementation
      });

    } catch (error) {
      return Result.fail(
        new OperationError(
          'DISCOVERY_STATS_ERROR',
          error instanceof Error ? error.message : 'Unknown stats error',
          { walletAddress }
        )
      );
    }
  }
}