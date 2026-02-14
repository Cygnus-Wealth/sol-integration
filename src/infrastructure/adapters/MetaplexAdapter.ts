/**
 * Metaplex Adapter
 * 
 * Integrates @metaplex-foundation/js for comprehensive NFT metadata handling.
 * Supports Metaplex standards and various NFT metadata formats.
 */

import { Metaplex, keypairIdentity, bundlrStorage } from '@metaplex-foundation/js';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { PublicKeyVO } from '../../domain/asset/valueObjects/PublicKeyVO';
import { Result } from '../../domain/shared/Result';
import { DomainError, MetaplexMetadataError, NetworkError, ValidationError } from '../../domain/shared/DomainError';
import { LRUCache } from '../cache/LRUCache';

export interface NFTMetadata {
  mint: PublicKeyVO;
  name: string;
  symbol: string;
  description?: string;
  image?: string;
  animationUrl?: string;
  externalUrl?: string;
  attributes?: Array<{
    trait_type: string;
    value: string | number;
    display_type?: string;
  }>;
  properties?: {
    category?: string;
    files?: Array<{
      uri: string;
      type: string;
      cdn?: boolean;
    }>;
    creators?: Array<{
      address: string;
      verified: boolean;
      share: number;
    }>;
  };
  collection?: {
    name: string;
    family: string;
    verified?: boolean;
  };
  sellerFeeBasisPoints?: number;
  primarySaleHappened?: boolean;
  isMutable?: boolean;
  tokenStandard?: string;
  uses?: {
    useMethod: string;
    remaining: number;
    total: number;
  };
}

export interface NFTCollectionInfo {
  collectionMint: PublicKeyVO;
  name: string;
  symbol: string;
  description?: string;
  image?: string;
  externalUrl?: string;
  verified: boolean;
  size: number;
  items: PublicKeyVO[];
}

export interface NFTOwnershipInfo {
  mint: PublicKeyVO;
  owner: PublicKeyVO;
  tokenAccount: PublicKeyVO;
  amount: number; // Should be 1 for NFTs
  frozen: boolean;
}

export class MetaplexAdapter {
  private metaplex: Metaplex;
  private connection: Connection;
  private metadataCache: LRUCache<NFTMetadata>;
  private collectionCache: LRUCache<NFTCollectionInfo>;

  constructor(connection: Connection, config?: {
    metadataCacheSize?: number;
    metadataCacheTTL?: number;
    collectionCacheSize?: number;
    collectionCacheTTL?: number;
    useStorage?: boolean;
  }) {
    this.connection = connection;
    
    // Create a dummy keypair for read-only operations
    const dummyKeypair = Keypair.generate();
    
    this.metaplex = Metaplex.make(connection)
      .use(keypairIdentity(dummyKeypair));

    // Add storage if specified (not needed for read-only operations)
    if (config?.useStorage) {
      this.metaplex.use(bundlrStorage());
    }

    // Initialize caches
    this.metadataCache = new LRUCache({
      maxSize: config?.metadataCacheSize || 5000,
      defaultTTL: config?.metadataCacheTTL || 300000, // 5 minutes
      onEvict: (key, metadata) => {
        console.debug(`NFT metadata cache evicted: ${key}`);
      }
    });

    this.collectionCache = new LRUCache({
      maxSize: config?.collectionCacheSize || 1000,
      defaultTTL: config?.collectionCacheTTL || 600000, // 10 minutes
      onEvict: (key, collection) => {
        console.debug(`Collection cache evicted: ${key}`);
      }
    });
  }

  /**
   * Fetch NFT metadata by mint address
   */
  async getNFTMetadata(mint: PublicKeyVO): Promise<Result<NFTMetadata | null, DomainError>> {
    try {
      const mintAddress = mint.toBase58();
      
      // Check cache first
      const cachedResult = this.metadataCache.get(mintAddress);
      if (cachedResult.isSuccess && cachedResult.getValue()) {
        return Result.ok(cachedResult.getValue()!);
      }

      // Fetch from Metaplex
      const nft = await this.metaplex.nfts().findByMint({
        mintAddress: mint.toPublicKey()
      });

      if (!nft) {
        return Result.ok(null);
      }

      // Load JSON metadata if URI is present
      let jsonMetadata: any = {};
      if (nft.uri) {
        try {
          const response = await fetch(nft.uri);
          if (response.ok) {
            jsonMetadata = await response.json();
          }
        } catch (error) {
          console.warn(`Failed to fetch JSON metadata from ${nft.uri}: ${error}`);
        }
      }

      const metadata: NFTMetadata = {
        mint,
        name: nft.name || jsonMetadata.name || 'Unknown',
        symbol: nft.symbol || jsonMetadata.symbol || '',
        description: jsonMetadata.description,
        image: jsonMetadata.image,
        animationUrl: jsonMetadata.animation_url,
        externalUrl: jsonMetadata.external_url,
        attributes: jsonMetadata.attributes || [],
        properties: {
          category: jsonMetadata.properties?.category,
          files: jsonMetadata.properties?.files || [],
          creators: nft.creators?.map(creator => ({
            address: creator.address.toBase58(),
            verified: creator.verified,
            share: creator.share
          })) || []
        },
        collection: nft.collection ? {
          name: jsonMetadata.collection?.name || 'Unknown Collection',
          family: jsonMetadata.collection?.family || '',
          verified: nft.collection.verified
        } : undefined,
        sellerFeeBasisPoints: nft.sellerFeeBasisPoints,
        primarySaleHappened: nft.primarySaleHappened,
        isMutable: nft.isMutable,
        tokenStandard: nft.tokenStandard?.toString(),
        uses: nft.uses ? {
          useMethod: nft.uses.useMethod.toString(),
          remaining: Number(nft.uses.remaining),
          total: Number(nft.uses.total)
        } : undefined
      };

      // Cache the result
      this.metadataCache.set(mintAddress, metadata);

      return Result.ok(metadata);
    } catch (error) {
      return Result.fail(
        new MetaplexMetadataError(
          mint.toBase58(),
          `Failed to fetch NFT metadata: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Fetch multiple NFT metadata in batch
   */
  async getMultipleNFTMetadata(
    mints: PublicKeyVO[]
  ): Promise<Result<Map<string, NFTMetadata>, DomainError>> {
    try {
      const results = new Map<string, NFTMetadata>();
      const uncachedMints: PublicKeyVO[] = [];

      // Check cache first
      for (const mint of mints) {
        const mintAddress = mint.toBase58();
        const cachedResult = this.metadataCache.get(mintAddress);
        if (cachedResult.isSuccess && cachedResult.getValue()) {
          results.set(mintAddress, cachedResult.getValue()!);
        } else {
          uncachedMints.push(mint);
        }
      }

      // Fetch uncached metadata in batches
      const batchSize = 20;
      for (let i = 0; i < uncachedMints.length; i += batchSize) {
        const batch = uncachedMints.slice(i, i + batchSize);
        
        const batchPromises = batch.map(mint => this.getNFTMetadata(mint));
        const batchResults = await Promise.allSettled(batchPromises);

        for (let j = 0; j < batchResults.length; j++) {
          const result = batchResults[j];
          const mint = batch[j];
          
          if (result.status === 'fulfilled' && result.value.isSuccess) {
            const metadata = result.value.getValue();
            if (metadata) {
              results.set(mint.toBase58(), metadata);
            }
          }
        }
      }

      return Result.ok(results);
    } catch (error) {
      return Result.fail(
        new MetaplexMetadataError(
          'batch',
          `Failed to fetch multiple NFT metadata: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Get NFTs owned by a wallet
   */
  async getNFTsByOwner(
    owner: PublicKeyVO,
    options?: {
      verified?: boolean;
      collection?: PublicKeyVO;
      limit?: number;
    }
  ): Promise<Result<NFTMetadata[], DomainError>> {
    try {
      const nfts = await this.metaplex.nfts().findAllByOwner({
        owner: owner.toPublicKey()
      });

      let filteredNfts = nfts;

      // Apply filters
      if (options?.verified !== undefined) {
        filteredNfts = filteredNfts.filter(nft => 
          options.verified ? nft.collection?.verified === true : nft.collection?.verified !== true
        );
      }

      if (options?.collection) {
        filteredNfts = filteredNfts.filter(nft => 
          nft.collection?.address.equals(options.collection!.toPublicKey())
        );
      }

      if (options?.limit) {
        filteredNfts = filteredNfts.slice(0, options.limit);
      }

      // Convert to our metadata format
      const metadataResults: NFTMetadata[] = [];
      
      for (const nft of filteredNfts) {
        try {
          const mintVO = PublicKeyVO.fromPublicKey(nft.address);
          const metadataResult = await this.getNFTMetadata(mintVO);
          
          if (metadataResult.isSuccess && metadataResult.getValue()) {
            metadataResults.push(metadataResult.getValue()!);
          }
        } catch (error) {
          console.warn(`Skipping NFT ${nft.address.toBase58()}: ${error}`);
        }
      }

      return Result.ok(metadataResults);
    } catch (error) {
      return Result.fail(
        new NetworkError(
          `Failed to fetch NFTs by owner: ${error instanceof Error ? error.message : String(error)}`,
          this.connection.rpcEndpoint
        )
      );
    }
  }

  /**
   * Get collection information
   */
  async getCollectionInfo(
    collectionMint: PublicKeyVO
  ): Promise<Result<NFTCollectionInfo | null, DomainError>> {
    try {
      const collectionAddress = collectionMint.toBase58();
      
      // Check cache first
      const cachedResult = this.collectionCache.get(collectionAddress);
      if (cachedResult.isSuccess && cachedResult.getValue()) {
        return Result.ok(cachedResult.getValue()!);
      }

      // Fetch collection NFT
      const collectionNft = await this.metaplex.nfts().findByMint({
        mintAddress: collectionMint.toPublicKey()
      });

      if (!collectionNft) {
        return Result.ok(null);
      }

      // Find all NFTs in this collection
      const collectionItems = await this.metaplex.nfts().findAllByCreator({
        creator: collectionMint.toPublicKey()
      });

      const collectionInfo: NFTCollectionInfo = {
        collectionMint,
        name: collectionNft.name || 'Unknown Collection',
        symbol: collectionNft.symbol || '',
        description: undefined, // Would need to fetch from JSON metadata
        image: undefined, // Would need to fetch from JSON metadata
        externalUrl: undefined, // Would need to fetch from JSON metadata
        verified: collectionNft.collection?.verified || false,
        size: collectionItems.length,
        items: collectionItems.map(item => PublicKeyVO.fromPublicKey(item.address))
      };

      // Cache the result
      this.collectionCache.set(collectionAddress, collectionInfo);

      return Result.ok(collectionInfo);
    } catch (error) {
      return Result.fail(
        new MetaplexMetadataError(
          collectionMint.toBase58(),
          `Failed to fetch collection info: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Verify if an NFT belongs to a specific collection
   */
  async verifyCollectionMembership(
    nftMint: PublicKeyVO,
    collectionMint: PublicKeyVO
  ): Promise<Result<boolean, DomainError>> {
    try {
      const nft = await this.metaplex.nfts().findByMint({
        mintAddress: nftMint.toPublicKey()
      });

      if (!nft || !nft.collection) {
        return Result.ok(false);
      }

      const belongsToCollection = nft.collection.address.equals(collectionMint.toPublicKey());
      const isVerified = nft.collection.verified;

      return Result.ok(belongsToCollection && isVerified);
    } catch (error) {
      return Result.fail(
        new MetaplexMetadataError(
          nftMint.toBase58(),
          `Failed to verify collection membership: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Get NFT ownership information
   */
  async getNFTOwnership(
    mint: PublicKeyVO
  ): Promise<Result<NFTOwnershipInfo | null, DomainError>> {
    try {
      const nft = await this.metaplex.nfts().findByMint({
        mintAddress: mint.toPublicKey()
      });

      if (!nft) {
        return Result.ok(null);
      }

      // Get the largest token account (should be the owner for NFTs)
      const tokenAccounts = await this.connection.getTokenLargestAccounts(mint.toPublicKey());
      
      if (tokenAccounts.value.length === 0) {
        return Result.ok(null);
      }

      const largestAccount = tokenAccounts.value[0];
      
      // Get account info to determine owner
      const accountInfo = await this.connection.getAccountInfo(largestAccount.address);
      if (!accountInfo) {
        return Result.ok(null);
      }

      // Parse account data to get owner (simplified - would need proper account parsing)
      const ownershipInfo: NFTOwnershipInfo = {
        mint,
        owner: PublicKeyVO.fromPublicKey(largestAccount.address), // This is simplified
        tokenAccount: PublicKeyVO.fromPublicKey(largestAccount.address),
        amount: Number(largestAccount.amount),
        frozen: false // Would need to check account state
      };

      return Result.ok(ownershipInfo);
    } catch (error) {
      return Result.fail(
        new MetaplexMetadataError(
          mint.toBase58(),
          `Failed to get NFT ownership: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Search NFTs by attributes
   */
  async searchNFTsByAttributes(
    attributes: Array<{ trait_type: string; value: string | number }>,
    collection?: PublicKeyVO
  ): Promise<Result<NFTMetadata[], DomainError>> {
    try {
      // This is a simplified implementation
      // In practice, you'd need an indexing service for efficient attribute searches
      
      let searchBase: NFTMetadata[] = [];
      
      if (collection) {
        const nftsByCollectionResult = await this.getNFTsByOwner(
          PublicKeyVO.fromPublicKey(new PublicKey('11111111111111111111111111111111')), // System program as placeholder
          { collection }
        );
        
        if (nftsByCollectionResult.isSuccess) {
          searchBase = nftsByCollectionResult.getValue();
        }
      }

      // Filter by attributes
      const matchingNFTs = searchBase.filter(nft => {
        if (!nft.attributes) return false;
        
        return attributes.every(searchAttr => 
          nft.attributes!.some(nftAttr => 
            nftAttr.trait_type === searchAttr.trait_type && 
            nftAttr.value === searchAttr.value
          )
        );
      });

      return Result.ok(matchingNFTs);
    } catch (error) {
      return Result.fail(
        new MetaplexMetadataError(
          'search',
          `Failed to search NFTs by attributes: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Check if a mint is a valid NFT
   */
  async isValidNFT(mint: PublicKeyVO): Promise<Result<boolean, DomainError>> {
    try {
      const nft = await this.metaplex.nfts().findByMint({
        mintAddress: mint.toPublicKey()
      });

      // Check if it has NFT characteristics
      if (!nft) return Result.ok(false);
      
      // NFTs typically have supply of 1 and 0 decimals
      const hasNFTSupply = nft.mint.supply.basisPoints.eq(new (require('bn.js'))(1));
      const hasNFTDecimals = nft.mint.decimals === 0;
      
      return Result.ok(hasNFTSupply && hasNFTDecimals);
    } catch (error) {
      return Result.fail(
        new ValidationError(
          `Failed to validate NFT: ${error instanceof Error ? error.message : String(error)}`,
          'mint',
          mint.toBase58()
        )
      );
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    metadata: any;
    collections: any;
  } {
    return {
      metadata: this.metadataCache.getStats(),
      collections: this.collectionCache.getStats()
    };
  }

  /**
   * Clear caches
   */
  clearCaches(): void {
    this.metadataCache.clear();
    this.collectionCache.clear();
  }

  /**
   * Get adapter configuration and stats
   */
  getAdapterInfo(): {
    connection: string;
    cacheStats: any;
  } {
    return {
      connection: this.connection.rpcEndpoint,
      cacheStats: this.getCacheStats()
    };
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.metadataCache.destroy();
    this.collectionCache.destroy();
  }
}