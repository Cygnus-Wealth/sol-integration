/**
 * createSolIntegration Factory
 *
 * Factory function that wires the RPC fallback chain into the
 * SolanaIntegrationFacade. Replaces direct Connection creation
 * with fallback-chain-managed connections.
 *
 * This is the primary entry point for Phase 5 (en-25w5 directive).
 */

import { RpcProviderConfig } from './types';
import { RpcFallbackChain } from './RpcFallbackChain';
import { SolanaIntegrationFacade, SolanaConfig } from '../../application/SolanaIntegrationFacade';

export interface SolIntegration {
  facade: SolanaIntegrationFacade;
  fallbackChain: RpcFallbackChain;
  destroy: () => void;
}

export function createSolIntegration(config: RpcProviderConfig): SolIntegration {
  if (!config.endpoints || config.endpoints.length === 0) {
    throw new Error('At least one RPC endpoint must be configured');
  }

  // Validate no api.mainnet-beta.solana.com as primary endpoint
  const primaryEndpoint = [...config.endpoints].sort((a, b) => a.priority - b.priority)[0];
  if (primaryEndpoint.url.includes('api.mainnet-beta.solana.com')) {
    throw new Error(
      'api.mainnet-beta.solana.com must not be used as primary endpoint. ' +
      'Use a dedicated RPC provider (e.g., Helius, QuickNode) instead.'
    );
  }

  const fallbackChain = new RpcFallbackChain(config);

  // Build endpoint list for the facade (ordered by priority)
  const sortedEndpoints = [...config.endpoints].sort((a, b) => a.priority - b.priority);
  const endpointUrls = sortedEndpoints.map(ep => ep.url);

  // Create facade config from RPC provider config
  const facadeConfig: SolanaConfig = {
    rpcEndpoints: endpointUrls,
    commitment: config.commitment || 'confirmed',
    maxRetries: config.maxRetries ?? 3,
    enableCircuitBreaker: true,
    enableMetrics: true,
  };

  const facade = new SolanaIntegrationFacade(facadeConfig);

  // Start health monitoring if enabled
  if (config.enableHealthMonitoring !== false) {
    fallbackChain.startHealthMonitoring();
  }

  return {
    facade,
    fallbackChain,
    destroy: () => {
      fallbackChain.destroy();
    },
  };
}
