/**
 * Retry Policy Implementation
 * 
 * Provides configurable retry logic with exponential backoff and jitter.
 * Supports different retry strategies for various failure scenarios.
 */

import { Result } from '../../domain/shared/Result';
import { DomainError, NetworkError, TimeoutError, RPCError, OperationError } from '../../domain/shared/DomainError';

export interface RetryConfig {
  maxAttempts: number;
  baseDelay: number;           // Initial delay in milliseconds
  maxDelay: number;           // Maximum delay in milliseconds
  backoffMultiplier: number;  // Exponential backoff multiplier
  jitter: boolean;           // Add random jitter to prevent thundering herd
  retryableErrors: string[]; // Error codes that should trigger retry
  onRetry?: (attempt: number, error: Error, delay: number) => void;
  onSuccess?: (attempt: number, totalTime: number) => void;
  onFailure?: (totalAttempts: number, finalError: Error, totalTime: number) => void;
}

export interface RetryAttempt {
  attemptNumber: number;
  startTime: number;
  endTime?: number;
  error?: Error;
  success: boolean;
  delay?: number;
}

export interface RetryMetrics {
  totalAttempts: number;
  successfulAttempts: number;
  failedAttempts: number;
  totalRetryTime: number;
  averageRetryTime: number;
  maxRetryTime: number;
  minRetryTime: number;
  lastAttemptTime?: Date;
  successRate: number;
}

export enum RetryStrategy {
  EXPONENTIAL_BACKOFF = 'EXPONENTIAL_BACKOFF',
  LINEAR_BACKOFF = 'LINEAR_BACKOFF',
  FIXED_DELAY = 'FIXED_DELAY',
  FIBONACCI_BACKOFF = 'FIBONACCI_BACKOFF'
}

export class RetryPolicy {
  private readonly config: RetryConfig;
  private readonly strategy: RetryStrategy;
  private readonly name: string;
  private attempts: RetryAttempt[] = [];
  private metrics: RetryMetrics = {
    totalAttempts: 0,
    successfulAttempts: 0,
    failedAttempts: 0,
    totalRetryTime: 0,
    averageRetryTime: 0,
    maxRetryTime: 0,
    minRetryTime: Infinity,
    successRate: 0
  };

  constructor(name: string, config: RetryConfig, strategy: RetryStrategy = RetryStrategy.EXPONENTIAL_BACKOFF) {
    this.name = name;
    this.config = config;
    this.strategy = strategy;
  }

  /**
   * Execute operation with retry policy
   */
  async execute<T>(operation: () => Promise<T>): Promise<Result<T, DomainError>> {
    const startTime = Date.now();
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      const attemptStart = Date.now();
      
      try {
        const result = await operation();
        
        const attemptEnd = Date.now();
        const totalTime = attemptEnd - startTime;
        
        this.recordAttempt({
          attemptNumber: attempt,
          startTime: attemptStart,
          endTime: attemptEnd,
          success: true
        });
        
        this.updateMetrics(true, totalTime);
        
        if (this.config.onSuccess) {
          this.config.onSuccess(attempt, totalTime);
        }
        
        return Result.ok(result);
      } catch (error) {
        const attemptEnd = Date.now();
        lastError = error as Error;
        
        this.recordAttempt({
          attemptNumber: attempt,
          startTime: attemptStart,
          endTime: attemptEnd,
          error: lastError,
          success: false
        });
        
        // Check if error is retryable
        if (!this.isRetryableError(lastError) || attempt === this.config.maxAttempts) {
          const totalTime = attemptEnd - startTime;
          this.updateMetrics(false, totalTime);
          
          if (this.config.onFailure) {
            this.config.onFailure(attempt, lastError, totalTime);
          }
          
          return Result.fail(this.createDomainError(lastError, attempt));
        }
        
        // Calculate delay for next attempt
        const delay = this.calculateDelay(attempt);
        
        if (this.config.onRetry) {
          this.config.onRetry(attempt, lastError, delay);
        }
        
        // Wait before next attempt
        await this.sleep(delay);
      }
    }
    
    // This should never be reached, but TypeScript requires it
    const totalTime = Date.now() - startTime;
    this.updateMetrics(false, totalTime);
    
    return Result.fail(
      new OperationError(
        'RETRY_EXHAUSTED',
        `All ${this.config.maxAttempts} retry attempts failed for '${this.name}'`,
        { 
          finalError: lastError?.message,
          totalAttempts: this.config.maxAttempts
        }
      )
    );
  }

  /**
   * Calculate delay based on retry strategy
   */
  private calculateDelay(attempt: number): number {
    let delay: number;
    
    switch (this.strategy) {
      case RetryStrategy.EXPONENTIAL_BACKOFF:
        delay = Math.min(
          this.config.baseDelay * Math.pow(this.config.backoffMultiplier, attempt - 1),
          this.config.maxDelay
        );
        break;
        
      case RetryStrategy.LINEAR_BACKOFF:
        delay = Math.min(
          this.config.baseDelay * attempt,
          this.config.maxDelay
        );
        break;
        
      case RetryStrategy.FIXED_DELAY:
        delay = this.config.baseDelay;
        break;
        
      case RetryStrategy.FIBONACCI_BACKOFF:
        delay = Math.min(
          this.config.baseDelay * this.fibonacci(attempt),
          this.config.maxDelay
        );
        break;
        
      default:
        delay = this.config.baseDelay;
    }
    
    // Add jitter if configured
    if (this.config.jitter) {
      // Add up to 10% jitter
      const jitterAmount = delay * 0.1;
      const jitter = (Math.random() - 0.5) * jitterAmount;
      delay = Math.max(0, delay + jitter);
    }
    
    return Math.floor(delay);
  }

  /**
   * Calculate fibonacci number for fibonacci backoff
   */
  private fibonacci(n: number): number {
    if (n <= 1) return 1;
    if (n === 2) return 2;
    
    let a = 1, b = 2;
    for (let i = 3; i <= n; i++) {
      const temp = a + b;
      a = b;
      b = temp;
    }
    return b;
  }

  /**
   * Check if error should trigger a retry
   */
  private isRetryableError(error: Error): boolean {
    // Check specific error types that are generally retryable
    if (error instanceof NetworkError) {
      return error.retryable === true;
    }
    
    if (error instanceof TimeoutError) {
      return true;
    }
    
    if (error instanceof RPCError) {
      // Some RPC errors are retryable (network issues, rate limits)
      const retryableRPCCodes = [-32000, -32005, -32603, 429, 502, 503, 504];
      return error.rpcCode ? retryableRPCCodes.includes(error.rpcCode) : true;
    }
    
    // Check if error code is in configured retryable errors
    if (error instanceof DomainError) {
      return this.config.retryableErrors.includes(error.code);
    }
    
    // Check common retryable error patterns
    const retryablePatterns = [
      /timeout/i,
      /network/i,
      /connection/i,
      /503/,
      /502/,
      /504/,
      /429/,
      /rate.?limit/i,
      /temporary/i,
      /transient/i
    ];
    
    return retryablePatterns.some(pattern => pattern.test(error.message));
  }

  /**
   * Create appropriate domain error from caught error
   */
  private createDomainError(error: Error, attempts: number): DomainError {
    if (error instanceof DomainError) {
      return error;
    }
    
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new OperationError(
      'OPERATION_FAILED',
      `Operation '${this.name}' failed after ${attempts} attempts: ${errorMessage}`,
      {
        originalError: errorMessage,
        attempts,
        retryPolicy: this.name
      }
    );
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Record retry attempt
   */
  private recordAttempt(attempt: RetryAttempt): void {
    this.attempts.push(attempt);
    
    // Keep only last 100 attempts
    if (this.attempts.length > 100) {
      this.attempts = this.attempts.slice(-100);
    }
  }

  /**
   * Update metrics
   */
  private updateMetrics(success: boolean, totalTime: number): void {
    this.metrics.totalAttempts++;
    this.metrics.lastAttemptTime = new Date();
    
    if (success) {
      this.metrics.successfulAttempts++;
    } else {
      this.metrics.failedAttempts++;
    }
    
    this.metrics.totalRetryTime += totalTime;
    this.metrics.averageRetryTime = this.metrics.totalRetryTime / this.metrics.totalAttempts;
    
    if (totalTime > this.metrics.maxRetryTime) {
      this.metrics.maxRetryTime = totalTime;
    }
    
    if (totalTime < this.metrics.minRetryTime) {
      this.metrics.minRetryTime = totalTime;
    }
    
    this.metrics.successRate = this.metrics.totalAttempts > 0
      ? (this.metrics.successfulAttempts / this.metrics.totalAttempts) * 100
      : 0;
  }

  /**
   * Get retry policy name
   */
  getName(): string {
    return this.name;
  }

  /**
   * Get retry policy configuration
   */
  getConfig(): RetryConfig {
    return { ...this.config };
  }

  /**
   * Get retry strategy
   */
  getStrategy(): RetryStrategy {
    return this.strategy;
  }

  /**
   * Get retry metrics
   */
  getMetrics(): RetryMetrics {
    return { ...this.metrics };
  }

  /**
   * Get recent retry attempts
   */
  getRecentAttempts(limit: number = 10): RetryAttempt[] {
    return this.attempts.slice(-limit);
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = {
      totalAttempts: 0,
      successfulAttempts: 0,
      failedAttempts: 0,
      totalRetryTime: 0,
      averageRetryTime: 0,
      maxRetryTime: 0,
      minRetryTime: Infinity,
      successRate: 0
    };
    this.attempts = [];
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<RetryConfig>): void {
    Object.assign(this.config, updates);
  }

  /**
   * Create common retry policies
   */
  static createNetworkRetryPolicy(name: string): RetryPolicy {
    return new RetryPolicy(name, {
      maxAttempts: 3,
      baseDelay: 1000,
      maxDelay: 30000,
      backoffMultiplier: 2,
      jitter: true,
      retryableErrors: ['NETWORK_ERROR', 'TIMEOUT_ERROR', 'RPC_ERROR']
    });
  }

  static createAggressiveRetryPolicy(name: string): RetryPolicy {
    return new RetryPolicy(name, {
      maxAttempts: 5,
      baseDelay: 500,
      maxDelay: 60000,
      backoffMultiplier: 1.5,
      jitter: true,
      retryableErrors: ['NETWORK_ERROR', 'TIMEOUT_ERROR', 'RPC_ERROR', 'RATE_LIMIT_ERROR']
    });
  }

  static createConservativeRetryPolicy(name: string): RetryPolicy {
    return new RetryPolicy(name, {
      maxAttempts: 2,
      baseDelay: 2000,
      maxDelay: 10000,
      backoffMultiplier: 2,
      jitter: false,
      retryableErrors: ['NETWORK_ERROR', 'TIMEOUT_ERROR']
    });
  }
}