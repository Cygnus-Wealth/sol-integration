/**
 * Circuit Breaker Implementation
 * 
 * Provides circuit breaker pattern for endpoint health monitoring.
 * Prevents cascade failures by detecting failures and opening circuit.
 */

import { Result } from '../../domain/shared/Result';
import { DomainError, CircuitBreakerOpenError } from '../../domain/shared/DomainError';

export enum CircuitState {
  CLOSED = 'CLOSED',     // Normal operation
  OPEN = 'OPEN',         // Circuit is open, rejecting calls
  HALF_OPEN = 'HALF_OPEN' // Testing if service has recovered
}

export interface CircuitBreakerConfig {
  failureThreshold: number;      // Number of failures before opening
  recoveryTimeout: number;       // Time to wait before trying half-open (ms)
  successThreshold: number;      // Successes needed in half-open to close
  timeout: number;              // Individual operation timeout (ms)
  monitoringPeriod: number;     // Time window for failure counting (ms)
  onStateChange?: (oldState: CircuitState, newState: CircuitState, reason: string) => void;
  onSuccess?: (executionTime: number) => void;
  onFailure?: (error: Error, executionTime: number) => void;
}

export interface CircuitBreakerMetrics {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  totalCalls: number;
  lastFailureTime?: Date;
  lastSuccessTime?: Date;
  stateChangeTime: Date;
  averageExecutionTime: number;
  successRate: number;
  failureRate: number;
  uptime: number; // percentage
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private totalCalls: number = 0;
  private lastFailureTime?: Date;
  private lastSuccessTime?: Date;
  private stateChangeTime: Date = new Date();
  private nextAttemptTime: number = 0;
  private executionTimes: number[] = [];

  private readonly config: CircuitBreakerConfig;
  private readonly name: string;

  constructor(name: string, config: CircuitBreakerConfig) {
    this.name = name;
    this.config = config;
  }

  /**
   * Execute operation with circuit breaker protection
   */
  async execute<T>(
    operation: () => Promise<T>,
    fallback?: () => Promise<T>
  ): Promise<Result<T, DomainError>> {
    const canExecute = this.canExecute();
    
    if (!canExecute.isSuccess()) {
      // Circuit is open, try fallback if available
      if (fallback) {
        try {
          const result = await fallback();
          return Result.ok(result);
        } catch (error) {
          return Result.fail(canExecute.getError());
        }
      }
      return Result.fail(canExecute.getError());
    }

    const startTime = Date.now();
    this.totalCalls++;

    try {
      // Execute with timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Operation timed out after ${this.config.timeout}ms`));
        }, this.config.timeout);
      });

      const result = await Promise.race([operation(), timeoutPromise]);
      
      const executionTime = Date.now() - startTime;
      this.onSuccess(executionTime);
      
      return Result.ok(result);
    } catch (error) {
      const executionTime = Date.now() - startTime;
      this.onFailure(error as Error, executionTime);
      
      return Result.fail(
        new DomainError(
          'CIRCUIT_BREAKER_FAILURE',
          `Operation failed in circuit breaker '${this.name}': ${(error as Error).message}`,
          { 
            circuitState: this.state,
            failureCount: this.failureCount,
            error: error instanceof Error ? error.message : String(error)
          }
        )
      );
    }
  }

  /**
   * Check if operation can be executed
   */
  private canExecute(): Result<void, DomainError> {
    const now = Date.now();
    
    switch (this.state) {
      case CircuitState.CLOSED:
        return Result.ok(undefined);
        
      case CircuitState.OPEN:
        if (now >= this.nextAttemptTime) {
          this.moveToHalfOpen();
          return Result.ok(undefined);
        }
        
        const recoveryTime = new Date(this.nextAttemptTime);
        return Result.fail(
          new CircuitBreakerOpenError(this.name, recoveryTime)
        );
        
      case CircuitState.HALF_OPEN:
        return Result.ok(undefined);
        
      default:
        return Result.fail(
          new DomainError('INVALID_CIRCUIT_STATE', `Invalid circuit state: ${this.state}`)
        );
    }
  }

  /**
   * Handle successful operation
   */
  private onSuccess(executionTime: number): void {
    this.recordExecutionTime(executionTime);
    this.lastSuccessTime = new Date();
    
    if (this.config.onSuccess) {
      this.config.onSuccess(executionTime);
    }

    switch (this.state) {
      case CircuitState.CLOSED:
        this.resetFailureCount();
        break;
        
      case CircuitState.HALF_OPEN:
        this.successCount++;
        if (this.successCount >= this.config.successThreshold) {
          this.moveToClosed();
        }
        break;
    }
  }

  /**
   * Handle failed operation
   */
  private onFailure(error: Error, executionTime: number): void {
    this.recordExecutionTime(executionTime);
    this.lastFailureTime = new Date();
    
    if (this.config.onFailure) {
      this.config.onFailure(error, executionTime);
    }

    this.failureCount++;
    
    if (this.shouldOpen()) {
      this.moveToOpen();
    }
  }

  /**
   * Record execution time for metrics
   */
  private recordExecutionTime(time: number): void {
    this.executionTimes.push(time);
    
    // Keep only recent execution times (last 100)
    if (this.executionTimes.length > 100) {
      this.executionTimes = this.executionTimes.slice(-100);
    }
  }

  /**
   * Check if circuit should open
   */
  private shouldOpen(): boolean {
    if (this.state === CircuitState.OPEN) {
      return false;
    }
    
    return this.failureCount >= this.config.failureThreshold;
  }

  /**
   * Move to OPEN state
   */
  private moveToOpen(): void {
    const oldState = this.state;
    this.state = CircuitState.OPEN;
    this.stateChangeTime = new Date();
    this.nextAttemptTime = Date.now() + this.config.recoveryTimeout;
    
    if (this.config.onStateChange) {
      this.config.onStateChange(
        oldState, 
        this.state, 
        `Failure threshold reached: ${this.failureCount}/${this.config.failureThreshold}`
      );
    }
  }

  /**
   * Move to HALF_OPEN state
   */
  private moveToHalfOpen(): void {
    const oldState = this.state;
    this.state = CircuitState.HALF_OPEN;
    this.stateChangeTime = new Date();
    this.successCount = 0;
    
    if (this.config.onStateChange) {
      this.config.onStateChange(
        oldState, 
        this.state, 
        'Recovery timeout elapsed, testing service'
      );
    }
  }

  /**
   * Move to CLOSED state
   */
  private moveToClosed(): void {
    const oldState = this.state;
    this.state = CircuitState.CLOSED;
    this.stateChangeTime = new Date();
    this.resetFailureCount();
    
    if (this.config.onStateChange) {
      this.config.onStateChange(
        oldState, 
        this.state, 
        `Service recovered, success threshold reached: ${this.successCount}/${this.config.successThreshold}`
      );
    }
  }

  /**
   * Reset failure count
   */
  private resetFailureCount(): void {
    this.failureCount = 0;
  }

  /**
   * Force circuit to open state
   */
  forceOpen(reason: string = 'Manually forced open'): void {
    const oldState = this.state;
    this.state = CircuitState.OPEN;
    this.stateChangeTime = new Date();
    this.nextAttemptTime = Date.now() + this.config.recoveryTimeout;
    
    if (this.config.onStateChange) {
      this.config.onStateChange(oldState, this.state, reason);
    }
  }

  /**
   * Force circuit to closed state
   */
  forceClosed(reason: string = 'Manually forced closed'): void {
    const oldState = this.state;
    this.state = CircuitState.CLOSED;
    this.stateChangeTime = new Date();
    this.resetFailureCount();
    
    if (this.config.onStateChange) {
      this.config.onStateChange(oldState, this.state, reason);
    }
  }

  /**
   * Reset circuit breaker to initial state
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.totalCalls = 0;
    this.lastFailureTime = undefined;
    this.lastSuccessTime = undefined;
    this.stateChangeTime = new Date();
    this.nextAttemptTime = 0;
    this.executionTimes = [];
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get circuit breaker name
   */
  getName(): string {
    return this.name;
  }

  /**
   * Check if circuit is open
   */
  isOpen(): boolean {
    return this.state === CircuitState.OPEN;
  }

  /**
   * Check if circuit is closed
   */
  isClosed(): boolean {
    return this.state === CircuitState.CLOSED;
  }

  /**
   * Check if circuit is half-open
   */
  isHalfOpen(): boolean {
    return this.state === CircuitState.HALF_OPEN;
  }

  /**
   * Get time until next attempt (for open state)
   */
  getTimeUntilNextAttempt(): number {
    if (this.state !== CircuitState.OPEN) {
      return 0;
    }
    
    return Math.max(0, this.nextAttemptTime - Date.now());
  }

  /**
   * Get comprehensive metrics
   */
  getMetrics(): CircuitBreakerMetrics {
    const now = Date.now();
    const stateTime = now - this.stateChangeTime.getTime();
    
    const averageExecutionTime = this.executionTimes.length > 0
      ? this.executionTimes.reduce((sum, time) => sum + time, 0) / this.executionTimes.length
      : 0;
    
    const successRate = this.totalCalls > 0
      ? ((this.totalCalls - this.failureCount) / this.totalCalls) * 100
      : 100;
    
    const failureRate = this.totalCalls > 0
      ? (this.failureCount / this.totalCalls) * 100
      : 0;
    
    // Calculate uptime as percentage of time in CLOSED state
    const uptime = this.state === CircuitState.CLOSED ? 100 : 
                  this.state === CircuitState.HALF_OPEN ? 50 : 0;

    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      totalCalls: this.totalCalls,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      stateChangeTime: this.stateChangeTime,
      averageExecutionTime,
      successRate,
      failureRate,
      uptime
    };
  }

  /**
   * Export circuit breaker configuration
   */
  getConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<CircuitBreakerConfig>): void {
    Object.assign(this.config, updates);
  }
}