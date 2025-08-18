/**
 * Solana Connection Repository Implementation
 * 
 * Manages RPC connections with health monitoring, load balancing, and failover.
 * Implements the IConnectionRepository domain interface.
 */

import { 
  IConnectionRepository, 
  ConnectionEndpoint, 
  ConnectionHealth, 
  ConnectionStats, 
  ConnectionPoolConfig,
  LoadBalancingStrategy,
  RoundRobinStrategy,
  LeastLatencyStrategy,
  WeightedStrategy,
  PriorityStrategy,
  ConnectionFeature
} from '../../domain/repositories/IConnectionRepository';
import { Result } from '../../domain/shared/Result';
import { DomainError, ResourceNotFoundError, ConfigurationError, CircuitBreakerOpenError } from '../../domain/shared/DomainError';
import { LRUCache } from '../cache/LRUCache';
import { CircuitBreaker, CircuitBreakerConfig } from '../resilience/CircuitBreaker';
import { SolanaConnectionAdapter, ConnectionConfig } from '../connection/SolanaConnectionAdapter';

interface EndpointState {
  endpoint: ConnectionEndpoint;
  adapter: SolanaConnectionAdapter;
  circuitBreaker: CircuitBreaker;
  stats: ConnectionStats;
  healthHistory: ConnectionHealth[];
  rateLimitCounters: Map<string, { count: number; resetTime: number }>;
  lastRequestTime: number;
}

export class SolanaConnectionRepository implements IConnectionRepository {
  private endpoints: Map<string, EndpointState> = new Map();
  private healthCache: LRUCache<ConnectionHealth>;
  private loadBalancer: LoadBalancingStrategy;
  private poolConfig: ConnectionPoolConfig;
  private healthCheckTimer?: NodeJS.Timeout;
  private isHealthMonitoringActive = false;

  constructor(config?: {
    healthCacheSize?: number;
    healthCacheTTL?: number;
    defaultPoolConfig?: ConnectionPoolConfig;
    loadBalancingStrategy?: LoadBalancingStrategy;
  }) {
    this.healthCache = new LRUCache({
      maxSize: config?.healthCacheSize || 1000,
      defaultTTL: config?.healthCacheTTL || 60000, // 1 minute
      onEvict: (key, health) => {
        console.debug(`Health cache evicted: ${key}`);
      }
    });

    this.poolConfig = config?.defaultPoolConfig || {
      minConnections: 1,
      maxConnections: 10,
      healthCheckInterval: 30000,
      retryAttempts: 3,
      retryDelay: 1000,
      failoverThreshold: 5,
      loadBalancing: 'weighted'
    };

    this.loadBalancer = config?.loadBalancingStrategy || new WeightedStrategy();
  }

  async getAllEndpoints(): Promise<Result<ConnectionEndpoint[], DomainError>> {
    try {
      const endpoints = Array.from(this.endpoints.values()).map(state => state.endpoint);
      return Result.ok(endpoints);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to get all endpoints', { error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async getActiveEndpoints(): Promise<Result<ConnectionEndpoint[], DomainError>> {
    try {
      const activeEndpoints = Array.from(this.endpoints.values())
        .filter(state => state.endpoint.isActive && !state.circuitBreaker.isOpen())
        .map(state => state.endpoint);
      
      return Result.ok(activeEndpoints);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to get active endpoints', { error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async getEndpoint(id: string): Promise<Result<ConnectionEndpoint | null, DomainError>> {
    try {
      const state = this.endpoints.get(id);
      return Result.ok(state ? state.endpoint : null);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to get endpoint', { endpointId: id, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async addEndpoint(
    endpoint: Omit<ConnectionEndpoint, 'id' | 'healthScore' | 'lastHealthCheck'>
  ): Promise<Result<ConnectionEndpoint, DomainError>> {
    try {
      const id = this.generateEndpointId(endpoint.url);
      
      if (this.endpoints.has(id)) {
        return Result.fail(
          new DomainError('DUPLICATE_ENDPOINT', `Endpoint with URL ${endpoint.url} already exists`, { url: endpoint.url })
        );
      }

      const fullEndpoint: ConnectionEndpoint = {
        ...endpoint,
        id,
        healthScore: 100,
        lastHealthCheck: new Date()
      };

      // Create connection adapter
      const connectionConfig: ConnectionConfig = {
        endpoint: endpoint.url,
        timeout: endpoint.timeoutMs,
        enableRetries: true,
        enableCircuitBreaker: true
      };

      const adapter = new SolanaConnectionAdapter(connectionConfig);

      // Create circuit breaker
      const circuitBreakerConfig: CircuitBreakerConfig = {
        failureThreshold: this.poolConfig.failoverThreshold,
        recoveryTimeout: 60000,
        successThreshold: 3,
        timeout: endpoint.timeoutMs,
        monitoringPeriod: this.poolConfig.healthCheckInterval,
        onStateChange: (oldState, newState, reason) => {
          console.warn(`[${endpoint.url}] Circuit breaker: ${oldState} -> ${newState}. ${reason}`);
          this.updateEndpointHealthScore(id, newState === 'CLOSED' ? 100 : 0);
        }
      };

      const circuitBreaker = new CircuitBreaker(`endpoint-${id}`, circuitBreakerConfig);

      const state: EndpointState = {
        endpoint: fullEndpoint,
        adapter,
        circuitBreaker,
        stats: this.createInitialStats(),
        healthHistory: [],
        rateLimitCounters: new Map(),
        lastRequestTime: 0
      };

      this.endpoints.set(id, state);

      // Start health monitoring if this is the first endpoint
      if (this.endpoints.size === 1 && !this.isHealthMonitoringActive) {
        await this.startHealthMonitoring();
      }

      return Result.ok(fullEndpoint);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to add endpoint', { error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async updateEndpoint(
    id: string,
    updates: Partial<ConnectionEndpoint>
  ): Promise<Result<ConnectionEndpoint, DomainError>> {
    try {
      const state = this.endpoints.get(id);
      if (!state) {
        return Result.fail(new ResourceNotFoundError('ConnectionEndpoint', id));
      }

      const updatedEndpoint = { ...state.endpoint, ...updates };
      state.endpoint = updatedEndpoint;

      return Result.ok(updatedEndpoint);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to update endpoint', { endpointId: id, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async removeEndpoint(id: string): Promise<Result<void, DomainError>> {
    try {
      const state = this.endpoints.get(id);
      if (!state) {
        return Result.fail(new ResourceNotFoundError('ConnectionEndpoint', id));
      }

      this.endpoints.delete(id);

      // Stop health monitoring if no endpoints remain
      if (this.endpoints.size === 0 && this.isHealthMonitoringActive) {
        await this.stopHealthMonitoring();
      }

      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to remove endpoint', { endpointId: id, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async getBestEndpoint(feature?: ConnectionFeature): Promise<Result<ConnectionEndpoint | null, DomainError>> {
    try {
      const activeEndpointsResult = await this.getActiveEndpoints();
      if (activeEndpointsResult.isFailure()) {
        return Result.fail(activeEndpointsResult.getError());
      }

      let candidates = activeEndpointsResult.getValue();

      // Filter by feature support if specified
      if (feature) {
        candidates = candidates.filter(endpoint => endpoint.features.includes(feature));
      }

      if (candidates.length === 0) {
        return Result.ok(null);
      }

      const bestEndpoint = this.loadBalancer.selectEndpoint(candidates, feature);
      return Result.ok(bestEndpoint);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to get best endpoint', { feature, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async getEndpointsByNetwork(
    network: 'mainnet-beta' | 'testnet' | 'devnet'
  ): Promise<Result<ConnectionEndpoint[], DomainError>> {
    try {
      const endpoints = Array.from(this.endpoints.values())
        .filter(state => state.endpoint.network === network)
        .map(state => state.endpoint);
      
      return Result.ok(endpoints);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to get endpoints by network', { network, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async checkEndpointHealth(id: string): Promise<Result<ConnectionHealth, DomainError>> {
    try {
      const state = this.endpoints.get(id);
      if (!state) {
        return Result.fail(new ResourceNotFoundError('ConnectionEndpoint', id));
      }

      // Check cache first
      const cacheKey = `health-${id}`;
      const cachedHealth = this.healthCache.get(cacheKey);
      if (cachedHealth.isSuccess() && cachedHealth.getValue()) {
        return Result.ok(cachedHealth.getValue()!);
      }

      // Perform actual health check
      const startTime = Date.now();
      const healthResult = await state.adapter.checkHealth();
      const endTime = Date.now();
      const latency = endTime - startTime;

      const health: ConnectionHealth = {
        endpoint: state.endpoint,
        isHealthy: healthResult.isSuccess() && healthResult.getValue() === true,
        latency,
        successRate: this.calculateSuccessRate(state.stats),
        errorRate: this.calculateErrorRate(state.stats),
        lastError: healthResult.isFailure() ? healthResult.getError() : undefined,
        uptime: this.calculateUptime(state),
        checkedAt: new Date()
      };

      // Update endpoint health score
      const healthScore = this.calculateHealthScore(health);
      state.endpoint.healthScore = healthScore;
      state.endpoint.lastHealthCheck = health.checkedAt;

      // Cache the result
      this.healthCache.set(cacheKey, health);

      // Store in history
      state.healthHistory.push(health);
      if (state.healthHistory.length > 100) {
        state.healthHistory = state.healthHistory.slice(-100);
      }

      return Result.ok(health);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to check endpoint health', { endpointId: id, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async checkAllEndpointsHealth(): Promise<Result<ConnectionHealth[], DomainError>> {
    try {
      const healthChecks = Array.from(this.endpoints.keys()).map(id => 
        this.checkEndpointHealth(id)
      );

      const results = await Promise.allSettled(healthChecks);
      const healthResults: ConnectionHealth[] = [];

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.isSuccess()) {
          healthResults.push(result.value.getValue());
        }
      }

      return Result.ok(healthResults);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to check all endpoints health', { error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async updateEndpointHealth(
    id: string,
    health: Partial<ConnectionHealth>
  ): Promise<Result<void, DomainError>> {
    try {
      const state = this.endpoints.get(id);
      if (!state) {
        return Result.fail(new ResourceNotFoundError('ConnectionEndpoint', id));
      }

      // Update endpoint properties based on health
      if (health.isHealthy !== undefined) {
        state.endpoint.isActive = health.isHealthy;
      }

      if (health.latency !== undefined) {
        // Health score calculation could consider latency
        const healthScore = Math.max(0, 100 - (health.latency / 10));
        state.endpoint.healthScore = healthScore;
      }

      state.endpoint.lastHealthCheck = new Date();

      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to update endpoint health', { endpointId: id, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async getHealthHistory(
    id: string,
    hours?: number
  ): Promise<Result<ConnectionHealth[], DomainError>> {
    try {
      const state = this.endpoints.get(id);
      if (!state) {
        return Result.fail(new ResourceNotFoundError('ConnectionEndpoint', id));
      }

      let history = state.healthHistory;

      if (hours) {
        const cutoffTime = new Date(Date.now() - (hours * 60 * 60 * 1000));
        history = history.filter(h => h.checkedAt >= cutoffTime);
      }

      return Result.ok(history);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to get health history', { endpointId: id, hours, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async recordRequest(
    endpointId: string,
    success: boolean,
    latency: number,
    feature?: ConnectionFeature
  ): Promise<Result<void, DomainError>> {
    try {
      const state = this.endpoints.get(endpointId);
      if (!state) {
        return Result.fail(new ResourceNotFoundError('ConnectionEndpoint', endpointId));
      }

      // Update statistics
      state.stats.totalRequests++;
      state.lastRequestTime = Date.now();

      if (success) {
        state.stats.successfulRequests++;
      } else {
        state.stats.failedRequests++;
      }

      // Update latency (simple moving average)
      const totalLatency = state.stats.averageLatency * (state.stats.totalRequests - 1) + latency;
      state.stats.averageLatency = totalLatency / state.stats.totalRequests;

      state.stats.lastRequestAt = new Date();

      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to record request', { endpointId, success, latency, feature, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async getEndpointStats(
    id: string,
    hours?: number
  ): Promise<Result<ConnectionStats, DomainError>> {
    try {
      const state = this.endpoints.get(id);
      if (!state) {
        return Result.fail(new ResourceNotFoundError('ConnectionEndpoint', id));
      }

      return Result.ok(state.stats);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to get endpoint stats', { endpointId: id, hours, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async getAggregatedStats(hours?: number): Promise<Result<ConnectionStats, DomainError>> {
    try {
      const allStats = Array.from(this.endpoints.values()).map(state => state.stats);
      
      if (allStats.length === 0) {
        return Result.ok(this.createInitialStats());
      }

      const aggregated: ConnectionStats = {
        totalRequests: allStats.reduce((sum, stats) => sum + stats.totalRequests, 0),
        successfulRequests: allStats.reduce((sum, stats) => sum + stats.successfulRequests, 0),
        failedRequests: allStats.reduce((sum, stats) => sum + stats.failedRequests, 0),
        averageLatency: allStats.reduce((sum, stats) => sum + stats.averageLatency, 0) / allStats.length,
        rateLimitHits: allStats.reduce((sum, stats) => sum + stats.rateLimitHits, 0),
        timeouts: allStats.reduce((sum, stats) => sum + stats.timeouts, 0),
        connectionErrors: allStats.reduce((sum, stats) => sum + stats.connectionErrors, 0),
        lastRequestAt: allStats.reduce((latest, stats) => 
          !latest || (stats.lastRequestAt && stats.lastRequestAt > latest) ? stats.lastRequestAt : latest, 
          undefined as Date | undefined
        ),
        periodStart: allStats.reduce((earliest, stats) => 
          !earliest || stats.periodStart < earliest ? stats.periodStart : earliest, 
          allStats[0].periodStart
        ),
        periodEnd: new Date()
      };

      return Result.ok(aggregated);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to get aggregated stats', { hours, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async setPoolConfig(config: ConnectionPoolConfig): Promise<Result<void, DomainError>> {
    try {
      this.poolConfig = { ...config };
      
      // Update health check interval if monitoring is active
      if (this.isHealthMonitoringActive) {
        await this.stopHealthMonitoring();
        await this.startHealthMonitoring();
      }

      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to set pool config', { error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async getPoolConfig(): Promise<Result<ConnectionPoolConfig, DomainError>> {
    try {
      return Result.ok({ ...this.poolConfig });
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to get pool config', { error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async markEndpointAsFailed(id: string, error: DomainError): Promise<Result<void, DomainError>> {
    try {
      const state = this.endpoints.get(id);
      if (!state) {
        return Result.fail(new ResourceNotFoundError('ConnectionEndpoint', id));
      }

      state.endpoint.isActive = false;
      state.endpoint.healthScore = 0;
      state.circuitBreaker.forceOpen(`Marked as failed: ${error.message}`);

      return Result.ok(undefined);
    } catch (err) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to mark endpoint as failed', { endpointId: id, error: err instanceof Error ? err.message : String(err) })
      );
    }
  }

  async restoreEndpoint(id: string): Promise<Result<void, DomainError>> {
    try {
      const state = this.endpoints.get(id);
      if (!state) {
        return Result.fail(new ResourceNotFoundError('ConnectionEndpoint', id));
      }

      state.endpoint.isActive = true;
      state.endpoint.healthScore = 50; // Start with medium health
      state.circuitBreaker.forceClosed('Manually restored');

      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to restore endpoint', { endpointId: id, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async getFailedEndpoints(): Promise<Result<ConnectionEndpoint[], DomainError>> {
    try {
      const failedEndpoints = Array.from(this.endpoints.values())
        .filter(state => !state.endpoint.isActive || state.circuitBreaker.isOpen())
        .map(state => state.endpoint);
      
      return Result.ok(failedEndpoints);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to get failed endpoints', { error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async isEndpointCircuitOpen(id: string): Promise<Result<boolean, DomainError>> {
    try {
      const state = this.endpoints.get(id);
      if (!state) {
        return Result.fail(new ResourceNotFoundError('ConnectionEndpoint', id));
      }

      return Result.ok(state.circuitBreaker.isOpen());
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to check circuit state', { endpointId: id, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async resetCircuitBreaker(id: string): Promise<Result<void, DomainError>> {
    try {
      const state = this.endpoints.get(id);
      if (!state) {
        return Result.fail(new ResourceNotFoundError('ConnectionEndpoint', id));
      }

      state.circuitBreaker.reset();
      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to reset circuit breaker', { endpointId: id, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async checkRateLimit(endpointId: string): Promise<Result<boolean, DomainError>> {
    try {
      const state = this.endpoints.get(endpointId);
      if (!state) {
        return Result.fail(new ResourceNotFoundError('ConnectionEndpoint', endpointId));
      }

      const rateLimit = state.endpoint.rateLimit;
      if (!rateLimit) {
        return Result.ok(true); // No rate limit configured
      }

      const now = Date.now();
      const windowStart = now - 1000; // 1 second window
      
      // Clean up old counters
      for (const [key, counter] of state.rateLimitCounters) {
        if (counter.resetTime < windowStart) {
          state.rateLimitCounters.delete(key);
        }
      }

      const currentCount = Array.from(state.rateLimitCounters.values())
        .filter(counter => counter.resetTime > windowStart)
        .reduce((sum, counter) => sum + counter.count, 0);

      return Result.ok(currentCount < rateLimit.requestsPerSecond);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to check rate limit', { endpointId, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async recordRateLimitUsage(endpointId: string): Promise<Result<void, DomainError>> {
    try {
      const state = this.endpoints.get(endpointId);
      if (!state) {
        return Result.fail(new ResourceNotFoundError('ConnectionEndpoint', endpointId));
      }

      const now = Date.now();
      const key = `${now}-${Math.random()}`;
      
      state.rateLimitCounters.set(key, {
        count: 1,
        resetTime: now + 1000
      });

      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to record rate limit usage', { endpointId, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async clearRateLimitCounters(endpointId?: string): Promise<Result<void, DomainError>> {
    try {
      if (endpointId) {
        const state = this.endpoints.get(endpointId);
        if (!state) {
          return Result.fail(new ResourceNotFoundError('ConnectionEndpoint', endpointId));
        }
        state.rateLimitCounters.clear();
      } else {
        for (const state of this.endpoints.values()) {
          state.rateLimitCounters.clear();
        }
      }

      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to clear rate limit counters', { endpointId, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async pruneOldHealthData(olderThanHours: number): Promise<Result<number, DomainError>> {
    try {
      const cutoffTime = new Date(Date.now() - (olderThanHours * 60 * 60 * 1000));
      let prunedCount = 0;

      for (const state of this.endpoints.values()) {
        const originalLength = state.healthHistory.length;
        state.healthHistory = state.healthHistory.filter(h => h.checkedAt >= cutoffTime);
        prunedCount += originalLength - state.healthHistory.length;
      }

      return Result.ok(prunedCount);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to prune old health data', { olderThanHours, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async clearStatistics(): Promise<Result<void, DomainError>> {
    try {
      for (const state of this.endpoints.values()) {
        state.stats = this.createInitialStats();
        state.healthHistory = [];
        state.rateLimitCounters.clear();
      }

      this.healthCache.clear();
      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to clear statistics', { error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async exportConfig(): Promise<Result<any, DomainError>> {
    try {
      const config = {
        endpoints: Array.from(this.endpoints.values()).map(state => ({
          endpoint: state.endpoint,
          stats: state.stats
        })),
        poolConfig: this.poolConfig
      };

      return Result.ok(config);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to export config', { error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  async importConfig(config: any): Promise<Result<void, DomainError>> {
    try {
      if (!config.endpoints || !Array.isArray(config.endpoints)) {
        return Result.fail(new ConfigurationError('endpoints', 'Must be an array'));
      }

      // Clear existing endpoints
      this.endpoints.clear();

      // Import endpoints
      for (const endpointConfig of config.endpoints) {
        const result = await this.addEndpoint(endpointConfig.endpoint);
        if (result.isFailure()) {
          return Result.fail(result.getError());
        }
      }

      // Import pool config
      if (config.poolConfig) {
        const poolResult = await this.setPoolConfig(config.poolConfig);
        if (poolResult.isFailure()) {
          return Result.fail(poolResult.getError());
        }
      }

      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new DomainError('REPOSITORY_ERROR', 'Failed to import config', { error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  // Private helper methods

  private generateEndpointId(url: string): string {
    return `endpoint-${Buffer.from(url).toString('base64').slice(0, 8)}`;
  }

  private createInitialStats(): ConnectionStats {
    return {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageLatency: 0,
      rateLimitHits: 0,
      timeouts: 0,
      connectionErrors: 0,
      periodStart: new Date(),
      periodEnd: new Date()
    };
  }

  private calculateSuccessRate(stats: ConnectionStats): number {
    if (stats.totalRequests === 0) return 100;
    return (stats.successfulRequests / stats.totalRequests) * 100;
  }

  private calculateErrorRate(stats: ConnectionStats): number {
    if (stats.totalRequests === 0) return 0;
    return (stats.failedRequests / stats.totalRequests) * 100;
  }

  private calculateUptime(state: EndpointState): number {
    // Simple uptime calculation based on recent health checks
    const recentHealth = state.healthHistory.slice(-10);
    if (recentHealth.length === 0) return 100;
    
    const healthyCount = recentHealth.filter(h => h.isHealthy).length;
    return (healthyCount / recentHealth.length) * 100;
  }

  private calculateHealthScore(health: ConnectionHealth): number {
    let score = 100;
    
    if (!health.isHealthy) score = 0;
    
    // Factor in latency (higher latency = lower score)
    if (health.latency > 5000) score -= 50;
    else if (health.latency > 2000) score -= 30;
    else if (health.latency > 1000) score -= 20;
    else if (health.latency > 500) score -= 10;
    
    // Factor in error rate
    if (health.errorRate > 50) score -= 40;
    else if (health.errorRate > 25) score -= 25;
    else if (health.errorRate > 10) score -= 15;
    else if (health.errorRate > 5) score -= 5;
    
    return Math.max(0, Math.min(100, score));
  }

  private updateEndpointHealthScore(id: string, score: number): void {
    const state = this.endpoints.get(id);
    if (state) {
      state.endpoint.healthScore = score;
    }
  }

  private async startHealthMonitoring(): Promise<void> {
    if (this.isHealthMonitoringActive) return;
    
    this.isHealthMonitoringActive = true;
    
    const checkHealth = async () => {
      if (!this.isHealthMonitoringActive) return;
      
      try {
        await this.checkAllEndpointsHealth();
      } catch (error) {
        console.error('Health monitoring error:', error);
      }
      
      if (this.isHealthMonitoringActive) {
        this.healthCheckTimer = setTimeout(checkHealth, this.poolConfig.healthCheckInterval);
      }
    };
    
    // Start first check immediately
    await checkHealth();
  }

  private async stopHealthMonitoring(): Promise<void> {
    this.isHealthMonitoringActive = false;
    
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.stopHealthMonitoring();
    this.healthCache.destroy();
    this.endpoints.clear();
  }
}