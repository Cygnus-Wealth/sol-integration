/**
 * RPC Provider Configuration Types
 *
 * Defines the configuration for multi-endpoint RPC fallback chains.
 * These types will eventually come from @cygnus-wealth/data-models
 * once RpcProviderConfig is published there.
 */

export interface RpcEndpointConfig {
  url: string;
  name: string;
  priority: number;
  weight?: number;
  rateLimit?: {
    requestsPerSecond: number;
    burstCapacity: number;
  };
  capabilities: RpcEndpointCapability[];
  healthCheck?: {
    intervalMs: number;
    timeoutMs: number;
    unhealthyThreshold: number;
    healthyThreshold: number;
  };
  circuitBreaker?: {
    failureThreshold: number;
    recoveryTimeoutMs: number;
    successThreshold: number;
  };
  timeoutMs?: number;
}

export type RpcEndpointCapability = 'standard' | 'das' | 'websocket' | 'getPriorityFee';

export interface RpcProviderConfig {
  endpoints: RpcEndpointConfig[];
  commitment?: 'processed' | 'confirmed' | 'finalized';
  defaultTimeoutMs?: number;
  maxRetries?: number;
  enableHealthMonitoring?: boolean;
  healthMonitorIntervalMs?: number;
}

export interface RpcCallOptions {
  method: string;
  requiredCapabilities?: RpcEndpointCapability[];
  timeoutMs?: number;
}

export const DAS_METHODS = new Set([
  'getAsset',
  'getAssetProof',
  'getAssetsByOwner',
  'getAssetsByGroup',
  'getAssetsByCreator',
  'getAssetsByAuthority',
  'searchAssets',
  'getSignaturesForAsset',
  'getTokenAccounts',
]);
