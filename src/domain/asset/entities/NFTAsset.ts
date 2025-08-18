/**
 * NFTAsset Entity
 * 
 * Specialized entity for Non-Fungible Tokens with Metaplex metadata.
 * Extends basic asset functionality with NFT-specific behaviors.
 */

import { PublicKeyVO } from '../valueObjects/PublicKeyVO';
import { TokenAmount } from '../valueObjects/TokenAmount';
import { TokenMetadata } from '../valueObjects/TokenMetadata';
import { SolanaAsset } from '../aggregates/SolanaAsset';
import { ValidationError, NFTParseError } from '../../shared/DomainError';
import { AssetType } from '@cygnus-wealth/data-models';

export interface NFTMetaplexMetadata {
  name: string;
  symbol: string;
  description?: string;
  image?: string;
  external_url?: string;
  animation_url?: string;
  attributes?: NFTAttribute[];
  properties?: {
    files?: Array<{
      uri: string;
      type: string;
    }>;
    category?: string;
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
}

export interface NFTAttribute {
  trait_type: string;
  value: string | number;
  display_type?: 'string' | 'number' | 'boost_number' | 'boost_percentage' | 'date';
}

export interface NFTRarity {
  rank?: number;
  score?: number;
  total_supply?: number;
  rarity_tier?: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';
}

export interface NFTOwnership {
  current_owner: PublicKeyVO;
  previous_owners?: PublicKeyVO[];
  transfer_history?: Array<{
    from: PublicKeyVO;
    to: PublicKeyVO;
    timestamp: Date;
    transaction_signature: string;
  }>;
}

export interface NFTMarketData {
  floor_price?: TokenAmount;
  last_sale_price?: TokenAmount;
  marketplace?: string;
  listed_price?: TokenAmount;
  listing_timestamp?: Date;
  volume_24h?: TokenAmount;
}

export interface NFTAssetData {
  mint: PublicKeyVO;
  metadata: NFTMetaplexMetadata;
  metadataAccount?: PublicKeyVO;
  masterEdition?: PublicKeyVO;
  collection?: PublicKeyVO;
  collectionMetadata?: NFTMetaplexMetadata;
  rarity?: NFTRarity;
  ownership: NFTOwnership;
  marketData?: NFTMarketData;
  isMutable: boolean;
  isPrimarySaleHappened: boolean;
  updateAuthority?: PublicKeyVO;
  lastVerified: Date;
  lastUpdated: Date;
}

export class NFTAsset {
  private _data: NFTAssetData;
  private _domainEvents: any[] = [];

  private constructor(data: NFTAssetData) {
    this._data = data;
    this.validate();
  }

  private validate(): void {
    if (!this._data.mint) {
      throw new ValidationError('NFT mint address is required', 'mint');
    }

    if (!this._data.metadata.name || this._data.metadata.name.trim().length === 0) {
      throw new ValidationError('NFT name is required', 'name');
    }

    if (!this._data.ownership.current_owner) {
      throw new ValidationError('NFT must have a current owner', 'current_owner');
    }

    // Validate attributes format
    if (this._data.metadata.attributes) {
      for (const attr of this._data.metadata.attributes) {
        if (!attr.trait_type || attr.value === undefined) {
          throw new ValidationError('Invalid NFT attribute format', 'attributes', attr);
        }
      }
    }

    // Validate creators if present
    if (this._data.metadata.properties?.creators) {
      const totalShare = this._data.metadata.properties.creators.reduce(
        (sum, creator) => sum + creator.share,
        0
      );
      if (totalShare !== 100) {
        throw new ValidationError('Creator shares must sum to 100', 'creators', totalShare);
      }
    }
  }

  static create(data: Omit<NFTAssetData, 'lastVerified' | 'lastUpdated'>): NFTAsset {
    return new NFTAsset({
      ...data,
      lastVerified: new Date(),
      lastUpdated: new Date()
    });
  }

  static fromMetaplexMetadata(
    mint: string,
    metadata: NFTMetaplexMetadata,
    owner: string,
    metadataAccount?: string,
    masterEdition?: string
  ): NFTAsset {
    try {
      const mintKey = PublicKeyVO.create(mint);
      const ownerKey = PublicKeyVO.create(owner);
      const metadataKey = metadataAccount ? PublicKeyVO.create(metadataAccount) : undefined;
      const masterEditionKey = masterEdition ? PublicKeyVO.create(masterEdition) : undefined;

      return new NFTAsset({
        mint: mintKey,
        metadata,
        metadataAccount: metadataKey,
        masterEdition: masterEditionKey,
        ownership: {
          current_owner: ownerKey
        },
        isMutable: true,
        isPrimarySaleHappened: false,
        lastVerified: new Date(),
        lastUpdated: new Date()
      });
    } catch (error) {
      throw new NFTParseError(mint, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  // Convert to SolanaAsset for portfolio integration
  toSolanaAsset(): SolanaAsset {
    const tokenMetadata = TokenMetadata.create({
      name: this._data.metadata.name,
      symbol: this._data.metadata.symbol || 'NFT',
      decimals: 0,
      logoUri: this._data.metadata.image,
      description: this._data.metadata.description,
      website: this._data.metadata.external_url,
      verified: this.isVerified(),
      tags: this.generateTags()
    });

    return SolanaAsset.createNFT(
      this._data.mint.toBase58(),
      tokenMetadata.getValue(),
      this._data.collection?.toBase58()
    );
  }

  private generateTags(): string[] {
    const tags = ['nft'];
    
    if (this.isVerified()) tags.push('verified');
    if (this.isPartOfCollection()) tags.push('collection');
    if (this.hasRarity()) tags.push('rare');
    if (this.isListed()) tags.push('listed');
    if (this._data.metadata.properties?.category) {
      tags.push(this._data.metadata.properties.category.toLowerCase());
    }
    
    return tags;
  }

  // Getters
  getMint(): PublicKeyVO {
    return this._data.mint;
  }

  getMintAddress(): string {
    return this._data.mint.toBase58();
  }

  getMetadata(): NFTMetaplexMetadata {
    return { ...this._data.metadata };
  }

  getName(): string {
    return this._data.metadata.name;
  }

  getSymbol(): string {
    return this._data.metadata.symbol || 'NFT';
  }

  getDescription(): string | undefined {
    return this._data.metadata.description;
  }

  getImage(): string | undefined {
    return this._data.metadata.image;
  }

  getAnimationUrl(): string | undefined {
    return this._data.metadata.animation_url;
  }

  getExternalUrl(): string | undefined {
    return this._data.metadata.external_url;
  }

  getAttributes(): NFTAttribute[] {
    return this._data.metadata.attributes ? [...this._data.metadata.attributes] : [];
  }

  getCreators(): Array<{ address: string; verified: boolean; share: number }> {
    return this._data.metadata.properties?.creators ? [...this._data.metadata.properties.creators] : [];
  }

  getCollection(): PublicKeyVO | undefined {
    return this._data.collection;
  }

  getCollectionMetadata(): NFTMetaplexMetadata | undefined {
    return this._data.collectionMetadata ? { ...this._data.collectionMetadata } : undefined;
  }

  getCurrentOwner(): PublicKeyVO {
    return this._data.ownership.current_owner;
  }

  getRarity(): NFTRarity | undefined {
    return this._data.rarity ? { ...this._data.rarity } : undefined;
  }

  getMarketData(): NFTMarketData | undefined {
    return this._data.marketData ? { ...this._data.marketData } : undefined;
  }

  getUpdateAuthority(): PublicKeyVO | undefined {
    return this._data.updateAuthority;
  }

  getLastUpdated(): Date {
    return this._data.lastUpdated;
  }

  // Behavioral methods
  updateOwnership(newOwner: PublicKeyVO, transactionSignature?: string): void {
    const previousOwner = this._data.ownership.current_owner;
    
    this._data.ownership = {
      current_owner: newOwner,
      previous_owners: [
        ...(this._data.ownership.previous_owners || []),
        previousOwner
      ].slice(-10), // Keep last 10 owners
      transfer_history: [
        ...(this._data.ownership.transfer_history || []),
        {
          from: previousOwner,
          to: newOwner,
          timestamp: new Date(),
          transaction_signature: transactionSignature || ''
        }
      ].slice(-50) // Keep last 50 transfers
    };

    this._data.lastUpdated = new Date();
    
    this.addDomainEvent({
      type: 'NFTOwnershipTransferred',
      mint: this._data.mint.toBase58(),
      from: previousOwner.toBase58(),
      to: newOwner.toBase58(),
      timestamp: new Date()
    });
  }

  updateMetadata(metadata: Partial<NFTMetaplexMetadata>): void {
    if (!this._data.isMutable) {
      throw new ValidationError('Cannot update immutable NFT metadata', 'mutable');
    }

    this._data.metadata = {
      ...this._data.metadata,
      ...metadata
    };
    this._data.lastUpdated = new Date();
    
    this.addDomainEvent({
      type: 'NFTMetadataUpdated',
      mint: this._data.mint.toBase58(),
      changes: metadata,
      timestamp: new Date()
    });
  }

  updateRarity(rarity: NFTRarity): void {
    this._data.rarity = rarity;
    this._data.lastUpdated = new Date();
    
    this.addDomainEvent({
      type: 'NFTRarityUpdated',
      mint: this._data.mint.toBase58(),
      rarity,
      timestamp: new Date()
    });
  }

  updateMarketData(marketData: NFTMarketData): void {
    this._data.marketData = marketData;
    this._data.lastUpdated = new Date();
    
    this.addDomainEvent({
      type: 'NFTMarketDataUpdated',
      mint: this._data.mint.toBase58(),
      marketData,
      timestamp: new Date()
    });
  }

  markAsVerified(): void {
    this._data.lastVerified = new Date();
    
    this.addDomainEvent({
      type: 'NFTVerified',
      mint: this._data.mint.toBase58(),
      timestamp: new Date()
    });
  }

  // Query methods
  isVerified(): boolean {
    return this._data.metadata.collection?.verified === true ||
           this.getCreators().some(creator => creator.verified);
  }

  isPartOfCollection(): boolean {
    return !!this._data.collection;
  }

  hasRarity(): boolean {
    return !!this._data.rarity;
  }

  isListed(): boolean {
    return !!this._data.marketData?.listed_price;
  }

  isMutable(): boolean {
    return this._data.isMutable;
  }

  isPrimarySaleCompleted(): boolean {
    return this._data.isPrimarySaleHappened;
  }

  hasAnimatedContent(): boolean {
    return !!this._data.metadata.animation_url;
  }

  getAttributeValue(traitType: string): string | number | undefined {
    const attribute = this._data.metadata.attributes?.find(
      attr => attr.trait_type.toLowerCase() === traitType.toLowerCase()
    );
    return attribute?.value;
  }

  hasAttribute(traitType: string, value?: string | number): boolean {
    const attribute = this._data.metadata.attributes?.find(
      attr => attr.trait_type.toLowerCase() === traitType.toLowerCase()
    );
    
    if (!attribute) return false;
    if (value === undefined) return true;
    
    return attribute.value === value;
  }

  getRarityRank(): number | undefined {
    return this._data.rarity?.rank;
  }

  getRarityScore(): number | undefined {
    return this._data.rarity?.score;
  }

  getRarityTier(): string | undefined {
    return this._data.rarity?.rarity_tier;
  }

  getFloorPrice(): TokenAmount | undefined {
    return this._data.marketData?.floor_price;
  }

  getLastSalePrice(): TokenAmount | undefined {
    return this._data.marketData?.last_sale_price;
  }

  // Domain events
  private addDomainEvent(event: any): void {
    this._domainEvents.push(event);
  }

  getDomainEvents(): any[] {
    return [...this._domainEvents];
  }

  clearDomainEvents(): void {
    this._domainEvents = [];
  }

  // Equality
  equals(other: NFTAsset): boolean {
    if (!other) return false;
    return this._data.mint.equals(other.getMint());
  }

  // Serialization
  toJSON(): any {
    return {
      mint: this._data.mint.toBase58(),
      metadata: this._data.metadata,
      metadataAccount: this._data.metadataAccount?.toBase58(),
      masterEdition: this._data.masterEdition?.toBase58(),
      collection: this._data.collection?.toBase58(),
      collectionMetadata: this._data.collectionMetadata,
      rarity: this._data.rarity,
      ownership: {
        current_owner: this._data.ownership.current_owner.toBase58(),
        previous_owners: this._data.ownership.previous_owners?.map(owner => owner.toBase58()),
        transfer_history: this._data.ownership.transfer_history?.map(transfer => ({
          ...transfer,
          from: transfer.from.toBase58(),
          to: transfer.to.toBase58(),
          timestamp: transfer.timestamp.toISOString()
        }))
      },
      marketData: this._data.marketData,
      isMutable: this._data.isMutable,
      isPrimarySaleHappened: this._data.isPrimarySaleHappened,
      updateAuthority: this._data.updateAuthority?.toBase58(),
      lastVerified: this._data.lastVerified.toISOString(),
      lastUpdated: this._data.lastUpdated.toISOString()
    };
  }
}