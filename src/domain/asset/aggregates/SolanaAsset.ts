/**
 * SolanaAsset Aggregate Root
 * 
 * Central aggregate for managing Solana asset information.
 * Coordinates asset state, metadata, and balance tracking.
 */

import { PublicKeyVO } from '../valueObjects/PublicKeyVO';
import { TokenAmount } from '../valueObjects/TokenAmount';
import { TokenMetadata } from '../valueObjects/TokenMetadata';
import { AssetType } from '@cygnus-wealth/data-models';

export interface AssetMetadata {
  name: string;
  symbol: string;
  decimals: number;
  logoUri?: string;
  coingeckoId?: string;
  website?: string;
  description?: string;
  verified?: boolean;
}

export interface SolanaAssetData {
  id: string;
  mint: PublicKeyVO;
  type: AssetType;
  metadata: AssetMetadata;
  supply?: TokenAmount;
  holders?: number;
  freezeAuthority?: PublicKeyVO;
  mintAuthority?: PublicKeyVO;
  lastUpdated: Date;
}

export class SolanaAsset {
  private _data: SolanaAssetData;
  private _domainEvents: any[] = [];

  private constructor(data: SolanaAssetData) {
    this._data = data;
  }

  static createNative(): SolanaAsset {
    const nativeMint = PublicKeyVO.create('So11111111111111111111111111111111111111112');
    
    return new SolanaAsset({
      id: 'sol-native',
      mint: nativeMint,
      type: AssetType.CRYPTOCURRENCY,
      metadata: {
        name: 'Solana',
        symbol: 'SOL',
        decimals: 9,
        logoUri: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
        coingeckoId: 'solana',
        verified: true
      },
      lastUpdated: new Date()
    });
  }

  static createToken(
    mint: string,
    metadata: AssetMetadata,
    supply?: string,
    decimals?: number
  ): SolanaAsset {
    const mintKey = PublicKeyVO.create(mint);
    const tokenSupply = supply 
      ? TokenAmount.fromTokenUnits(supply, decimals || metadata.decimals)
      : undefined;

    return new SolanaAsset({
      id: `spl-${mint}`,
      mint: mintKey,
      type: AssetType.CRYPTOCURRENCY,
      metadata: {
        ...metadata,
        decimals: decimals || metadata.decimals
      },
      supply: tokenSupply,
      lastUpdated: new Date()
    });
  }

  static fromTokenMetadata(
    mint: string,
    tokenMetadata: TokenMetadata,
    supply?: string
  ): SolanaAsset {
    const mintKey = PublicKeyVO.create(mint);
    const metadata = tokenMetadata.getValue();
    const tokenSupply = supply 
      ? TokenAmount.fromTokenUnits(supply, metadata.decimals)
      : undefined;

    return new SolanaAsset({
      id: `spl-${mint}`,
      mint: mintKey,
      type: AssetType.CRYPTOCURRENCY,
      metadata: {
        name: metadata.name,
        symbol: metadata.symbol,
        decimals: metadata.decimals,
        logoUri: metadata.logoUri,
        description: metadata.description,
        website: metadata.website,
        coingeckoId: metadata.coingeckoId,
        verified: metadata.verified
      },
      supply: tokenSupply,
      lastUpdated: new Date()
    });
  }

  static createNFT(
    mint: string,
    metadata: AssetMetadata,
    collection?: string
  ): SolanaAsset {
    const mintKey = PublicKeyVO.create(mint);

    return new SolanaAsset({
      id: `nft-${mint}`,
      mint: mintKey,
      type: AssetType.NFT,
      metadata: {
        ...metadata,
        decimals: 0 // NFTs have no decimals
      },
      supply: TokenAmount.fromTokenUnits('1', 0), // NFTs have supply of 1
      lastUpdated: new Date()
    });
  }

  // Getters
  getId(): string {
    return this._data.id;
  }

  getMint(): PublicKeyVO {
    return this._data.mint;
  }

  getMintAddress(): string {
    return this._data.mint.toBase58();
  }

  getType(): AssetType {
    return this._data.type;
  }

  getMetadata(): AssetMetadata {
    return { ...this._data.metadata };
  }

  getSymbol(): string {
    return this._data.metadata.symbol;
  }

  getName(): string {
    return this._data.metadata.name;
  }

  getDecimals(): number {
    return this._data.metadata.decimals;
  }

  getSupply(): TokenAmount | undefined {
    return this._data.supply;
  }

  getLastUpdated(): Date {
    return this._data.lastUpdated;
  }

  getFreezeAuthority(): PublicKeyVO | undefined {
    return this._data.freezeAuthority;
  }

  getMintAuthority(): PublicKeyVO | undefined {
    return this._data.mintAuthority;
  }

  getHolders(): number | undefined {
    return this._data.holders;
  }

  // Behavioral methods
  updateMetadata(metadata: Partial<AssetMetadata>): void {
    this._data.metadata = {
      ...this._data.metadata,
      ...metadata
    };
    this._data.lastUpdated = new Date();
    
    this.addDomainEvent({
      type: 'MetadataUpdated',
      assetId: this._data.id,
      metadata,
      timestamp: new Date()
    });
  }

  updateSupply(supply: TokenAmount): void {
    if (this._data.type === AssetType.NFT) {
      throw new Error('Cannot update supply for NFT');
    }
    
    this._data.supply = supply;
    this._data.lastUpdated = new Date();
    
    this.addDomainEvent({
      type: 'SupplyUpdated',
      assetId: this._data.id,
      supply: supply.getAmount(),
      timestamp: new Date()
    });
  }

  markAsVerified(): void {
    this._data.metadata.verified = true;
    this._data.lastUpdated = new Date();
    
    this.addDomainEvent({
      type: 'AssetVerified',
      assetId: this._data.id,
      timestamp: new Date()
    });
  }

  isNative(): boolean {
    return this._data.mint.toBase58() === 'So11111111111111111111111111111111111111112';
  }

  isToken(): boolean {
    return this._data.type === AssetType.CRYPTOCURRENCY;
  }

  isNFT(): boolean {
    return this._data.type === AssetType.NFT;
  }

  isVerified(): boolean {
    return this._data.metadata.verified === true;
  }

  hasLogo(): boolean {
    return !!this._data.metadata.logoUri;
  }

  hasWebsite(): boolean {
    return !!this._data.metadata.website;
  }

  hasCoingeckoId(): boolean {
    return !!this._data.metadata.coingeckoId;
  }

  isFrozen(): boolean {
    return !!this._data.freezeAuthority;
  }

  isMintable(): boolean {
    return !!this._data.mintAuthority;
  }

  canFreeze(): boolean {
    return this.isFrozen() && !this.isNative();
  }

  canMint(): boolean {
    return this.isMintable() && !this.isNative() && !this.isNFT();
  }

  toTokenMetadata(): TokenMetadata {
    return TokenMetadata.create({
      name: this._data.metadata.name,
      symbol: this._data.metadata.symbol,
      decimals: this._data.metadata.decimals,
      logoUri: this._data.metadata.logoUri,
      description: this._data.metadata.description,
      website: this._data.metadata.website,
      coingeckoId: this._data.metadata.coingeckoId,
      verified: this._data.metadata.verified || false,
      tags: this.generateTags()
    });
  }

  private generateTags(): string[] {
    const tags: string[] = [];
    
    if (this.isNative()) tags.push('native');
    if (this.isToken()) tags.push('token');
    if (this.isNFT()) tags.push('nft');
    if (this.isVerified()) tags.push('verified');
    if (this.hasCoingeckoId()) tags.push('tracked');
    if (this.isFrozen()) tags.push('freezable');
    if (this.isMintable()) tags.push('mintable');
    
    return tags;
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
  equals(other: SolanaAsset): boolean {
    if (!other) return false;
    return this._data.id === other.getId() && 
           this._data.mint.equals(other.getMint());
  }

  // Serialization
  toJSON(): any {
    return {
      id: this._data.id,
      mint: this._data.mint.toBase58(),
      type: this._data.type,
      metadata: this._data.metadata,
      supply: this._data.supply?.getAmount(),
      lastUpdated: this._data.lastUpdated.toISOString()
    };
  }
}