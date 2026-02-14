/**
 * Circuit Breaker Tests
 * 
 * Comprehensive test suite for the Circuit Breaker implementation.
 * Tests circuit states, failure handling, and recovery mechanisms.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CircuitBreaker, CircuitState, CircuitBreakerConfig } from '../../infrastructure/resilience/CircuitBreaker';
import { DomainError } from '../../domain/shared/DomainError';

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker;
  let config: CircuitBreakerConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    
    config = {
      failureThreshold: 3,
      recoveryTimeout: 5000,
      successThreshold: 2,
      timeout: 1000,
      monitoringPeriod: 10000
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Circuit States', () => {
    beforeEach(() => {
      circuitBreaker = new CircuitBreaker('test-circuit', config);
    });

    it('should start in CLOSED state', () => {
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
      expect(circuitBreaker.isClosed()).toBe(true);
      expect(circuitBreaker.isOpen()).toBe(false);
      expect(circuitBreaker.isHalfOpen()).toBe(false);
    });

    it('should open after reaching failure threshold', async () => {
      const failingOperation = vi.fn().mockRejectedValue(new Error('Operation failed'));

      // Trigger failures to reach threshold
      for (let i = 0; i < config.failureThreshold; i++) {
        const result = await circuitBreaker.execute(failingOperation);
        expect(result.isFailure).toBe(true);
      }

      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
      expect(circuitBreaker.isOpen()).toBe(true);
    });

    it('should reject calls immediately when open', async () => {
      const operation = vi.fn().mockResolvedValue('success');
      
      // Force circuit open
      circuitBreaker.forceOpen('Manual test');
      
      const result = await circuitBreaker.execute(operation);
      expect(result.isFailure).toBe(true);
      expect(operation).not.toHaveBeenCalled();
    });

    it('should transition to HALF_OPEN after recovery timeout', async () => {
      const failingOperation = vi.fn().mockRejectedValue(new Error('Operation failed'));
      const successOperation = vi.fn().mockResolvedValue('success');

      // Open the circuit
      for (let i = 0; i < config.failureThreshold; i++) {
        await circuitBreaker.execute(failingOperation);
      }
      expect(circuitBreaker.isOpen()).toBe(true);

      // Advance time past recovery timeout
      vi.advanceTimersByTime(config.recoveryTimeout + 1000);

      // Next call should attempt to execute
      const result = await circuitBreaker.execute(successOperation);
      expect(circuitBreaker.getState()).toBe(CircuitState.HALF_OPEN);
      expect(result.isSuccess).toBe(true);
    });

    it('should close after successful operations in HALF_OPEN', async () => {
      const operation = vi.fn().mockResolvedValue('success');

      // Force to half-open state
      circuitBreaker.forceOpen('Test');
      vi.advanceTimersByTime(config.recoveryTimeout + 1000);

      // Execute successful operations to meet success threshold
      for (let i = 0; i < config.successThreshold; i++) {
        const result = await circuitBreaker.execute(operation);
        expect(result.isSuccess).toBe(true);
      }

      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
      expect(circuitBreaker.isClosed()).toBe(true);
    });

    it('should return to OPEN if failure occurs in HALF_OPEN', async () => {
      const failingOperation = vi.fn().mockRejectedValue(new Error('Still failing'));

      // Get to half-open state
      circuitBreaker.forceOpen('Test');
      vi.advanceTimersByTime(config.recoveryTimeout + 1000);

      // First call transitions to half-open, then failure should open again
      await circuitBreaker.execute(() => Promise.resolve('success'));
      expect(circuitBreaker.isHalfOpen()).toBe(true);

      const result = await circuitBreaker.execute(failingOperation);
      expect(result.isFailure).toBe(true);
      expect(circuitBreaker.isOpen()).toBe(true);
    });
  });

  describe('Operation Execution', () => {
    beforeEach(() => {
      circuitBreaker = new CircuitBreaker('test-circuit', config);
    });

    it('should execute operation successfully when closed', async () => {
      const operation = vi.fn().mockResolvedValue('test result');
      
      const result = await circuitBreaker.execute(operation);
      
      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toBe('test result');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should handle operation timeout', async () => {
      const slowOperation = vi.fn().mockImplementation(() =>
        new Promise(resolve => setTimeout(resolve, config.timeout + 1000))
      );

      const promise = circuitBreaker.execute(slowOperation);
      await vi.advanceTimersByTimeAsync(config.timeout + 100);
      const result = await promise;

      expect(result.isFailure).toBe(true);
      expect(result.getError().message).toContain('timed out');
    });

    it('should handle operation errors', async () => {
      const error = new Error('Operation error');
      const failingOperation = vi.fn().mockRejectedValue(error);

      const result = await circuitBreaker.execute(failingOperation);
      
      expect(result.isFailure).toBe(true);
      expect(result.getError().message).toContain('Operation error');
    });

    it('should execute fallback when circuit is open', async () => {
      const operation = vi.fn().mockResolvedValue('main result');
      const fallback = vi.fn().mockResolvedValue('fallback result');

      // Open the circuit
      circuitBreaker.forceOpen('Test');

      const result = await circuitBreaker.execute(operation, fallback);
      
      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toBe('fallback result');
      expect(operation).not.toHaveBeenCalled();
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    it('should return circuit breaker error if no fallback provided when open', async () => {
      const operation = vi.fn().mockResolvedValue('result');

      circuitBreaker.forceOpen('Test');

      const result = await circuitBreaker.execute(operation);
      
      expect(result.isFailure).toBe(true);
      expect(result.getError().code).toBe('CIRCUIT_BREAKER_OPEN');
    });
  });

  describe('Metrics and Monitoring', () => {
    beforeEach(() => {
      circuitBreaker = new CircuitBreaker('test-circuit', config);
    });

    it('should track metrics correctly', async () => {
      const successOperation = vi.fn().mockResolvedValue('success');
      const failOperation = vi.fn().mockRejectedValue(new Error('fail'));

      // Execute some operations
      await circuitBreaker.execute(successOperation);
      await circuitBreaker.execute(successOperation);
      await circuitBreaker.execute(failOperation);

      const metrics = circuitBreaker.getMetrics();
      
      expect(metrics.totalCalls).toBe(3);
      expect(metrics.successCount).toBe(2);
      expect(metrics.failureCount).toBe(1);
      expect(metrics.successRate).toBeCloseTo(66.67, 2);
      expect(metrics.failureRate).toBeCloseTo(33.33, 2);
    });

    it('should track execution times', async () => {
      const operation = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return 'success';
      });

      const promise = circuitBreaker.execute(operation);
      await vi.advanceTimersByTimeAsync(200);
      await promise;

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.averageExecutionTime).toBeGreaterThan(0);
    });

    it('should track state change times', async () => {
      const initialTime = circuitBreaker.getMetrics().stateChangeTime;

      // Advance time so state change has a different timestamp
      vi.advanceTimersByTime(1);

      // Force state change
      circuitBreaker.forceOpen('Test');

      const newTime = circuitBreaker.getMetrics().stateChangeTime;
      expect(newTime.getTime()).toBeGreaterThan(initialTime.getTime());
    });

    it('should calculate time until next attempt when open', () => {
      circuitBreaker.forceOpen('Test');
      
      const timeUntilNext = circuitBreaker.getTimeUntilNextAttempt();
      expect(timeUntilNext).toBeGreaterThan(0);
      expect(timeUntilNext).toBeLessThanOrEqual(config.recoveryTimeout);
    });

    it('should return 0 time until next attempt when not open', () => {
      expect(circuitBreaker.getTimeUntilNextAttempt()).toBe(0);
    });
  });

  describe('Configuration Management', () => {
    beforeEach(() => {
      circuitBreaker = new CircuitBreaker('test-circuit', config);
    });

    it('should return configuration', () => {
      const retrievedConfig = circuitBreaker.getConfig();
      expect(retrievedConfig.failureThreshold).toBe(config.failureThreshold);
      expect(retrievedConfig.recoveryTimeout).toBe(config.recoveryTimeout);
    });

    it('should update configuration', () => {
      const updates = {
        failureThreshold: 5,
        recoveryTimeout: 10000
      };

      circuitBreaker.updateConfig(updates);
      
      const newConfig = circuitBreaker.getConfig();
      expect(newConfig.failureThreshold).toBe(5);
      expect(newConfig.recoveryTimeout).toBe(10000);
    });

    it('should get circuit name', () => {
      expect(circuitBreaker.getName()).toBe('test-circuit');
    });
  });

  describe('Manual Control', () => {
    beforeEach(() => {
      circuitBreaker = new CircuitBreaker('test-circuit', config);
    });

    it('should force circuit open', () => {
      expect(circuitBreaker.isClosed()).toBe(true);
      
      circuitBreaker.forceOpen('Manual test');
      
      expect(circuitBreaker.isOpen()).toBe(true);
    });

    it('should force circuit closed', () => {
      circuitBreaker.forceOpen('Test');
      expect(circuitBreaker.isOpen()).toBe(true);
      
      circuitBreaker.forceClosed('Recovery test');
      
      expect(circuitBreaker.isClosed()).toBe(true);
    });

    it('should reset circuit to initial state', async () => {
      const failOperation = vi.fn().mockRejectedValue(new Error('fail'));

      // Generate some activity
      await circuitBreaker.execute(failOperation);
      await circuitBreaker.execute(failOperation);

      let metrics = circuitBreaker.getMetrics();
      expect(metrics.totalCalls).toBe(2);
      expect(metrics.failureCount).toBe(2);

      circuitBreaker.reset();

      metrics = circuitBreaker.getMetrics();
      expect(circuitBreaker.isClosed()).toBe(true);
      expect(metrics.totalCalls).toBe(0);
      expect(metrics.failureCount).toBe(0);
    });
  });

  describe('Callbacks', () => {
    it('should call state change callback', () => {
      const onStateChange = vi.fn();
      const configWithCallback = {
        ...config,
        onStateChange
      };

      circuitBreaker = new CircuitBreaker('test-circuit', configWithCallback);
      
      circuitBreaker.forceOpen('Test');
      
      expect(onStateChange).toHaveBeenCalledWith(
        CircuitState.CLOSED,
        CircuitState.OPEN,
        'Test'
      );
    });

    it('should call success callback', async () => {
      const onSuccess = vi.fn();
      const configWithCallback = {
        ...config,
        onSuccess
      };

      circuitBreaker = new CircuitBreaker('test-circuit', configWithCallback);
      
      const operation = vi.fn().mockResolvedValue('success');
      await circuitBreaker.execute(operation);
      
      expect(onSuccess).toHaveBeenCalledWith(expect.any(Number));
    });

    it('should call failure callback', async () => {
      const onFailure = vi.fn();
      const configWithCallback = {
        ...config,
        onFailure
      };

      circuitBreaker = new CircuitBreaker('test-circuit', configWithCallback);
      
      const operation = vi.fn().mockRejectedValue(new Error('fail'));
      await circuitBreaker.execute(operation);
      
      expect(onFailure).toHaveBeenCalledWith(
        expect.any(Error),
        expect.any(Number)
      );
    });
  });

  describe('Edge Cases', () => {
    beforeEach(() => {
      circuitBreaker = new CircuitBreaker('test-circuit', config);
    });

    it('should handle zero failure threshold', async () => {
      const zeroThresholdConfig = { ...config, failureThreshold: 0 };
      circuitBreaker = new CircuitBreaker('test-circuit', zeroThresholdConfig);

      const operation = vi.fn().mockRejectedValue(new Error('fail'));
      
      // Should open immediately on first failure
      await circuitBreaker.execute(operation);
      expect(circuitBreaker.isOpen()).toBe(true);
    });

    it('should handle zero success threshold in half-open', async () => {
      const zeroSuccessConfig = { ...config, successThreshold: 0 };
      circuitBreaker = new CircuitBreaker('test-circuit', zeroSuccessConfig);

      // Open and then transition to half-open
      circuitBreaker.forceOpen('Test');
      vi.advanceTimersByTime(config.recoveryTimeout + 1000);

      const operation = vi.fn().mockResolvedValue('success');
      
      // Should close immediately with zero success threshold
      await circuitBreaker.execute(operation);
      expect(circuitBreaker.isClosed()).toBe(true);
    });

    it('should handle operations that return undefined', async () => {
      const operation = vi.fn().mockResolvedValue(undefined);
      
      const result = await circuitBreaker.execute(operation);
      
      expect(result.isSuccess).toBe(true);
      expect(result.getValue()).toBeUndefined();
    });

    it('should handle operations that throw non-Error objects', async () => {
      const operation = vi.fn().mockRejectedValue('String error');

      const result = await circuitBreaker.execute(operation);

      expect(result.isFailure).toBe(true);
      expect(result.getError().message).toContain('String error');
    });
  });

  describe('Concurrent Operations', () => {
    beforeEach(() => {
      circuitBreaker = new CircuitBreaker('test-circuit', config);
    });

    it('should handle concurrent successful operations', async () => {
      const operation = vi.fn().mockResolvedValue('success');
      
      const promises = Array.from({ length: 10 }, () => 
        circuitBreaker.execute(operation)
      );
      
      const results = await Promise.all(promises);
      
      results.forEach(result => {
        expect(result.isSuccess).toBe(true);
      });
      
      expect(operation).toHaveBeenCalledTimes(10);
    });

    it('should handle concurrent failing operations', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('fail'));
      
      const promises = Array.from({ length: 5 }, () => 
        circuitBreaker.execute(operation)
      );
      
      const results = await Promise.all(promises);
      
      results.forEach(result => {
        expect(result.isFailure).toBe(true);
      });
      
      // Circuit should be open after threshold failures
      expect(circuitBreaker.isOpen()).toBe(true);
    });
  });
});