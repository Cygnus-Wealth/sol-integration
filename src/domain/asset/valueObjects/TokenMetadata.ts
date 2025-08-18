/**
 * TokenMetadata Value Object
 * 
 * Encapsulates token metadata information with validation.
 * Ensures type safety and immutability for token information.
 */

import { ValueObject } from '../../shared/ValueObject';
import { ValidationError } from '../../shared/DomainError';

export interface TokenMetadataData {
  name: string;
  symbol: string;
  decimals: number;
  logoUri?: string;
  description?: string;
  website?: string;
  coingeckoId?: string;
  verified: boolean;
  tags: string[];
  extensions?: Record<string, any>;
}

export class TokenMetadata extends ValueObject<TokenMetadataData> {
  private constructor(data: TokenMetadataData) {
    super(data);
  }

  protected validate(): void {
    const { name, symbol, decimals } = this._value;

    if (!name || name.trim().length === 0) {
      throw new ValidationError('Token name cannot be empty', 'name', name);
    }

    if (name.length > 100) {
      throw new ValidationError('Token name too long (max 100 chars)', 'name', name);
    }

    if (!symbol || symbol.trim().length === 0) {
      throw new ValidationError('Token symbol cannot be empty', 'symbol', symbol);
    }

    if (symbol.length > 20) {
      throw new ValidationError('Token symbol too long (max 20 chars)', 'symbol', symbol);
    }

    if (decimals < 0 || decimals > 30 || !Number.isInteger(decimals)) {
      throw new ValidationError('Invalid decimals (must be 0-30)', 'decimals', decimals);
    }

    if (this._value.logoUri && !this.isValidUrl(this._value.logoUri)) {
      throw new ValidationError('Invalid logo URI format', 'logoUri', this._value.logoUri);
    }

    if (this._value.website && !this.isValidUrl(this._value.website)) {
      throw new ValidationError('Invalid website URL format', 'website', this._value.website);
    }

    if (this._value.description && this._value.description.length > 500) {
      throw new ValidationError('Description too long (max 500 chars)', 'description', this._value.description);
    }

    if (this._value.coingeckoId && !/^[a-z0-9-]+$/.test(this._value.coingeckoId)) {
      throw new ValidationError('Invalid CoinGecko ID format', 'coingeckoId', this._value.coingeckoId);
    }
  }

  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  static create(data: Omit<TokenMetadataData, 'verified' | 'tags'> & { 
    verified?: boolean; 
    tags?: string[]; 
  }): TokenMetadata {
    return new TokenMetadata({
      ...data,
      verified: data.verified ?? false,
      tags: data.tags ?? [],
      name: data.name.trim(),
      symbol: data.symbol.trim().toUpperCase()
    });
  }

  static createBasic(name: string, symbol: string, decimals: number): TokenMetadata {
    return new TokenMetadata({
      name: name.trim(),
      symbol: symbol.trim().toUpperCase(),
      decimals,
      verified: false,
      tags: []
    });
  }

  static createSolMetadata(): TokenMetadata {
    return new TokenMetadata({
      name: 'Solana',
      symbol: 'SOL',
      decimals: 9,
      logoUri: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
      description: 'Solana is a high-performance blockchain supporting builders around the world creating crypto apps that scale today.',
      website: 'https://solana.com',
      coingeckoId: 'solana',
      verified: true,
      tags: ['verified', 'native', 'defi']
    });
  }

  // Getters
  getName(): string {
    return this._value.name;
  }

  getSymbol(): string {
    return this._value.symbol;
  }

  getDecimals(): number {
    return this._value.decimals;
  }

  getLogoUri(): string | undefined {
    return this._value.logoUri;
  }

  getDescription(): string | undefined {
    return this._value.description;
  }

  getWebsite(): string | undefined {
    return this._value.website;
  }

  getCoingeckoId(): string | undefined {
    return this._value.coingeckoId;
  }

  isVerified(): boolean {
    return this._value.verified;
  }

  getTags(): string[] {
    return [...this._value.tags];
  }

  getExtensions(): Record<string, any> | undefined {
    return this._value.extensions ? { ...this._value.extensions } : undefined;
  }

  // Behavioral methods
  withVerification(verified: boolean): TokenMetadata {
    return new TokenMetadata({
      ...this._value,
      verified
    });
  }

  withTag(tag: string): TokenMetadata {
    if (this._value.tags.includes(tag)) {
      return this;
    }
    
    return new TokenMetadata({
      ...this._value,
      tags: [...this._value.tags, tag]
    });
  }

  withoutTag(tag: string): TokenMetadata {
    const filteredTags = this._value.tags.filter(t => t !== tag);
    
    if (filteredTags.length === this._value.tags.length) {
      return this;
    }
    
    return new TokenMetadata({
      ...this._value,
      tags: filteredTags
    });
  }

  withLogoUri(logoUri: string): TokenMetadata {
    return new TokenMetadata({
      ...this._value,
      logoUri
    });
  }

  withExtension(key: string, value: any): TokenMetadata {
    const extensions = this._value.extensions || {};
    
    return new TokenMetadata({
      ...this._value,
      extensions: {
        ...extensions,
        [key]: value
      }
    });
  }

  hasTag(tag: string): boolean {
    return this._value.tags.includes(tag);
  }

  isStablecoin(): boolean {
    return this.hasTag('stablecoin');
  }

  isLiquidityToken(): boolean {
    return this.hasTag('lp') || this.hasTag('liquidity');
  }

  isDeFiToken(): boolean {
    return this.hasTag('defi');
  }

  // Display helpers
  getDisplayName(): string {
    return `${this._value.name} (${this._value.symbol})`;
  }

  getShortDisplay(): string {
    if (this._value.name.length <= 20) {
      return this._value.name;
    }
    return `${this._value.name.substring(0, 17)}...`;
  }

  // Comparison
  isSameToken(other: TokenMetadata): boolean {
    return this._value.symbol === other.getSymbol() && 
           this._value.decimals === other.getDecimals();
  }

  isMoreTrustedThan(other: TokenMetadata): boolean {
    if (this._value.verified && !other.isVerified()) {
      return true;
    }
    
    if (!this._value.verified && other.isVerified()) {
      return false;
    }
    
    // If both verified or both unverified, prefer one with more metadata
    const thisScore = this.getTrustScore();
    const otherScore = other.getTrustScore();
    
    return thisScore > otherScore;
  }

  private getTrustScore(): number {
    let score = 0;
    
    if (this._value.verified) score += 10;
    if (this._value.logoUri) score += 2;
    if (this._value.website) score += 2;
    if (this._value.description) score += 1;
    if (this._value.coingeckoId) score += 3;
    if (this._value.tags.length > 0) score += 1;
    
    return score;
  }

  // Serialization
  toJSON(): TokenMetadataData {
    return {
      ...this._value,
      tags: [...this._value.tags],
      extensions: this._value.extensions ? { ...this._value.extensions } : undefined
    };
  }

  static fromJSON(data: TokenMetadataData): TokenMetadata {
    return new TokenMetadata(data);
  }
}