/**
 * Portfolio Aggregate Root
 * 
 * Manages a collection of Solana assets for a wallet.
 * Enforces portfolio invariants and provides aggregated views.
 */

import { PublicKeyVO } from '../../asset/valueObjects/PublicKeyVO';
import { TokenAmount } from '../../asset/valueObjects/TokenAmount';
import { SolanaAsset } from '../../asset/aggregates/SolanaAsset';
import { NFTAsset } from '../../asset/entities/NFTAsset';
import { ValidationError, InsufficientBalanceError, AssetNotFoundError } from '../../shared/DomainError';
import { AssetType } from '@cygnus-wealth/data-models';

export interface AssetHolding {
  asset: SolanaAsset;
  balance: TokenAmount;
  tokenAccount?: PublicKeyVO;
  lastUpdated: Date;
}

export interface NFTHolding {
  nft: NFTAsset;
  tokenAccount: PublicKeyVO;
  lastUpdated: Date;
}

export interface PortfolioSnapshot {
  totalValueSOL: TokenAmount;
  totalValueUSD?: number;
  assetCount: number;
  nftCount: number;
  diversificationScore: number;
  lastUpdated: Date;
}

export interface PortfolioData {
  id: string;
  walletAddress: PublicKeyVO;
  nativeBalance: TokenAmount;
  assetHoldings: Map<string, AssetHolding>;
  nftHoldings: Map<string, NFTHolding>;
  snapshot: PortfolioSnapshot;
  createdAt: Date;
  lastSyncAt: Date;
}

export class PortfolioAggregate {
  private _data: PortfolioData;
  private _domainEvents: any[] = [];

  private constructor(data: PortfolioData) {
    this._data = data;
    this.validate();
  }

  private validate(): void {
    if (!this._data.walletAddress) {
      throw new ValidationError('Portfolio must have a wallet address', 'walletAddress');
    }

    if (!this._data.nativeBalance) {
      throw new ValidationError('Portfolio must have a native balance', 'nativeBalance');
    }

    // Validate that all holdings have positive balances
    for (const [mintAddress, holding] of this._data.assetHoldings) {
      if (holding.balance.isZero()) {
        throw new ValidationError(
          `Asset holding cannot have zero balance: ${mintAddress}`,
          'assetHolding',
          mintAddress
        );
      }
    }
  }

  static create(walletAddress: string, nativeBalance?: TokenAmount): PortfolioAggregate {
    const walletKey = PublicKeyVO.create(walletAddress);
    const balance = nativeBalance || TokenAmount.zero(9);
    const now = new Date();

    const portfolio = new PortfolioAggregate({
      id: `portfolio-${walletKey.toBase58()}`,
      walletAddress: walletKey,
      nativeBalance: balance,
      assetHoldings: new Map(),
      nftHoldings: new Map(),
      snapshot: {
        totalValueSOL: balance,
        assetCount: 0,
        nftCount: 0,
        diversificationScore: 0,
        lastUpdated: now
      },
      createdAt: now,
      lastSyncAt: now
    });

    portfolio.addDomainEvent({
      type: 'PortfolioCreated',
      portfolioId: portfolio._data.id,
      walletAddress: walletAddress,
      timestamp: now
    });

    return portfolio;
  }

  static fromHoldings(
    walletAddress: string,
    nativeBalance: TokenAmount,
    assetHoldings: AssetHolding[],
    nftHoldings: NFTHolding[]
  ): PortfolioAggregate {
    const portfolio = PortfolioAggregate.create(walletAddress, nativeBalance);
    
    // Add asset holdings
    for (const holding of assetHoldings) {
      portfolio.addAssetHolding(holding.asset, holding.balance, holding.tokenAccount);
    }
    
    // Add NFT holdings
    for (const holding of nftHoldings) {
      portfolio.addNFTHolding(holding.nft, holding.tokenAccount);
    }
    
    portfolio.updateSnapshot();
    return portfolio;
  }

  // Getters
  getId(): string {
    return this._data.id;
  }

  getWalletAddress(): PublicKeyVO {
    return this._data.walletAddress;
  }

  getWalletAddressString(): string {
    return this._data.walletAddress.toBase58();
  }

  getNativeBalance(): TokenAmount {
    return this._data.nativeBalance;
  }

  getAssetHoldings(): AssetHolding[] {
    return Array.from(this._data.assetHoldings.values());
  }

  getNFTHoldings(): NFTHolding[] {
    return Array.from(this._data.nftHoldings.values());
  }

  getSnapshot(): PortfolioSnapshot {
    return { ...this._data.snapshot };
  }

  getLastSyncAt(): Date {
    return this._data.lastSyncAt;
  }

  getTotalAssetCount(): number {
    return this._data.assetHoldings.size;
  }

  getTotalNFTCount(): number {
    return this._data.nftHoldings.size;
  }

  getTotalValueSOL(): TokenAmount {
    return this._data.snapshot.totalValueSOL;
  }

  // Asset management
  addAssetHolding(asset: SolanaAsset, balance: TokenAmount, tokenAccount?: PublicKeyVO): void {
    if (balance.isZero()) {
      throw new ValidationError('Cannot add asset holding with zero balance', 'balance');
    }

    if (asset.isNFT()) {
      throw new ValidationError('Use addNFTHolding for NFT assets', 'assetType');
    }

    const mintAddress = asset.getMintAddress();
    const existing = this._data.assetHoldings.get(mintAddress);

    if (existing) {
      // Update existing holding
      existing.balance = balance;
      existing.tokenAccount = tokenAccount;
      existing.lastUpdated = new Date();
    } else {
      // Add new holding
      this._data.assetHoldings.set(mintAddress, {
        asset,
        balance,
        tokenAccount,
        lastUpdated: new Date()
      });
    }

    this._data.lastSyncAt = new Date();
    this.updateSnapshot();

    this.addDomainEvent({
      type: 'AssetHoldingUpdated',
      portfolioId: this._data.id,
      mintAddress,
      balance: balance.getAmount(),
      timestamp: new Date()
    });
  }

  removeAssetHolding(mintAddress: string): void {
    if (!this._data.assetHoldings.has(mintAddress)) {
      throw new AssetNotFoundError(mintAddress, 'portfolio');
    }

    this._data.assetHoldings.delete(mintAddress);
    this._data.lastSyncAt = new Date();
    this.updateSnapshot();

    this.addDomainEvent({
      type: 'AssetHoldingRemoved',
      portfolioId: this._data.id,
      mintAddress,
      timestamp: new Date()
    });
  }

  updateAssetBalance(mintAddress: string, newBalance: TokenAmount): void {
    const holding = this._data.assetHoldings.get(mintAddress);
    if (!holding) {
      throw new AssetNotFoundError(mintAddress, 'portfolio');
    }

    if (newBalance.isZero()) {
      this.removeAssetHolding(mintAddress);
      return;
    }

    holding.balance = newBalance;
    holding.lastUpdated = new Date();
    this._data.lastSyncAt = new Date();
    this.updateSnapshot();

    this.addDomainEvent({
      type: 'AssetBalanceUpdated',
      portfolioId: this._data.id,
      mintAddress,
      oldBalance: holding.balance.getAmount(),
      newBalance: newBalance.getAmount(),
      timestamp: new Date()
    });
  }

  addNFTHolding(nft: NFTAsset, tokenAccount: PublicKeyVO): void {
    const mintAddress = nft.getMintAddress();
    
    this._data.nftHoldings.set(mintAddress, {
      nft,
      tokenAccount,
      lastUpdated: new Date()
    });

    this._data.lastSyncAt = new Date();
    this.updateSnapshot();

    this.addDomainEvent({
      type: 'NFTHoldingAdded',
      portfolioId: this._data.id,
      mintAddress,
      timestamp: new Date()
    });
  }

  removeNFTHolding(mintAddress: string): void {
    if (!this._data.nftHoldings.has(mintAddress)) {
      throw new AssetNotFoundError(mintAddress, 'portfolio NFTs');
    }

    this._data.nftHoldings.delete(mintAddress);
    this._data.lastSyncAt = new Date();
    this.updateSnapshot();

    this.addDomainEvent({
      type: 'NFTHoldingRemoved',
      portfolioId: this._data.id,
      mintAddress,
      timestamp: new Date()
    });
  }

  updateNativeBalance(newBalance: TokenAmount): void {
    const oldBalance = this._data.nativeBalance;
    this._data.nativeBalance = newBalance;
    this._data.lastSyncAt = new Date();
    this.updateSnapshot();

    this.addDomainEvent({
      type: 'NativeBalanceUpdated',
      portfolioId: this._data.id,
      oldBalance: oldBalance.getAmount(),
      newBalance: newBalance.getAmount(),
      timestamp: new Date()
    });
  }

  // Query methods
  hasAsset(mintAddress: string): boolean {
    return this._data.assetHoldings.has(mintAddress);
  }

  hasNFT(mintAddress: string): boolean {
    return this._data.nftHoldings.has(mintAddress);
  }

  getAssetHolding(mintAddress: string): AssetHolding | undefined {
    return this._data.assetHoldings.get(mintAddress);
  }

  getNFTHolding(mintAddress: string): NFTHolding | undefined {
    return this._data.nftHoldings.get(mintAddress);
  }

  getAssetBalance(mintAddress: string): TokenAmount {
    const holding = this._data.assetHoldings.get(mintAddress);
    if (!holding) {
      throw new AssetNotFoundError(mintAddress, 'portfolio');
    }
    return holding.balance;
  }

  getHoldingsBySymbol(symbol: string): AssetHolding[] {
    return Array.from(this._data.assetHoldings.values()).filter(
      holding => holding.asset.getSymbol().toLowerCase() === symbol.toLowerCase()
    );
  }

  getVerifiedAssets(): AssetHolding[] {
    return Array.from(this._data.assetHoldings.values()).filter(
      holding => holding.asset.isVerified()
    );
  }

  getVerifiedNFTs(): NFTHolding[] {
    return Array.from(this._data.nftHoldings.values()).filter(
      holding => holding.nft.isVerified()
    );
  }

  getLargestHoldings(count: number = 10): AssetHolding[] {
    return Array.from(this._data.assetHoldings.values())
      .sort((a, b) => {
        // For sorting, we'll use UI amount as a proxy
        const aValue = a.balance.getUIAmount();
        const bValue = b.balance.getUIAmount();
        return bValue - aValue;
      })
      .slice(0, count);
  }

  // Portfolio analysis
  calculateDiversificationScore(): number {
    const totalHoldings = this._data.assetHoldings.size + this._data.nftHoldings.size;
    
    if (totalHoldings === 0) return 0;
    if (totalHoldings === 1) return 10;
    if (totalHoldings <= 5) return 30;
    if (totalHoldings <= 10) return 60;
    if (totalHoldings <= 20) return 80;
    
    return 100;
  }

  calculateAssetAllocation(): Map<AssetType, number> {
    const allocation = new Map<AssetType, number>();
    let totalCount = 0;

    // Count asset types
    for (const holding of this._data.assetHoldings.values()) {
      const type = holding.asset.getType();
      allocation.set(type, (allocation.get(type) || 0) + 1);
      totalCount++;
    }

    // Count NFTs
    if (this._data.nftHoldings.size > 0) {
      allocation.set(AssetType.NFT, this._data.nftHoldings.size);
      totalCount += this._data.nftHoldings.size;
    }

    // Convert to percentages
    const percentageAllocation = new Map<AssetType, number>();
    for (const [type, count] of allocation) {
      percentageAllocation.set(type, (count / totalCount) * 100);
    }

    return percentageAllocation;
  }

  getStaleHoldings(maxAge: number = 24 * 60 * 60 * 1000): (AssetHolding | NFTHolding)[] {
    const cutoff = new Date(Date.now() - maxAge);
    const staleHoldings: (AssetHolding | NFTHolding)[] = [];

    for (const holding of this._data.assetHoldings.values()) {
      if (holding.lastUpdated < cutoff) {
        staleHoldings.push(holding);
      }
    }

    for (const holding of this._data.nftHoldings.values()) {
      if (holding.lastUpdated < cutoff) {
        staleHoldings.push(holding);
      }
    }

    return staleHoldings;
  }

  // Portfolio operations
  canSpend(mintAddress: string, amount: TokenAmount): boolean {
    const holding = this._data.assetHoldings.get(mintAddress);
    if (!holding) return false;
    
    return holding.balance.compareTo(amount) >= 0;
  }

  simulateSpend(mintAddress: string, amount: TokenAmount): TokenAmount {
    const holding = this._data.assetHoldings.get(mintAddress);
    if (!holding) {
      throw new AssetNotFoundError(mintAddress, 'portfolio');
    }

    if (!this.canSpend(mintAddress, amount)) {
      throw new InsufficientBalanceError(
        amount.getAmount(),
        holding.balance.getAmount(),
        holding.asset.getSymbol()
      );
    }

    return holding.balance.subtract(amount);
  }

  // Maintenance
  private updateSnapshot(): void {
    this._data.snapshot = {
      totalValueSOL: this.calculateTotalSOLValue(),
      assetCount: this._data.assetHoldings.size,
      nftCount: this._data.nftHoldings.size,
      diversificationScore: this.calculateDiversificationScore(),
      lastUpdated: new Date()
    };
  }

  private calculateTotalSOLValue(): TokenAmount {
    // For now, we only include native SOL balance
    // In a real implementation, this would convert all token values to SOL equivalent
    return this._data.nativeBalance;
  }

  markAsSynced(): void {
    this._data.lastSyncAt = new Date();
    
    this.addDomainEvent({
      type: 'PortfolioSynced',
      portfolioId: this._data.id,
      assetCount: this._data.assetHoldings.size,
      nftCount: this._data.nftHoldings.size,
      timestamp: new Date()
    });
  }

  clear(): void {
    this._data.assetHoldings.clear();
    this._data.nftHoldings.clear();
    this._data.nativeBalance = TokenAmount.zero(9);
    this.updateSnapshot();
    
    this.addDomainEvent({
      type: 'PortfolioCleared',
      portfolioId: this._data.id,
      timestamp: new Date()
    });
  }

  // Bulk operations
  bulkUpdateAssetBalances(updates: Map<string, TokenAmount>): void {
    const affectedAssets: string[] = [];
    
    for (const [mintAddress, balance] of updates) {
      if (balance.isZero()) {
        if (this._data.assetHoldings.has(mintAddress)) {
          this.removeAssetHolding(mintAddress);
          affectedAssets.push(mintAddress);
        }
      } else {
        if (this._data.assetHoldings.has(mintAddress)) {
          this.updateAssetBalance(mintAddress, balance);
          affectedAssets.push(mintAddress);
        }
      }
    }

    if (affectedAssets.length > 0) {
      this.addDomainEvent({
        type: 'PortfolioBulkUpdated',
        portfolioId: this._data.id,
        affectedAssets,
        timestamp: new Date()
      });
    }
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
  equals(other: PortfolioAggregate): boolean {
    if (!other) return false;
    return this._data.id === other.getId() &&
           this._data.walletAddress.equals(other.getWalletAddress());
  }

  // Serialization
  toJSON(): any {
    return {
      id: this._data.id,
      walletAddress: this._data.walletAddress.toBase58(),
      nativeBalance: this._data.nativeBalance.getAmount(),
      assetHoldings: Array.from(this._data.assetHoldings.entries()).map(([mint, holding]) => ({
        mint,
        asset: holding.asset.toJSON(),
        balance: holding.balance.getAmount(),
        tokenAccount: holding.tokenAccount?.toBase58(),
        lastUpdated: holding.lastUpdated.toISOString()
      })),
      nftHoldings: Array.from(this._data.nftHoldings.entries()).map(([mint, holding]) => ({
        mint,
        nft: holding.nft.toJSON(),
        tokenAccount: holding.tokenAccount.toBase58(),
        lastUpdated: holding.lastUpdated.toISOString()
      })),
      snapshot: {
        ...this._data.snapshot,
        totalValueSOL: this._data.snapshot.totalValueSOL.getAmount(),
        lastUpdated: this._data.snapshot.lastUpdated.toISOString()
      },
      createdAt: this._data.createdAt.toISOString(),
      lastSyncAt: this._data.lastSyncAt.toISOString()
    };
  }
}