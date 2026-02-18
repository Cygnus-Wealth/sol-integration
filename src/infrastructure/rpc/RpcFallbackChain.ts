/**
 * RPC Fallback Chain
 *
 * Routes all RPC calls through an ordered chain of endpoints with:
 * - Per-endpoint circuit breakers
 * - Per-endpoint rate limiters
 * - Health-aware endpoint selection
 * - DAS-aware fallback: Helius DAS API methods use a restricted path
 *   (only endpoints with 'das' capability)
 */

import { Connection } from '@solana/web3.js';
import { CircuitBreaker, CircuitBreakerConfig, CircuitState } from '../resilience/CircuitBreaker';
import { TokenBucketRateLimiter } from './TokenBucketRateLimiter';
import { HealthMonitor, EndpointHealth } from './HealthMonitor';
import { RpcEndpointConfig, RpcProviderConfig, RpcEndpointCapability, DAS_METHODS } from './types';
import { Result } from '../../domain/shared/Result';
import { DomainError, NetworkError, OperationError } from '../../domain/shared/DomainError';

export interface EndpointState {
  config: RpcEndpointConfig;
  connection: Connection;
  circuitBreaker: CircuitBreaker;
  rateLimiter: TokenBucketRateLimiter;
}

export interface FallbackChainMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  fallbacksTriggered: number;
  endpointMetrics: Map<string, {
    requests: number;
    successes: number;
    failures: number;
    avgLatencyMs: number;
    circuitState: CircuitState;
    isHealthy: boolean;
  }>;
}

export class RpcFallbackChain {
  private readonly endpoints: EndpointState[];
  private readonly healthMonitor: HealthMonitor;
  private readonly commitment: 'processed' | 'confirmed' | 'finalized';
  private metrics: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    fallbacksTriggered: number;
    perEndpoint: Map<string, { requests: number; successes: number; failures: number; totalLatencyMs: number }>;
  };

  constructor(config: RpcProviderConfig) {
    this.commitment = config.commitment || 'confirmed';
    this.endpoints = [];
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      fallbacksTriggered: 0,
      perEndpoint: new Map(),
    };

    // Sort endpoints by priority (lower number = higher priority)
    const sorted = [...config.endpoints].sort((a, b) => a.priority - b.priority);

    // Health monitor
    this.healthMonitor = new HealthMonitor({
      intervalMs: config.healthMonitorIntervalMs || 30000,
      timeoutMs: config.defaultTimeoutMs || 5000,
      unhealthyThreshold: 3,
      healthyThreshold: 2,
    });

    for (const endpointConfig of sorted) {
      const connection = new Connection(endpointConfig.url, {
        commitment: this.commitment,
        confirmTransactionInitialTimeout: endpointConfig.timeoutMs || config.defaultTimeoutMs || 30000,
      });

      const cbConfig: CircuitBreakerConfig = {
        failureThreshold: endpointConfig.circuitBreaker?.failureThreshold ?? 5,
        recoveryTimeout: endpointConfig.circuitBreaker?.recoveryTimeoutMs ?? 30000,
        successThreshold: endpointConfig.circuitBreaker?.successThreshold ?? 2,
        timeout: endpointConfig.timeoutMs || config.defaultTimeoutMs || 30000,
        monitoringPeriod: 60000,
      };

      const circuitBreaker = new CircuitBreaker(
        `rpc-${endpointConfig.name}`,
        cbConfig
      );

      const rateLimiter = new TokenBucketRateLimiter({
        requestsPerSecond: endpointConfig.rateLimit?.requestsPerSecond ?? 10,
        burstCapacity: endpointConfig.rateLimit?.burstCapacity ?? 20,
      });

      this.endpoints.push({
        config: endpointConfig,
        connection,
        circuitBreaker,
        rateLimiter,
      });

      this.healthMonitor.registerEndpoint(endpointConfig.url, connection);
      this.metrics.perEndpoint.set(endpointConfig.url, {
        requests: 0, successes: 0, failures: 0, totalLatencyMs: 0,
      });
    }
  }

  async execute<T>(
    operation: (connection: Connection) => Promise<T>,
    options?: { method?: string; requiredCapabilities?: RpcEndpointCapability[] }
  ): Promise<Result<T, DomainError>> {
    this.metrics.totalRequests++;

    const requiredCapabilities = options?.requiredCapabilities || [];
    const method = options?.method || '';

    // If calling a DAS method, restrict to DAS-capable endpoints
    if (DAS_METHODS.has(method)) {
      if (!requiredCapabilities.includes('das')) {
        requiredCapabilities.push('das');
      }
    }

    const eligibleEndpoints = this.getEligibleEndpoints(requiredCapabilities);

    if (eligibleEndpoints.length === 0) {
      this.metrics.failedRequests++;
      return Result.fail(
        new NetworkError('No eligible RPC endpoints available for this operation')
      );
    }

    let lastError: DomainError | null = null;
    let usedFallback = false;

    for (const endpoint of eligibleEndpoints) {
      // Skip if circuit breaker is open
      if (endpoint.circuitBreaker.isOpen()) {
        continue;
      }

      // Check rate limit
      if (!endpoint.rateLimiter.tryAcquire()) {
        continue;
      }

      // Check health
      const health = this.healthMonitor.getHealth(endpoint.config.url);
      if (health && !health.isHealthy) {
        continue;
      }

      const start = Date.now();
      const epMetrics = this.metrics.perEndpoint.get(endpoint.config.url)!;
      epMetrics.requests++;

      const result = await endpoint.circuitBreaker.execute(() =>
        operation(endpoint.connection)
      );

      const latency = Date.now() - start;
      epMetrics.totalLatencyMs += latency;

      if (result.isSuccess) {
        epMetrics.successes++;
        this.metrics.successfulRequests++;
        if (usedFallback) {
          this.metrics.fallbacksTriggered++;
        }
        return result;
      }

      // This endpoint failed, try next
      epMetrics.failures++;
      lastError = result.getError();
      usedFallback = true;
    }

    this.metrics.failedRequests++;
    return Result.fail(
      lastError || new NetworkError('All RPC endpoints exhausted')
    );
  }

  getConnection(requiredCapabilities?: RpcEndpointCapability[]): Connection | null {
    const eligible = this.getEligibleEndpoints(requiredCapabilities || []);
    for (const ep of eligible) {
      if (!ep.circuitBreaker.isOpen()) {
        const health = this.healthMonitor.getHealth(ep.config.url);
        if (!health || health.isHealthy) {
          return ep.connection;
        }
      }
    }
    return eligible.length > 0 ? eligible[0].connection : null;
  }

  getHealthMonitor(): HealthMonitor {
    return this.healthMonitor;
  }

  getEndpointStates(): ReadonlyArray<EndpointState> {
    return this.endpoints;
  }

  getMetrics(): FallbackChainMetrics {
    const endpointMetrics = new Map<string, {
      requests: number;
      successes: number;
      failures: number;
      avgLatencyMs: number;
      circuitState: CircuitState;
      isHealthy: boolean;
    }>();

    for (const ep of this.endpoints) {
      const m = this.metrics.perEndpoint.get(ep.config.url)!;
      const health = this.healthMonitor.getHealth(ep.config.url);
      endpointMetrics.set(ep.config.url, {
        requests: m.requests,
        successes: m.successes,
        failures: m.failures,
        avgLatencyMs: m.requests > 0 ? m.totalLatencyMs / m.requests : 0,
        circuitState: ep.circuitBreaker.getState(),
        isHealthy: health?.isHealthy ?? true,
      });
    }

    return {
      totalRequests: this.metrics.totalRequests,
      successfulRequests: this.metrics.successfulRequests,
      failedRequests: this.metrics.failedRequests,
      fallbacksTriggered: this.metrics.fallbacksTriggered,
      endpointMetrics,
    };
  }

  startHealthMonitoring(): void {
    this.healthMonitor.start();
  }

  stopHealthMonitoring(): void {
    this.healthMonitor.stop();
  }

  async checkHealth(): Promise<Map<string, EndpointHealth>> {
    return this.healthMonitor.checkAllEndpoints();
  }

  destroy(): void {
    this.healthMonitor.stop();
  }

  private getEligibleEndpoints(requiredCapabilities: RpcEndpointCapability[]): EndpointState[] {
    if (requiredCapabilities.length === 0) {
      return this.endpoints;
    }
    return this.endpoints.filter(ep =>
      requiredCapabilities.every(cap => ep.config.capabilities.includes(cap))
    );
  }
}
