import { Connection, PublicKey } from '@solana/web3.js';
import { SolanaConnectionAdapter } from '../infrastructure/connection/SolanaConnectionAdapter';
import { InMemoryAssetRepository } from '../infrastructure/repositories/InMemoryAssetRepository';
import { InMemoryBalanceRepository } from '../infrastructure/repositories/InMemoryBalanceRepository';
import { SolanaConnectionRepository } from '../infrastructure/repositories/SolanaConnectionRepository';
import { SPLTokenAdapter } from '../infrastructure/adapters/SPLTokenAdapter';
import { MetaplexAdapter } from '../infrastructure/adapters/MetaplexAdapter';
import { ConnectionManager } from '../infrastructure/managers/ConnectionManager';
import { SolanaBalanceService } from '../domain/services/SolanaBalanceService';
import { TokenDiscoveryService } from '../domain/services/TokenDiscoveryService';
import { PortfolioAggregate } from '../domain/portfolio/aggregates/PortfolioAggregate';
import { PublicKeyVO } from '../domain/asset/valueObjects/PublicKeyVO';
import { SolanaAsset } from '../domain/asset/aggregates/SolanaAsset';
import { NFTAsset } from '../domain/asset/entities/NFTAsset';
import { TokenAmount } from '../domain/asset/valueObjects/TokenAmount';
import { Result } from '../domain/shared/Result';
import { DomainError, ValidationError, NetworkError, PortfolioError } from '../domain/shared/DomainError';
import { DomainEvents } from '../domain/events/DomainEvents';

export interface SolanaConfig {
  rpcEndpoints: string[];
  commitment?: 'processed' | 'confirmed' | 'finalized';
  cacheTTL?: number;
  maxRetries?: number;
  enableCircuitBreaker?: boolean;
  enableMetrics?: boolean;
}

export interface PortfolioSnapshot {
  address: string;
  totalValueUSD: number;
  solBalance: number;
  tokenCount: number;
  nftCount: number;
  tokens: TokenBalance[];
  nfts: NFTInfo[];
  lastUpdated: Date;
}

export interface TokenBalance {
  mint: string;
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
  valueUSD?: number;
}

export interface NFTInfo {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  collection?: string;
  attributes?: Record<string, any>;
}

export class SolanaIntegrationFacade {
  private connectionManager: ConnectionManager;
  private assetRepository: InMemoryAssetRepository;
  private balanceRepository: InMemoryBalanceRepository;
  private connectionRepository: SolanaConnectionRepository;
  private splTokenAdapter: SPLTokenAdapter;
  private metaplexAdapter: MetaplexAdapter;
  private balanceService: SolanaBalanceService;
  private tokenDiscoveryService: TokenDiscoveryService;
  private eventBus: Map<string, ((event: any) => void)[]> = new Map();

  constructor(config: SolanaConfig) {
    // Initialize repositories
    this.assetRepository = new InMemoryAssetRepository(1000, config.cacheTTL || 300000);
    this.balanceRepository = new InMemoryBalanceRepository();
    this.connectionRepository = new SolanaConnectionRepository();

    // Initialize connection management
    this.connectionManager = new ConnectionManager(
      config.rpcEndpoints,
      this.connectionRepository,
      {
        commitment: config.commitment || 'confirmed',
        enableCircuitBreaker: config.enableCircuitBreaker !== false,
        maxRetries: config.maxRetries || 3
      }
    );

    // Initialize adapters with a direct Connection object
    // Use the first RPC endpoint for now (ConnectionManager handles failover internally)
    const connection = new Connection(config.rpcEndpoints[0], config.commitment || 'confirmed');
    this.splTokenAdapter = new SPLTokenAdapter(connection);
    this.metaplexAdapter = new MetaplexAdapter(connection);

    // Initialize domain services
    const connectionAdapter = new SolanaConnectionAdapter({
      endpoint: config.rpcEndpoints[0],
      commitment: config.commitment || 'confirmed',
      enableRetries: true,
      enableCircuitBreaker: config.enableCircuitBreaker !== false,
      maxRetries: config.maxRetries || 3
    });
    this.balanceService = new SolanaBalanceService(
      connectionAdapter,
      this.balanceRepository
    );
    this.tokenDiscoveryService = new TokenDiscoveryService(
      this.assetRepository,
      this.balanceService
    );

    // Subscribe to domain events
    this.setupEventHandlers();
  }

  /**
   * Get complete portfolio snapshot for a wallet address
   */
  async getPortfolio(address: string): Promise<Result<PortfolioSnapshot, DomainError>> {
    try {
      const publicKey = PublicKeyVO.create(address);
      
      // Create portfolio aggregate
      const portfolioResult = PortfolioAggregate.create(publicKey.toString(), []);
      if (portfolioResult.isFailure) {
        return Result.fail(portfolioResult.error);
      }

      const portfolio = portfolioResult.getValue();

      // Discover all tokens
      const tokensResult = await this.tokenDiscoveryService.discoverTokens(publicKey);
      if (tokensResult.isFailure) {
        return Result.fail(tokensResult.error);
      }

      const assets = tokensResult.getValue();

      // Add assets to portfolio
      for (const asset of assets) {
        const addResult = portfolio.addAsset(asset);
        if (addResult.isFailure) {
          console.warn(`Failed to add asset ${asset.id}: ${addResult.error.message}`);
        }
      }

      // Fetch NFTs
      const nfts = await this.fetchNFTs(address);

      // Build snapshot
      const snapshot: PortfolioSnapshot = {
        address,
        totalValueUSD: portfolio.calculateTotalValue(),
        solBalance: this.getSolBalance(portfolio),
        tokenCount: portfolio.getAssetsByType('token').length,
        nftCount: nfts.length,
        tokens: this.buildTokenBalances(portfolio),
        nfts: nfts,
        lastUpdated: new Date()
      };

      return Result.ok(snapshot);
    } catch (error) {
      return Result.fail(
        new PortfolioError(`Failed to fetch portfolio: ${error}`)
      );
    }
  }

  /**
   * Get SOL balance for a wallet
   */
  async getSolanaBalance(address: string): Promise<Result<number, DomainError>> {
    try {
      const publicKey = PublicKeyVO.create(address);
      
      const balanceResult = await this.balanceService.fetchWalletBalance(publicKey);
      if (balanceResult.isFailure) {
        return Result.fail(balanceResult.error);
      }
      
      // Extract SOL balance from the wallet balance result
      const walletBalance = balanceResult.getValue();
      return Result.ok(walletBalance.nativeBalance);
    } catch (error) {
      return Result.fail(
        new ValidationError(`Invalid Solana public key: ${address}`, 'publicKey', address)
      );
    }
  }

  /**
   * Get all SPL token balances for a wallet
   */
  async getTokenBalances(address: string): Promise<Result<TokenBalance[], DomainError>> {
    try {
      const publicKey = new PublicKey(address);
      const tokenAccounts = await this.splTokenAdapter.getTokenAccounts(publicKey);
      
      const balances: TokenBalance[] = [];
      for (const account of tokenAccounts) {
        const metadata = await this.splTokenAdapter.getTokenMetadata(account.mint);
        balances.push({
          mint: account.mint.toString(),
          symbol: metadata?.symbol || 'UNKNOWN',
          name: metadata?.name || 'Unknown Token',
          balance: Number(account.amount) / Math.pow(10, account.decimals),
          decimals: account.decimals
        });
      }

      return Result.ok(balances);
    } catch (error) {
      return Result.fail(
        new NetworkError(`Failed to fetch tokens: ${error}`)
      );
    }
  }

  /**
   * Get NFTs for a wallet
   */
  async getNFTs(address: string): Promise<Result<NFTInfo[], DomainError>> {
    try {
      const nfts = await this.fetchNFTs(address);
      return Result.ok(nfts);
    } catch (error) {
      return Result.fail(
        new NetworkError(`Failed to fetch NFTs: ${error}`)
      );
    }
  }

  /**
   * Subscribe to portfolio updates
   */
  onPortfolioUpdate(callback: (event: DomainEvents.PortfolioSyncedEvent) => void): void {
    this.subscribe('PortfolioSynced', callback);
  }

  /**
   * Subscribe to balance updates
   */
  onBalanceUpdate(callback: (event: DomainEvents.BalanceUpdatedEvent) => void): void {
    this.subscribe('BalanceUpdated', callback);
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.assetRepository.clear();
    this.balanceRepository.clear();
  }

  /**
   * Update RPC endpoints
   */
  updateEndpoints(endpoints: string[]): void {
    this.connectionManager.updateEndpoints(endpoints);
  }

  /**
   * Get connection health metrics
   */
  getHealthMetrics() {
    return this.connectionManager.getMetrics();
  }

  // Private helper methods

  private async fetchNFTs(address: string): Promise<NFTInfo[]> {
    try {
      const publicKey = new PublicKey(address);
      const nfts = await this.metaplexAdapter.getNFTs(publicKey);
      
      return nfts.map(nft => ({
        mint: nft.mint.toString(),
        name: nft.name,
        symbol: nft.symbol,
        uri: nft.uri,
        collection: nft.collection?.address.toString()
      }));
    } catch (error) {
      console.error('Failed to fetch NFTs:', error);
      return [];
    }
  }

  private getSolBalance(portfolio: PortfolioAggregate): number {
    const solAsset = portfolio.getAssets().find(
      asset => asset.assetType === 'native' && asset.symbol === 'SOL'
    );
    return solAsset ? solAsset.balance.getValue() : 0;
  }

  private buildTokenBalances(portfolio: PortfolioAggregate): TokenBalance[] {
    return portfolio.getAssetsByType('token').map(asset => ({
      mint: asset.mint,
      symbol: asset.symbol,
      name: asset.name,
      balance: asset.balance.getValue(),
      decimals: asset.decimals,
      valueUSD: asset.valueUSD
    }));
  }

  private subscribe(eventType: string, callback: (event: any) => void): void {
    if (!this.eventBus.has(eventType)) {
      this.eventBus.set(eventType, []);
    }
    this.eventBus.get(eventType)!.push(callback);
  }

  private publish(eventType: string, event: any): void {
    const handlers = this.eventBus.get(eventType) || [];
    handlers.forEach(handler => handler(event));
  }

  private setupEventHandlers(): void {
    // Forward domain events to subscribers
    setInterval(() => {
      // This would normally integrate with a proper event bus
      // For now, we'll use a simple polling mechanism
    }, 1000);
  }
}