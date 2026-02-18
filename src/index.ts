// Main Facade
export { 
  SolanaIntegrationFacade,
  SolanaConfig,
  PortfolioSnapshot,
  TokenBalance,
  NFTInfo
} from './application/SolanaIntegrationFacade';

// Domain Value Objects
export { PublicKeyVO } from './domain/asset/valueObjects/PublicKeyVO';
export { TokenAmount } from './domain/asset/valueObjects/TokenAmount';
export { TokenMetadata } from './domain/asset/valueObjects/TokenMetadata';

// Domain Entities
export { SolanaAsset } from './domain/asset/aggregates/SolanaAsset';
export { NFTAsset, NFTAttribute } from './domain/asset/entities/NFTAsset';

// Re-export AssetType from data-models for convenience
export { AssetType } from '@cygnus-wealth/data-models';

// Domain Aggregates
export { PortfolioAggregate } from './domain/portfolio/aggregates/PortfolioAggregate';

// Domain Services
export { SolanaBalanceService } from './domain/services/SolanaBalanceService';
export { TokenDiscoveryService } from './domain/services/TokenDiscoveryService';

// Domain Events
export { DomainEvent } from './domain/events/DomainEvents';

// Shared Domain
export { Result } from './domain/shared/Result';
export { DomainError } from './domain/shared/DomainError';

// Repository Interfaces
export { IAssetRepository } from './domain/repositories/IAssetRepository';
export { IBalanceRepository } from './domain/repositories/IBalanceRepository';
export { IConnectionRepository } from './domain/repositories/IConnectionRepository';

// Network Configuration
export {
  NetworkEnvironment,
  NetworkConfig,
  NETWORK_CONFIGS,
  getNetworkConfig,
  getDefaultEndpoints,
  resolveEndpoints
} from './config/networks';

// RPC Fallback Chain (Phase 5)
export {
  createSolIntegration,
  RpcFallbackChain,
  TokenBucketRateLimiter,
  HealthMonitor,
  DAS_METHODS,
} from './infrastructure/rpc';
export type {
  SolIntegration,
  RpcProviderConfig,
  RpcEndpointConfig,
  RpcEndpointCapability,
  RpcCallOptions,
  EndpointState,
  FallbackChainMetrics,
  TokenBucketConfig,
  EndpointHealth,
  HealthMonitorConfig,
} from './infrastructure/rpc';

// Default export for convenience
import { SolanaIntegrationFacade } from './application/SolanaIntegrationFacade';
export default SolanaIntegrationFacade;