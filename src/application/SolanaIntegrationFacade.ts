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
import { DomainEvent } from '../domain/events/DomainEvents';
import { NetworkEnvironment, resolveEndpoints, getNetworkConfig } from '../config/networks';

export interface SolanaConfig {
  environment?: NetworkEnvironment;
  rpcEndpoints?: string[];
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
  private config: SolanaConfig;
  private environment: NetworkEnvironment;
  private resolvedEndpoints: string[];

  constructor(config: SolanaConfig) {
    this.config = config;
    this.environment = config.environment || 'testnet';
    this.resolvedEndpoints = resolveEndpoints(this.environment, config.rpcEndpoints);
    const networkConfig = getNetworkConfig(this.environment);

    // Initialize repositories
    this.assetRepository = new InMemoryAssetRepository({
      maxAssets: 1000,
      assetCacheTTL: config.cacheTTL || 300000
    });
    this.balanceRepository = new InMemoryBalanceRepository(1000, this.environment);
    this.connectionRepository = new SolanaConnectionRepository();

    // Initialize connection management
    this.connectionManager = new ConnectionManager(
      this.connectionRepository,
      {
        defaultTimeout: 30000,
        enableAutoRecovery: true,
        maxConcurrentConnections: 50
      }
    );

    // Add endpoints to repository
    for (let i = 0; i < this.resolvedEndpoints.length; i++) {
      this.connectionRepository.addEndpoint({
        url: this.resolvedEndpoints[i],
        name: `${networkConfig.clusterName}-${i}`,
        network: networkConfig.clusterName,
        features: [],
        maxConcurrency: 10,
        timeoutMs: 30000,
        isActive: true,
        priority: 1
      });
    }

    // Initialize adapters with a direct Connection object
    const connection = new Connection(this.resolvedEndpoints[0], config.commitment || 'confirmed');
    this.splTokenAdapter = new SPLTokenAdapter(connection);
    this.metaplexAdapter = new MetaplexAdapter(connection);

    // Initialize domain services
    const connectionAdapter = new SolanaConnectionAdapter({
      endpoint: this.resolvedEndpoints[0],
      commitment: config.commitment || 'confirmed',
      network: networkConfig.clusterName,
      enableRetries: true,
      enableCircuitBreaker: config.enableCircuitBreaker !== false,
      maxRetries: config.maxRetries || 3
    });
    this.balanceService = new SolanaBalanceService(
      connectionAdapter,
      this.assetRepository,
      this.balanceRepository
    );
    this.tokenDiscoveryService = new TokenDiscoveryService(
      connectionAdapter as any, // TODO: Fix interface - SolanaConnectionAdapter should implement ITokenDiscoveryConnection
      this.assetRepository
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
      const portfolio = PortfolioAggregate.create(publicKey.toString());

      // Discover all tokens - service expects a string
      const discoveryResult = await this.tokenDiscoveryService.discoverTokens(address);
      if (discoveryResult.isFailure) {
        return Result.fail(discoveryResult.getError());
      }

      const discovery = discoveryResult.getValue();

      // Add token assets to portfolio
      for (const token of discovery.tokens) {
        // Find the corresponding token account data
        const accountData = discovery.tokenAccounts.find(
          ta => ta.mint.toBase58() === token.getMintAddress()
        );
        if (accountData) {
          const amount = TokenAmount.fromTokenUnits(accountData.amount, accountData.decimals);
          portfolio.addAssetHolding(token, amount, accountData.pubkey);
        }
      }

      // Add NFT assets to portfolio
      for (const nft of discovery.nfts) {
        const accountData = discovery.tokenAccounts.find(
          ta => ta.mint.toBase58() === nft.getMint().toBase58()
        );
        if (accountData) {
          portfolio.addNFTHolding(nft, accountData.pubkey);
        }
      }

      // Build snapshot
      const snapshot: PortfolioSnapshot = {
        address,
        totalValueUSD: 0, // TODO: Add USD valuation
        solBalance: portfolio.getNativeBalance().getUIAmount(),
        tokenCount: portfolio.getTotalAssetCount(),
        nftCount: portfolio.getTotalNFTCount(),
        tokens: this.buildTokenBalances(portfolio),
        nfts: this.buildNFTInfo(portfolio),
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
      // Validate the address first
      const publicKey = PublicKeyVO.create(address);
      
      // Pass the string address to the service
      const balanceResult = await this.balanceService.fetchWalletBalance(address);
      if (balanceResult.isFailure) {
        return Result.fail(balanceResult.getError());
      }
      
      // Extract SOL balance from the wallet balance result
      const walletBalance = balanceResult.getValue();
      return Result.ok(walletBalance.nativeBalance.getUIAmount());
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
      const publicKeyVO = PublicKeyVO.create(address);
      const accountsResult = await this.splTokenAdapter.getTokenAccountsByOwner(publicKeyVO);

      if (accountsResult.isFailure) {
        return Result.fail(accountsResult.getError());
      }

      const tokenAccounts = accountsResult.getValue();
      const balances: TokenBalance[] = [];

      for (const account of tokenAccounts) {
        balances.push({
          mint: account.mint.toBase58(),
          symbol: 'UNKNOWN', // TODO: Fetch metadata
          name: 'Unknown Token',
          balance: account.amount.getUIAmount(),
          decimals: account.amount.getDecimals()
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
  onPortfolioUpdate(callback: (event: DomainEvent) => void): void {
    this.subscribe('PortfolioSynced', callback);
  }

  /**
   * Subscribe to balance updates
   */
  onBalanceUpdate(callback: (event: DomainEvent) => void): void {
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
    // TODO: Implement endpoint updating in ConnectionManager
    console.warn('updateEndpoints not yet implemented');
  }

  /**
   * Get connection health metrics
   */
  getHealthMetrics() {
    // TODO: Implement proper metrics from ConnectionManager
    return {
      endpoints: this.resolvedEndpoints.length,
      requests: 0,
      failures: 0,
      avgResponseTime: 0
    };
  }

  // Private helper methods

  private async fetchNFTs(address: string): Promise<NFTInfo[]> {
    try {
      const publicKey = new PublicKey(address);
      const nftsResult = await this.metaplexAdapter.getNFTsByOwner(
        PublicKeyVO.create(address)
      );
      
      if (nftsResult.isFailure) {
        console.error('Failed to fetch NFTs:', nftsResult.error);
        return [];
      }
      
      const nfts = nftsResult.getValue();
      
      return nfts.map(nft => ({
        mint: nft.mint.toBase58(),
        name: nft.name,
        symbol: nft.symbol,
        uri: nft.externalUrl || nft.image || '',
        collection: nft.collection?.name
      }));
    } catch (error) {
      console.error('Failed to fetch NFTs:', error);
      return [];
    }
  }

  private getSolBalance(portfolio: PortfolioAggregate): number {
    return portfolio.getNativeBalance().getUIAmount();
  }

  private buildTokenBalances(portfolio: PortfolioAggregate): TokenBalance[] {
    return portfolio.getAssetHoldings().map(holding => ({
      mint: holding.asset.getMintAddress(),
      symbol: holding.asset.getSymbol(),
      name: holding.asset.getName(),
      balance: holding.balance.getUIAmount(),
      decimals: holding.asset.getDecimals(),
      valueUSD: undefined // TODO: Add USD valuation
    }));
  }

  private buildNFTInfo(portfolio: PortfolioAggregate): NFTInfo[] {
    return portfolio.getNFTHoldings().map(holding => ({
      mint: holding.nft.getMint().toBase58(),
      name: holding.nft.getName(),
      symbol: holding.nft.getSymbol(),
      uri: holding.nft.getExternalUrl() || holding.nft.getImage() || '',
      collection: holding.nft.getCollection()?.toBase58(),
      attributes: holding.nft.getAttributes().reduce((acc, attr) => {
        acc[attr.trait_type] = attr.value;
        return acc;
      }, {} as Record<string, any>)
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