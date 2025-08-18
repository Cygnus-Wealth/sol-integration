/**
 * Retry Policy Tests
 * 
 * Comprehensive test suite for the Retry Policy implementation.
 * Tests retry strategies, backoff algorithms, and error handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RetryPolicy, RetryStrategy, RetryConfig } from '../../infrastructure/resilience/RetryPolicy';
import { DomainError, NetworkError, TimeoutError } from '../../domain/shared/DomainError';

describe('RetryPolicy', () => {
  let retryPolicy: RetryPolicy;
  let config: RetryConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    
    config = {
      maxAttempts: 3,
      baseDelay: 1000,
      maxDelay: 10000,
      backoffMultiplier: 2,
      jitter: false,
      retryableErrors: ['NETWORK_ERROR', 'TIMEOUT_ERROR']
    };
  });

  afterEach(() => {
    vi.restoreAllTimers();
  });

  describe('Basic Retry Functionality', () => {
    beforeEach(() => {
      retryPolicy = new RetryPolicy('test-retry', config);
    });

    it('should succeed on first attempt', async () => {
      const operation = vi.fn().mockResolvedValue('success');
      
      const result = await retryPolicy.execute(operation);
      
      expect(result.isSuccess()).toBe(true);
      expect(result.getValue()).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable errors', async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new NetworkError('Network failure'))
        .mockRejectedValueOnce(new NetworkError('Another failure'))
        .mockResolvedValue('success');

      const promise = retryPolicy.execute(operation);
      
      // Fast forward through delays
      vi.runAllTimers();
      
      const result = await promise;
      
      expect(result.isSuccess()).toBe(true);
      expect(result.getValue()).toBe('success');
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('should not retry non-retryable errors', async () => {
      const nonRetryableError = new DomainError('VALIDATION_ERROR', 'Invalid input');
      const operation = vi.fn().mockRejectedValue(nonRetryableError);

      const result = await retryPolicy.execute(operation);
      
      expect(result.isFailure()).toBe(true);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should fail after exhausting max attempts', async () => {
      const operation = vi.fn().mockRejectedValue(new NetworkError('Persistent failure'));

      const promise = retryPolicy.execute(operation);
      vi.runAllTimers();
      
      const result = await promise;
      
      expect(result.isFailure()).toBe(true);
      expect(operation).toHaveBeenCalledTimes(config.maxAttempts);
    });

    it('should handle timeout errors as retryable', async () => {
      const timeoutError = new TimeoutError('getBalance', 5000, 'https://api.mainnet.solana.com');
      const operation = vi.fn()
        .mockRejectedValueOnce(timeoutError)
        .mockResolvedValue('success');

      const promise = retryPolicy.execute(operation);
      vi.runAllTimers();
      
      const result = await promise;
      
      expect(result.isSuccess()).toBe(true);
      expect(operation).toHaveBeenCalledTimes(2);
    });
  });

  describe('Retry Strategies', () => {
    it('should use exponential backoff strategy', async () => {
      retryPolicy = new RetryPolicy('test-retry', config, RetryStrategy.EXPONENTIAL_BACKOFF);
      
      const operation = vi.fn()
        .mockRejectedValueOnce(new NetworkError('Fail 1'))
        .mockRejectedValueOnce(new NetworkError('Fail 2'))
        .mockResolvedValue('success');

      const promise = retryPolicy.execute(operation);
      
      // Check delays: should be 1000ms, 2000ms
      expect(operation).toHaveBeenCalledTimes(1);
      
      vi.advanceTimersByTime(999);
      expect(operation).toHaveBeenCalledTimes(1);
      
      vi.advanceTimersByTime(1);
      expect(operation).toHaveBeenCalledTimes(2);
      
      vi.advanceTimersByTime(1999);
      expect(operation).toHaveBeenCalledTimes(2);
      
      vi.advanceTimersByTime(1);
      expect(operation).toHaveBeenCalledTimes(3);
      
      const result = await promise;
      expect(result.isSuccess()).toBe(true);
    });

    it('should use linear backoff strategy', async () => {
      retryPolicy = new RetryPolicy('test-retry', config, RetryStrategy.LINEAR_BACKOFF);
      
      const operation = vi.fn()
        .mockRejectedValueOnce(new NetworkError('Fail 1'))
        .mockRejectedValueOnce(new NetworkError('Fail 2'))
        .mockResolvedValue('success');

      const promise = retryPolicy.execute(operation);
      
      // Linear backoff: baseDelay * attempt (1000ms, 2000ms)
      vi.advanceTimersByTime(1000);
      expect(operation).toHaveBeenCalledTimes(2);
      
      vi.advanceTimersByTime(2000);
      expect(operation).toHaveBeenCalledTimes(3);
      
      const result = await promise;
      expect(result.isSuccess()).toBe(true);
    });

    it('should use fixed delay strategy', async () => {
      retryPolicy = new RetryPolicy('test-retry', config, RetryStrategy.FIXED_DELAY);
      
      const operation = vi.fn()
        .mockRejectedValueOnce(new NetworkError('Fail 1'))
        .mockRejectedValueOnce(new NetworkError('Fail 2'))
        .mockResolvedValue('success');

      const promise = retryPolicy.execute(operation);
      
      // Fixed delay: baseDelay for all attempts (1000ms each)
      vi.advanceTimersByTime(1000);
      expect(operation).toHaveBeenCalledTimes(2);
      
      vi.advanceTimersByTime(1000);
      expect(operation).toHaveBeenCalledTimes(3);
      
      const result = await promise;
      expect(result.isSuccess()).toBe(true);
    });

    it('should use fibonacci backoff strategy', async () => {
      retryPolicy = new RetryPolicy('test-retry', config, RetryStrategy.FIBONACCI_BACKOFF);
      
      const operation = vi.fn()
        .mockRejectedValueOnce(new NetworkError('Fail 1'))
        .mockRejectedValueOnce(new NetworkError('Fail 2'))
        .mockResolvedValue('success');

      const promise = retryPolicy.execute(operation);
      
      // Fibonacci: 1000ms (1), 2000ms (2)
      vi.advanceTimersByTime(1000);
      expect(operation).toHaveBeenCalledTimes(2);
      
      vi.advanceTimersByTime(2000);
      expect(operation).toHaveBeenCalledTimes(3);
      
      const result = await promise;
      expect(result.isSuccess()).toBe(true);
    });

    it('should respect max delay', async () => {
      const configWithLowMaxDelay = {
        ...config,
        baseDelay: 1000,
        maxDelay: 1500,
        backoffMultiplier: 3
      };
      
      retryPolicy = new RetryPolicy('test-retry', configWithLowMaxDelay, RetryStrategy.EXPONENTIAL_BACKOFF);
      
      const operation = vi.fn()
        .mockRejectedValueOnce(new NetworkError('Fail 1'))
        .mockRejectedValueOnce(new NetworkError('Fail 2'))
        .mockResolvedValue('success');

      const promise = retryPolicy.execute(operation);
      
      // First delay: 1000ms
      vi.advanceTimersByTime(1000);
      expect(operation).toHaveBeenCalledTimes(2);
      
      // Second delay: should be capped at maxDelay (1500ms) instead of 3000ms
      vi.advanceTimersByTime(1500);
      expect(operation).toHaveBeenCalledTimes(3);
      
      const result = await promise;
      expect(result.isSuccess()).toBe(true);
    });
  });

  describe('Jitter', () => {
    it('should add jitter when enabled', async () => {
      const configWithJitter = { ...config, jitter: true };
      retryPolicy = new RetryPolicy('test-retry', configWithJitter);
      
      const operation = vi.fn()
        .mockRejectedValueOnce(new NetworkError('Fail'))
        .mockResolvedValue('success');

      // Mock Math.random to return a specific value
      const mockRandom = vi.spyOn(Math, 'random').mockReturnValue(0.5);

      const promise = retryPolicy.execute(operation);
      
      // With jitter, delay should be baseDelay ± 10%
      // With random = 0.5, jitter = 0, so delay should be 1000ms
      vi.advanceTimersByTime(1000);
      expect(operation).toHaveBeenCalledTimes(2);
      
      await promise;
      mockRandom.mockRestore();
    });

    it('should not add jitter when disabled', async () => {
      const configWithoutJitter = { ...config, jitter: false };
      retryPolicy = new RetryPolicy('test-retry', configWithoutJitter);
      
      const operation = vi.fn()
        .mockRejectedValueOnce(new NetworkError('Fail'))
        .mockResolvedValue('success');

      const promise = retryPolicy.execute(operation);
      
      // Without jitter, delay should be exactly baseDelay
      vi.advanceTimersByTime(999);
      expect(operation).toHaveBeenCalledTimes(1);
      
      vi.advanceTimersByTime(1);
      expect(operation).toHaveBeenCalledTimes(2);
      
      await promise;
    });
  });

  describe('Error Classification', () => {
    beforeEach(() => {
      retryPolicy = new RetryPolicy('test-retry', config);
    });

    it('should retry on network errors', async () => {
      const networkError = new NetworkError('Connection failed', 'https://api.solana.com', true);
      const operation = vi.fn()
        .mockRejectedValueOnce(networkError)
        .mockResolvedValue('success');

      const promise = retryPolicy.execute(operation);
      vi.runAllTimers();
      
      const result = await promise;
      expect(result.isSuccess()).toBe(true);
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should not retry on non-retryable network errors', async () => {
      const networkError = new NetworkError('Connection failed', 'https://api.solana.com', false);
      const operation = vi.fn().mockRejectedValue(networkError);

      const result = await retryPolicy.execute(operation);
      
      expect(result.isFailure()).toBe(true);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry on timeout errors', async () => {
      const timeoutError = new TimeoutError('operation', 5000);
      const operation = vi.fn()
        .mockRejectedValueOnce(timeoutError)
        .mockResolvedValue('success');

      const promise = retryPolicy.execute(operation);
      vi.runAllTimers();
      
      const result = await promise;
      expect(result.isSuccess()).toBe(true);
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should retry on configured error codes', async () => {
      const configuredError = new DomainError('NETWORK_ERROR', 'Network issue');
      const operation = vi.fn()
        .mockRejectedValueOnce(configuredError)
        .mockResolvedValue('success');

      const promise = retryPolicy.execute(operation);
      vi.runAllTimers();
      
      const result = await promise;
      expect(result.isSuccess()).toBe(true);
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should retry on error message patterns', async () => {
      const patternError = new Error('Network timeout occurred');
      const operation = vi.fn()
        .mockRejectedValueOnce(patternError)
        .mockResolvedValue('success');

      const promise = retryPolicy.execute(operation);
      vi.runAllTimers();
      
      const result = await promise;
      expect(result.isSuccess()).toBe(true);
      expect(operation).toHaveBeenCalledTimes(2);
    });
  });

  describe('Metrics and Monitoring', () => {
    beforeEach(() => {
      retryPolicy = new RetryPolicy('test-retry', config);
    });

    it('should track retry metrics', async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new NetworkError('Fail'))
        .mockResolvedValue('success');

      const promise = retryPolicy.execute(operation);
      vi.runAllTimers();
      
      await promise;
      
      const metrics = retryPolicy.getMetrics();
      expect(metrics.totalAttempts).toBe(1);
      expect(metrics.successfulAttempts).toBe(1);
      expect(metrics.failedAttempts).toBe(0);
      expect(metrics.successRate).toBe(100);
      expect(metrics.totalRetryTime).toBeGreaterThan(0);
    });

    it('should track failed attempts', async () => {
      const operation = vi.fn().mockRejectedValue(new NetworkError('Persistent fail'));

      const promise = retryPolicy.execute(operation);
      vi.runAllTimers();
      
      await promise;
      
      const metrics = retryPolicy.getMetrics();
      expect(metrics.totalAttempts).toBe(1);
      expect(metrics.successfulAttempts).toBe(0);
      expect(metrics.failedAttempts).toBe(1);
      expect(metrics.successRate).toBe(0);
    });

    it('should track average retry time', async () => {
      const operation1 = vi.fn().mockResolvedValue('success1');
      const operation2 = vi.fn()
        .mockRejectedValueOnce(new NetworkError('Fail'))
        .mockResolvedValue('success2');

      await retryPolicy.execute(operation1);
      
      const promise = retryPolicy.execute(operation2);
      vi.runAllTimers();
      await promise;
      
      const metrics = retryPolicy.getMetrics();
      expect(metrics.averageRetryTime).toBeGreaterThan(0);
      expect(metrics.maxRetryTime).toBeGreaterThan(metrics.minRetryTime);
    });

    it('should get recent retry attempts', async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new NetworkError('Fail'))
        .mockResolvedValue('success');

      const promise = retryPolicy.execute(operation);
      vi.runAllTimers();
      
      await promise;
      
      const recentAttempts = retryPolicy.getRecentAttempts(5);
      expect(recentAttempts).toHaveLength(1);
      expect(recentAttempts[0].attemptNumber).toBe(1);
      expect(recentAttempts[0].success).toBe(true);
    });

    it('should reset metrics', async () => {
      const operation = vi.fn().mockResolvedValue('success');
      await retryPolicy.execute(operation);
      
      let metrics = retryPolicy.getMetrics();
      expect(metrics.totalAttempts).toBe(1);
      
      retryPolicy.resetMetrics();
      
      metrics = retryPolicy.getMetrics();
      expect(metrics.totalAttempts).toBe(0);
      expect(metrics.successfulAttempts).toBe(0);
      expect(metrics.totalRetryTime).toBe(0);
    });
  });

  describe('Configuration Management', () => {
    beforeEach(() => {
      retryPolicy = new RetryPolicy('test-retry', config);
    });

    it('should return configuration', () => {
      const retrievedConfig = retryPolicy.getConfig();
      expect(retrievedConfig.maxAttempts).toBe(config.maxAttempts);
      expect(retrievedConfig.baseDelay).toBe(config.baseDelay);
      expect(retrievedConfig.retryableErrors).toEqual(config.retryableErrors);
    });

    it('should update configuration', () => {
      const updates = {
        maxAttempts: 5,
        baseDelay: 2000
      };

      retryPolicy.updateConfig(updates);
      
      const newConfig = retryPolicy.getConfig();
      expect(newConfig.maxAttempts).toBe(5);
      expect(newConfig.baseDelay).toBe(2000);
    });

    it('should get retry policy name', () => {
      expect(retryPolicy.getName()).toBe('test-retry');
    });

    it('should get retry strategy', () => {
      expect(retryPolicy.getStrategy()).toBe(RetryStrategy.EXPONENTIAL_BACKOFF);
    });
  });

  describe('Callbacks', () => {
    it('should call onRetry callback', async () => {
      const onRetry = vi.fn();
      const configWithCallbacks = { ...config, onRetry };
      retryPolicy = new RetryPolicy('test-retry', configWithCallbacks);

      const operation = vi.fn()
        .mockRejectedValueOnce(new NetworkError('Fail'))
        .mockResolvedValue('success');

      const promise = retryPolicy.execute(operation);
      vi.runAllTimers();
      
      await promise;
      
      expect(onRetry).toHaveBeenCalledWith(
        1, // attempt number
        expect.any(Error),
        expect.any(Number) // delay
      );
    });

    it('should call onSuccess callback', async () => {
      const onSuccess = vi.fn();
      const configWithCallbacks = { ...config, onSuccess };
      retryPolicy = new RetryPolicy('test-retry', configWithCallbacks);

      const operation = vi.fn().mockResolvedValue('success');
      await retryPolicy.execute(operation);
      
      expect(onSuccess).toHaveBeenCalledWith(
        1, // attempt number
        expect.any(Number) // total time
      );
    });

    it('should call onFailure callback', async () => {
      const onFailure = vi.fn();
      const configWithCallbacks = { ...config, onFailure };
      retryPolicy = new RetryPolicy('test-retry', configWithCallbacks);

      const operation = vi.fn().mockRejectedValue(new NetworkError('Persistent fail'));

      const promise = retryPolicy.execute(operation);
      vi.runAllTimers();
      
      await promise;
      
      expect(onFailure).toHaveBeenCalledWith(
        config.maxAttempts, // total attempts
        expect.any(Error), // final error
        expect.any(Number) // total time
      );
    });
  });

  describe('Predefined Policies', () => {
    it('should create network retry policy', () => {
      const networkPolicy = RetryPolicy.createNetworkRetryPolicy('network-test');
      
      expect(networkPolicy.getName()).toBe('network-test');
      
      const config = networkPolicy.getConfig();
      expect(config.maxAttempts).toBe(3);
      expect(config.retryableErrors).toContain('NETWORK_ERROR');
      expect(config.retryableErrors).toContain('TIMEOUT_ERROR');
    });

    it('should create aggressive retry policy', () => {
      const aggressivePolicy = RetryPolicy.createAggressiveRetryPolicy('aggressive-test');
      
      const config = aggressivePolicy.getConfig();
      expect(config.maxAttempts).toBe(5);
      expect(config.baseDelay).toBe(500);
      expect(config.retryableErrors).toContain('RATE_LIMIT_ERROR');
    });

    it('should create conservative retry policy', () => {
      const conservativePolicy = RetryPolicy.createConservativeRetryPolicy('conservative-test');
      
      const config = conservativePolicy.getConfig();
      expect(config.maxAttempts).toBe(2);
      expect(config.baseDelay).toBe(2000);
      expect(config.jitter).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero max attempts', async () => {
      const zeroAttemptsConfig = { ...config, maxAttempts: 0 };
      retryPolicy = new RetryPolicy('test-retry', zeroAttemptsConfig);

      const operation = vi.fn().mockResolvedValue('success');
      
      const result = await retryPolicy.execute(operation);
      
      expect(result.isFailure()).toBe(true);
      expect(operation).not.toHaveBeenCalled();
    });

    it('should handle one max attempt', async () => {
      const oneAttemptConfig = { ...config, maxAttempts: 1 };
      retryPolicy = new RetryPolicy('test-retry', oneAttemptConfig);

      const operation = vi.fn().mockRejectedValue(new NetworkError('Fail'));
      
      const result = await retryPolicy.execute(operation);
      
      expect(result.isFailure()).toBe(true);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should handle operations that return falsy values', async () => {
      const operation = vi.fn().mockResolvedValue(null);
      
      const result = await retryPolicy.execute(operation);
      
      expect(result.isSuccess()).toBe(true);
      expect(result.getValue()).toBe(null);
    });

    it('should handle operations that throw non-Error objects', async () => {
      const operation = vi.fn().mockImplementation(() => {
        throw 'String error';
      });
      
      const result = await retryPolicy.execute(operation);
      
      expect(result.isFailure()).toBe(true);
      expect(result.getError().message).toContain('String error');
    });
  });
});