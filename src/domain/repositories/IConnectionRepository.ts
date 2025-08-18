/**
 * Connection Repository Interface
 * 
 * Defines the contract for RPC connection management and health monitoring.
 * Abstracts connection implementation from domain logic.
 */

import { PublicKeyVO } from '../asset/valueObjects/PublicKeyVO';
import { Result } from '../shared/Result';
import { DomainError } from '../shared/DomainError';

export interface ConnectionEndpoint {
  id: string;
  url: string;
  name: string;
  network: 'mainnet-beta' | 'testnet' | 'devnet';
  priority: number;
  maxConcurrency: number;
  timeoutMs: number;
  isActive: boolean;
  healthScore: number; // 0-100
  lastHealthCheck: Date;
  rateLimit?: {
    requestsPerSecond: number;
    burstLimit: number;
  };
  features: ConnectionFeature[];
}

export type ConnectionFeature = 
  | 'get_balance'
  | 'get_token_accounts'
  | 'get_account_info'
  | 'get_multiple_accounts'
  | 'get_token_metadata'
  | 'get_nft_metadata'
  | 'send_transaction'
  | 'simulate_transaction';

export interface ConnectionHealth {
  endpoint: ConnectionEndpoint;
  isHealthy: boolean;
  latency: number; // milliseconds
  successRate: number; // percentage (0-100)
  errorRate: number; // percentage (0-100)
  lastError?: DomainError;
  uptime: number; // percentage (0-100)
  checkedAt: Date;
}

export interface ConnectionStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageLatency: number;
  rateLimitHits: number;
  timeouts: number;
  connectionErrors: number;
  lastRequestAt?: Date;
  periodStart: Date;
  periodEnd: Date;
}

export interface ConnectionPoolConfig {
  minConnections: number;
  maxConnections: number;
  healthCheckInterval: number; // milliseconds
  retryAttempts: number;
  retryDelay: number; // milliseconds
  failoverThreshold: number; // failed requests before failover
  loadBalancing: 'round_robin' | 'least_latency' | 'weighted' | 'priority';
}

export interface LoadBalancingStrategy {
  selectEndpoint(
    endpoints: ConnectionEndpoint[], 
    feature?: ConnectionFeature
  ): ConnectionEndpoint | null;
}

export interface IConnectionRepository {
  /**
   * Get all configured endpoints
   */
  getAllEndpoints(): Promise<Result<ConnectionEndpoint[], DomainError>>;

  /**
   * Get active endpoints only
   */
  getActiveEndpoints(): Promise<Result<ConnectionEndpoint[], DomainError>>;

  /**
   * Get endpoint by ID
   */
  getEndpoint(id: string): Promise<Result<ConnectionEndpoint | null, DomainError>>;

  /**
   * Add new endpoint
   */
  addEndpoint(endpoint: Omit<ConnectionEndpoint, 'id' | 'healthScore' | 'lastHealthCheck'>): Promise<Result<ConnectionEndpoint, DomainError>>;

  /**
   * Update endpoint configuration
   */
  updateEndpoint(id: string, updates: Partial<ConnectionEndpoint>): Promise<Result<ConnectionEndpoint, DomainError>>;

  /**
   * Remove endpoint
   */
  removeEndpoint(id: string): Promise<Result<void, DomainError>>;

  /**
   * Get best endpoint for a specific feature
   */
  getBestEndpoint(feature?: ConnectionFeature): Promise<Result<ConnectionEndpoint | null, DomainError>>;

  /**
   * Get endpoints by network
   */
  getEndpointsByNetwork(network: 'mainnet-beta' | 'testnet' | 'devnet'): Promise<Result<ConnectionEndpoint[], DomainError>>;

  /**
   * Health monitoring
   */
  checkEndpointHealth(id: string): Promise<Result<ConnectionHealth, DomainError>>;

  /**
   * Check health of all endpoints
   */
  checkAllEndpointsHealth(): Promise<Result<ConnectionHealth[], DomainError>>;

  /**
   * Update endpoint health
   */
  updateEndpointHealth(id: string, health: Partial<ConnectionHealth>): Promise<Result<void, DomainError>>;

  /**
   * Get health history for an endpoint
   */
  getHealthHistory(id: string, hours?: number): Promise<Result<ConnectionHealth[], DomainError>>;

  /**
   * Statistics tracking
   */
  recordRequest(endpointId: string, success: boolean, latency: number, feature?: ConnectionFeature): Promise<Result<void, DomainError>>;

  /**
   * Get endpoint statistics
   */
  getEndpointStats(id: string, hours?: number): Promise<Result<ConnectionStats, DomainError>>;

  /**
   * Get aggregated statistics
   */
  getAggregatedStats(hours?: number): Promise<Result<ConnectionStats, DomainError>>;

  /**
   * Connection pool management
   */
  setPoolConfig(config: ConnectionPoolConfig): Promise<Result<void, DomainError>>;

  /**
   * Get current pool configuration
   */
  getPoolConfig(): Promise<Result<ConnectionPoolConfig, DomainError>>;

  /**
   * Failover management
   */
  markEndpointAsFailed(id: string, error: DomainError): Promise<Result<void, DomainError>>;

  /**
   * Restore failed endpoint
   */
  restoreEndpoint(id: string): Promise<Result<void, DomainError>>;

  /**
   * Get failed endpoints
   */
  getFailedEndpoints(): Promise<Result<ConnectionEndpoint[], DomainError>>;

  /**
   * Circuit breaker
   */
  isEndpointCircuitOpen(id: string): Promise<Result<boolean, DomainError>>;

  /**
   * Reset circuit breaker
   */
  resetCircuitBreaker(id: string): Promise<Result<void, DomainError>>;

  /**
   * Rate limiting
   */
  checkRateLimit(endpointId: string): Promise<Result<boolean, DomainError>>;

  /**
   * Update rate limit usage
   */
  recordRateLimitUsage(endpointId: string): Promise<Result<void, DomainError>>;

  /**
   * Clear rate limit counters
   */
  clearRateLimitCounters(endpointId?: string): Promise<Result<void, DomainError>>;

  /**
   * Maintenance
   */
  pruneOldHealthData(olderThanHours: number): Promise<Result<number, DomainError>>;

  /**
   * Clear all statistics
   */
  clearStatistics(): Promise<Result<void, DomainError>>;

  /**
   * Export endpoint configuration
   */
  exportConfig(): Promise<Result<any, DomainError>>;

  /**
   * Import endpoint configuration
   */
  importConfig(config: any): Promise<Result<void, DomainError>>;
}

/**
 * Connection Manager Interface
 * 
 * High-level interface for managing connections with automatic failover,
 * load balancing, and health monitoring.
 */
export interface IConnectionManager {
  /**
   * Execute a function with an appropriate connection
   */
  withConnection<T>(
    operation: (endpoint: ConnectionEndpoint) => Promise<Result<T, DomainError>>,
    feature?: ConnectionFeature,
    retries?: number
  ): Promise<Result<T, DomainError>>;

  /**
   * Get connection for specific feature
   */
  getConnection(feature?: ConnectionFeature): Promise<Result<ConnectionEndpoint, DomainError>>;

  /**
   * Test connection to an endpoint
   */
  testConnection(endpointId: string): Promise<Result<ConnectionHealth, DomainError>>;

  /**
   * Start health monitoring
   */
  startHealthMonitoring(): Promise<Result<void, DomainError>>;

  /**
   * Stop health monitoring
   */
  stopHealthMonitoring(): Promise<Result<void, DomainError>>;

  /**
   * Force health check
   */
  forceHealthCheck(): Promise<Result<ConnectionHealth[], DomainError>>;

  /**
   * Get current connection status
   */
  getConnectionStatus(): Promise<Result<{
    totalEndpoints: number;
    activeEndpoints: number;
    failedEndpoints: number;
    averageLatency: number;
    totalRequests: number;
    successRate: number;
  }, DomainError>>;

  /**
   * Subscribe to connection events
   */
  onConnectionEvent(
    event: 'endpoint_failed' | 'endpoint_restored' | 'health_check' | 'failover',
    callback: (data: any) => void
  ): void;

  /**
   * Unsubscribe from connection events
   */
  offConnectionEvent(
    event: 'endpoint_failed' | 'endpoint_restored' | 'health_check' | 'failover',
    callback: (data: any) => void
  ): void;
}

/**
 * Load Balancing Strategies
 */
export class RoundRobinStrategy implements LoadBalancingStrategy {
  private currentIndex = 0;

  selectEndpoint(endpoints: ConnectionEndpoint[]): ConnectionEndpoint | null {
    if (endpoints.length === 0) return null;
    
    const endpoint = endpoints[this.currentIndex % endpoints.length];
    this.currentIndex = (this.currentIndex + 1) % endpoints.length;
    
    return endpoint;
  }
}

export class LeastLatencyStrategy implements LoadBalancingStrategy {
  selectEndpoint(endpoints: ConnectionEndpoint[]): ConnectionEndpoint | null {
    if (endpoints.length === 0) return null;
    
    // For this strategy, we'd need access to recent latency data
    // This is a simplified implementation
    return endpoints.reduce((best, current) => 
      current.healthScore > best.healthScore ? current : best
    );
  }
}

export class WeightedStrategy implements LoadBalancingStrategy {
  selectEndpoint(endpoints: ConnectionEndpoint[]): ConnectionEndpoint | null {
    if (endpoints.length === 0) return null;
    
    // Weight by health score and priority
    const weights = endpoints.map(ep => ep.healthScore * ep.priority);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    
    if (totalWeight === 0) return endpoints[0];
    
    let random = Math.random() * totalWeight;
    
    for (let i = 0; i < endpoints.length; i++) {
      random -= weights[i];
      if (random <= 0) {
        return endpoints[i];
      }
    }
    
    return endpoints[endpoints.length - 1];
  }
}

export class PriorityStrategy implements LoadBalancingStrategy {
  selectEndpoint(endpoints: ConnectionEndpoint[]): ConnectionEndpoint | null {
    if (endpoints.length === 0) return null;
    
    // Sort by priority (highest first) and health score
    const sorted = [...endpoints].sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return b.healthScore - a.healthScore;
    });
    
    return sorted[0];
  }
}