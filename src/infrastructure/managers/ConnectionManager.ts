/**
 * Connection Manager
 * 
 * High-level connection management with automatic failover, load balancing,
 * and health monitoring. Implements the IConnectionManager domain interface.
 */

import { 
  IConnectionManager,
  IConnectionRepository,
  ConnectionEndpoint,
  ConnectionHealth,
  ConnectionFeature
} from '../../domain/repositories/IConnectionRepository';
import { Result } from '../../domain/shared/Result';
import { DomainError, NetworkError, CircuitBreakerOpenError, ConnectionPoolExhaustedError } from '../../domain/shared/DomainError';
import { SolanaConnectionAdapter, ConnectionConfig } from '../connection/SolanaConnectionAdapter';

interface ConnectionManagerConfig {
  maxConcurrentConnections?: number;
  defaultTimeout?: number;
  healthCheckInterval?: number;
  failoverThreshold?: number;
  enableAutoRecovery?: boolean;
  recoveryCheckInterval?: number;
}

interface ConnectionState {
  adapter: SolanaConnectionAdapter;
  isActive: boolean;
  activeRequests: number;
  lastUsed: Date;
  errors: DomainError[];
  consecutiveFailures: number;
}

interface ConnectionManagerStats {
  totalConnections: number;
  activeConnections: number;
  failedConnections: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  lastFailover?: Date;
  uptime: number;
}

export class ConnectionManager implements IConnectionManager {
  private connectionRepo: IConnectionRepository;
  private connectionStates: Map<string, ConnectionState> = new Map();
  private config: ConnectionManagerConfig;
  private stats: ConnectionManagerStats;
  private healthCheckTimer?: NodeJS.Timeout;
  private recoveryTimer?: NodeJS.Timeout;
  private eventHandlers: Map<string, ((data: any) => void)[]> = new Map();
  private isStarted = false;

  constructor(
    connectionRepo: IConnectionRepository,
    config: ConnectionManagerConfig = {}
  ) {
    this.connectionRepo = connectionRepo;
    this.config = {
      maxConcurrentConnections: config.maxConcurrentConnections || 50,
      defaultTimeout: config.defaultTimeout || 30000,
      healthCheckInterval: config.healthCheckInterval || 30000,
      failoverThreshold: config.failoverThreshold || 3,
      enableAutoRecovery: config.enableAutoRecovery !== false,
      recoveryCheckInterval: config.recoveryCheckInterval || 60000,
      ...config
    };

    this.stats = {
      totalConnections: 0,
      activeConnections: 0,
      failedConnections: 0,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      uptime: 100
    };

    this.initializeEventHandlers();
  }

  async withConnection<T>(
    operation: (endpoint: ConnectionEndpoint) => Promise<Result<T, DomainError>>,
    feature?: ConnectionFeature,
    retries: number = 3
  ): Promise<Result<T, DomainError>> {
    const startTime = Date.now();
    let lastError: DomainError | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      // Get best available connection
      const endpointResult = await this.getConnection(feature);
      if (endpointResult.isFailure()) {
        lastError = endpointResult.getError();
        continue;
      }

      const endpoint = endpointResult.getValue();
      const state = this.connectionStates.get(endpoint.id);
      
      if (!state) {
        lastError = new NetworkError('Connection state not found', endpoint.url);
        continue;
      }

      // Check if we're at concurrent request limit
      if (state.activeRequests >= endpoint.maxConcurrency) {
        lastError = new NetworkError('Connection at capacity', endpoint.url);
        continue;
      }

      // Execute operation
      state.activeRequests++;
      this.stats.totalRequests++;

      try {
        const result = await operation(endpoint);
        const responseTime = Date.now() - startTime;
        
        await this.recordSuccess(endpoint.id, responseTime);
        
        if (result.isSuccess()) {
          return result;
        } else {
          lastError = result.getError();
          await this.recordFailure(endpoint.id, lastError);
        }
      } catch (error) {
        const domainError = error instanceof DomainError 
          ? error 
          : new NetworkError(`Operation failed: ${error instanceof Error ? error.message : String(error)}`, endpoint.url);
        
        lastError = domainError;
        await this.recordFailure(endpoint.id, domainError);
      } finally {
        state.activeRequests--;
        state.lastUsed = new Date();
      }

      // If this was a circuit breaker error, try next endpoint immediately
      if (lastError instanceof CircuitBreakerOpenError) {
        continue;
      }

      // For other errors, wait a bit before retry
      if (attempt < retries - 1) {
        await this.sleep(Math.pow(2, attempt) * 1000); // Exponential backoff
      }
    }

    // All retries failed
    this.stats.failedRequests++;
    return Result.fail(lastError || new NetworkError('All connection attempts failed'));
  }

  async getConnection(feature?: ConnectionFeature): Promise<Result<ConnectionEndpoint, DomainError>> {
    try {
      const endpointResult = await this.connectionRepo.getBestEndpoint(feature);
      if (endpointResult.isFailure()) {
        return Result.fail(endpointResult.getError());
      }

      const endpoint = endpointResult.getValue();
      if (!endpoint) {
        return Result.fail(new NetworkError('No available endpoints'));
      }

      // Ensure connection state exists
      await this.ensureConnectionState(endpoint);

      return Result.ok(endpoint);
    } catch (error) {
      return Result.fail(
        new NetworkError(`Failed to get connection: ${error instanceof Error ? error.message : String(error)}`)
      );
    }
  }

  async testConnection(endpointId: string): Promise<Result<ConnectionHealth, DomainError>> {
    try {
      return await this.connectionRepo.checkEndpointHealth(endpointId);
    } catch (error) {
      return Result.fail(
        new NetworkError(`Failed to test connection: ${error instanceof Error ? error.message : String(error)}`)
      );
    }
  }

  async startHealthMonitoring(): Promise<Result<void, DomainError>> {
    try {
      if (this.isStarted) {
        return Result.ok(undefined);
      }

      this.isStarted = true;

      // Initialize connection states for all endpoints
      const endpointsResult = await this.connectionRepo.getAllEndpoints();
      if (endpointsResult.isSuccess()) {
        for (const endpoint of endpointsResult.getValue()) {
          await this.ensureConnectionState(endpoint);
        }
      }

      // Start health monitoring
      if (typeof window === 'undefined') {
        this.healthCheckTimer = setInterval(() => {
          this.performHealthChecks();
        }, this.config.healthCheckInterval!);

        if (this.config.enableAutoRecovery) {
          this.recoveryTimer = setInterval(() => {
            this.attemptRecovery();
          }, this.config.recoveryCheckInterval!);
        }
      }

      this.emitEvent('health_check', { status: 'started' });
      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new DomainError('MONITORING_ERROR', `Failed to start health monitoring: ${error instanceof Error ? error.message : String(error)}`)
      );
    }
  }

  async stopHealthMonitoring(): Promise<Result<void, DomainError>> {
    try {
      this.isStarted = false;

      if (this.healthCheckTimer) {
        clearInterval(this.healthCheckTimer);
        this.healthCheckTimer = undefined;
      }

      if (this.recoveryTimer) {
        clearInterval(this.recoveryTimer);
        this.recoveryTimer = undefined;
      }

      this.emitEvent('health_check', { status: 'stopped' });
      return Result.ok(undefined);
    } catch (error) {
      return Result.fail(
        new DomainError('MONITORING_ERROR', `Failed to stop health monitoring: ${error instanceof Error ? error.message : String(error)}`)
      );
    }
  }

  async forceHealthCheck(): Promise<Result<ConnectionHealth[], DomainError>> {
    try {
      const healthResults = await this.connectionRepo.checkAllEndpointsHealth();
      if (healthResults.isFailure()) {
        return Result.fail(healthResults.getError());
      }

      const allHealth = healthResults.getValue();
      
      // Update connection states based on health
      for (const health of allHealth) {
        const state = this.connectionStates.get(health.endpoint.id);
        if (state) {
          state.isActive = health.isHealthy;
          
          if (!health.isHealthy && state.consecutiveFailures === 0) {
            this.emitEvent('endpoint_failed', { 
              endpointId: health.endpoint.id, 
              reason: health.lastError?.message 
            });
          } else if (health.isHealthy && state.consecutiveFailures > 0) {
            this.emitEvent('endpoint_restored', { 
              endpointId: health.endpoint.id 
            });
          }
          
          state.consecutiveFailures = health.isHealthy ? 0 : state.consecutiveFailures + 1;
        }
      }

      this.updateStats();
      return Result.ok(allHealth);
    } catch (error) {
      return Result.fail(
        new DomainError('HEALTH_CHECK_ERROR', `Failed to force health check: ${error instanceof Error ? error.message : String(error)}`)
      );
    }
  }

  async getConnectionStatus(): Promise<Result<{
    totalEndpoints: number;
    activeEndpoints: number;
    failedEndpoints: number;
    averageLatency: number;
    totalRequests: number;
    successRate: number;
  }, DomainError>> {
    try {
      const endpointsResult = await this.connectionRepo.getAllEndpoints();
      if (endpointsResult.isFailure()) {
        return Result.fail(endpointsResult.getError());
      }

      const allEndpoints = endpointsResult.getValue();
      const activeEndpoints = allEndpoints.filter(ep => ep.isActive).length;
      const failedEndpoints = allEndpoints.length - activeEndpoints;

      // Calculate average latency from recent health checks
      let totalLatency = 0;
      let healthChecks = 0;

      for (const endpoint of allEndpoints) {
        const healthResult = await this.connectionRepo.getHealthHistory(endpoint.id, 1);
        if (healthResult.isSuccess()) {
          const history = healthResult.getValue();
          if (history.length > 0) {
            totalLatency += history[0].latency;
            healthChecks++;
          }
        }
      }

      const averageLatency = healthChecks > 0 ? totalLatency / healthChecks : 0;
      const successRate = this.stats.totalRequests > 0 
        ? (this.stats.successfulRequests / this.stats.totalRequests) * 100 
        : 100;

      return Result.ok({
        totalEndpoints: allEndpoints.length,
        activeEndpoints,
        failedEndpoints,
        averageLatency,
        totalRequests: this.stats.totalRequests,
        successRate
      });
    } catch (error) {
      return Result.fail(
        new DomainError('STATUS_ERROR', `Failed to get connection status: ${error instanceof Error ? error.message : String(error)}`)
      );
    }
  }

  onConnectionEvent(
    event: 'endpoint_failed' | 'endpoint_restored' | 'health_check' | 'failover',
    callback: (data: any) => void
  ): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(callback);
  }

  offConnectionEvent(
    event: 'endpoint_failed' | 'endpoint_restored' | 'health_check' | 'failover',
    callback: (data: any) => void
  ): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      const index = handlers.indexOf(callback);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  // Private methods

  private async ensureConnectionState(endpoint: ConnectionEndpoint): Promise<void> {
    if (!this.connectionStates.has(endpoint.id)) {
      const connectionConfig: ConnectionConfig = {
        endpoint: endpoint.url,
        timeout: endpoint.timeoutMs,
        enableRetries: true,
        enableCircuitBreaker: true
      };

      const adapter = new SolanaConnectionAdapter(connectionConfig);
      
      this.connectionStates.set(endpoint.id, {
        adapter,
        isActive: endpoint.isActive,
        activeRequests: 0,
        lastUsed: new Date(),
        errors: [],
        consecutiveFailures: 0
      });

      this.stats.totalConnections++;
    }
  }

  private async recordSuccess(endpointId: string, responseTime: number): Promise<void> {
    const state = this.connectionStates.get(endpointId);
    if (state) {
      state.consecutiveFailures = 0;
      state.errors = []; // Clear errors on success
      
      if (!state.isActive) {
        state.isActive = true;
        this.emitEvent('endpoint_restored', { endpointId });
      }
    }

    await this.connectionRepo.recordRequest(endpointId, true, responseTime);
    
    this.stats.successfulRequests++;
    this.updateAverageResponseTime(responseTime);
  }

  private async recordFailure(endpointId: string, error: DomainError): Promise<void> {
    const state = this.connectionStates.get(endpointId);
    if (state) {
      state.consecutiveFailures++;
      state.errors.push(error);
      
      // Keep only recent errors
      if (state.errors.length > 10) {
        state.errors = state.errors.slice(-10);
      }

      // Mark as failed if too many consecutive failures
      if (state.consecutiveFailures >= this.config.failoverThreshold! && state.isActive) {
        state.isActive = false;
        await this.connectionRepo.markEndpointAsFailed(endpointId, error);
        this.emitEvent('endpoint_failed', { endpointId, error: error.message });
        this.stats.lastFailover = new Date();
      }
    }

    await this.connectionRepo.recordRequest(endpointId, false, 0);
  }

  private async performHealthChecks(): Promise<void> {
    try {
      await this.forceHealthCheck();
    } catch (error) {
      console.error('Health check failed:', error);
    }
  }

  private async attemptRecovery(): Promise<void> {
    try {
      const failedEndpointsResult = await this.connectionRepo.getFailedEndpoints();
      if (failedEndpointsResult.isFailure()) {
        return;
      }

      const failedEndpoints = failedEndpointsResult.getValue();
      
      for (const endpoint of failedEndpoints) {
        // Try to test the connection
        const healthResult = await this.testConnection(endpoint.id);
        if (healthResult.isSuccess() && healthResult.getValue().isHealthy) {
          // Restore the endpoint
          await this.connectionRepo.restoreEndpoint(endpoint.id);
          
          const state = this.connectionStates.get(endpoint.id);
          if (state) {
            state.isActive = true;
            state.consecutiveFailures = 0;
            state.errors = [];
          }
          
          this.emitEvent('endpoint_restored', { endpointId: endpoint.id });
        }
      }
    } catch (error) {
      console.error('Recovery attempt failed:', error);
    }
  }

  private updateAverageResponseTime(responseTime: number): void {
    const totalResponseTime = this.stats.averageResponseTime * (this.stats.successfulRequests - 1) + responseTime;
    this.stats.averageResponseTime = totalResponseTime / this.stats.successfulRequests;
  }

  private updateStats(): void {
    const activeCount = Array.from(this.connectionStates.values()).filter(state => state.isActive).length;
    this.stats.activeConnections = activeCount;
    this.stats.failedConnections = this.stats.totalConnections - activeCount;
    this.stats.uptime = this.stats.totalConnections > 0 ? (activeCount / this.stats.totalConnections) * 100 : 100;
  }

  private emitEvent(event: string, data: any): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (error) {
          console.error(`Error in event handler for ${event}:`, error);
        }
      }
    }
  }

  private initializeEventHandlers(): void {
    this.eventHandlers.set('endpoint_failed', []);
    this.eventHandlers.set('endpoint_restored', []);
    this.eventHandlers.set('health_check', []);
    this.eventHandlers.set('failover', []);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get manager statistics
   */
  getStats(): ConnectionManagerStats {
    return { ...this.stats };
  }

  /**
   * Get manager configuration
   */
  getConfig(): ConnectionManagerConfig {
    return { ...this.config };
  }

  /**
   * Update manager configuration
   */
  updateConfig(updates: Partial<ConnectionManagerConfig>): void {
    Object.assign(this.config, updates);
  }

  /**
   * Get connection state for debugging
   */
  getConnectionStates(): Map<string, ConnectionState> {
    return new Map(this.connectionStates);
  }

  /**
   * Add new endpoint to management
   */
  async addEndpoint(
    endpoint: Omit<ConnectionEndpoint, 'id' | 'healthScore' | 'lastHealthCheck'>
  ): Promise<Result<ConnectionEndpoint, DomainError>> {
    const result = await this.connectionRepo.addEndpoint(endpoint);
    if (result.isSuccess()) {
      await this.ensureConnectionState(result.getValue());
      this.updateStats();
    }
    return result;
  }

  /**
   * Remove endpoint from management
   */
  async removeEndpoint(endpointId: string): Promise<Result<void, DomainError>> {
    const result = await this.connectionRepo.removeEndpoint(endpointId);
    if (result.isSuccess()) {
      this.connectionStates.delete(endpointId);
      this.updateStats();
    }
    return result;
  }

  /**
   * Cleanup resources
   */
  async destroy(): Promise<void> {
    await this.stopHealthMonitoring();
    this.connectionStates.clear();
    this.eventHandlers.clear();
  }
}