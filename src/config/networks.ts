/**
 * Network Configuration
 *
 * Maps NetworkEnvironment to Solana cluster URLs and metadata.
 * NetworkEnvironment is defined locally as a stand-in for
 * @cygnus-wealth/data-models NetworkEnvironment (da-2dd).
 * Replace with the import once that package is available.
 */

export type NetworkEnvironment = 'production' | 'testnet' | 'local';

export interface NetworkConfig {
  clusterUrl: string;
  clusterName: 'mainnet-beta' | 'testnet' | 'devnet';
  wsEndpoint?: string;
}

/**
 * NOTE: api.mainnet-beta.solana.com is intentionally NOT used as primary.
 * Production should use createSolIntegration() with a dedicated RPC provider.
 * The URL below is a placeholder; real endpoints come from RpcProviderConfig.
 */
export const NETWORK_CONFIGS: Record<NetworkEnvironment, NetworkConfig> = {
  production: {
    clusterUrl: 'https://rpc.placeholder.solana.com',
    clusterName: 'mainnet-beta',
    wsEndpoint: undefined,
  },
  testnet: {
    clusterUrl: 'https://api.devnet.solana.com',
    clusterName: 'devnet',
    wsEndpoint: 'wss://api.devnet.solana.com',
  },
  local: {
    clusterUrl: 'http://localhost:8899',
    clusterName: 'devnet',
    wsEndpoint: 'ws://localhost:8900',
  },
};

export function getNetworkConfig(environment: NetworkEnvironment): NetworkConfig {
  return NETWORK_CONFIGS[environment];
}

export function getDefaultEndpoints(environment: NetworkEnvironment): string[] {
  return [NETWORK_CONFIGS[environment].clusterUrl];
}

export function resolveEndpoints(
  environment?: NetworkEnvironment,
  rpcEndpoints?: string[]
): string[] {
  if (rpcEndpoints && rpcEndpoints.length > 0) {
    return rpcEndpoints;
  }
  return getDefaultEndpoints(environment || 'testnet');
}
