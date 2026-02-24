/**
 * Fallback Error Suppression Tests
 *
 * Verifies that:
 * 1. Dead/unreachable RPC endpoints (DNS failures) are properly classified as network errors
 * 2. Fallback chain resilience callbacks log at debug level, not warn/error
 * 3. Production default URL is a working endpoint, not a placeholder
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NETWORK_CONFIGS, getDefaultEndpoints } from '../../config/networks';
import { NetworkError } from '../../domain/shared/DomainError';
import { SolanaConnectionAdapter } from '../../infrastructure/connection/SolanaConnectionAdapter';

// Store mock connection for test access
let latestMockConnection: any = null;

// Mock @solana/web3.js so we don't make real connections
vi.mock('@solana/web3.js', () => {
  const MockConnection = vi.fn().mockImplementation((url: string) => {
    const conn = {
      rpcEndpoint: url,
      getSlot: vi.fn().mockResolvedValue(123456789),
      getBalance: vi.fn().mockResolvedValue(1000000),
      getVersion: vi.fn().mockResolvedValue({ 'solana-core': '1.17.0' }),
    };
    latestMockConnection = conn;
    return conn;
  });
  return {
    Connection: MockConnection,
    PublicKey: vi.fn().mockImplementation((key: string) => ({
      toBase58: () => key,
      toBuffer: () => Buffer.from(key),
      toString: () => key,
    })),
    TOKEN_PROGRAM_ID: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    TOKEN_2022_PROGRAM_ID: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  };
});

vi.mock('@solana/spl-token', () => ({
  TOKEN_PROGRAM_ID: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN_2022_PROGRAM_ID: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
}));

describe('Production RPC defaults', () => {
  it('should have a working production URL, not a placeholder', () => {
    const config = NETWORK_CONFIGS.production;
    expect(config.clusterUrl).not.toContain('placeholder');
    expect(config.clusterUrl).toMatch(/^https:\/\//);
  });

  it('should return valid default endpoints for production', () => {
    const endpoints = getDefaultEndpoints('production');
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).not.toContain('placeholder');
    expect(endpoints[0]).toMatch(/^https:\/\//);
  });

  it('should not reference dead Pocket Network endpoints', () => {
    const config = NETWORK_CONFIGS.production;
    expect(config.clusterUrl).not.toContain('pokt.network');
    expect(config.clusterUrl).not.toContain('gateway.pokt');
  });
});

describe('DNS error classification', () => {
  // Import after mock setup so we get the mocked Connection
  let SolanaConnectionAdapter: typeof import('../../infrastructure/connection/SolanaConnectionAdapter').SolanaConnectionAdapter;

  beforeEach(async () => {
    const mod = await import('../../infrastructure/connection/SolanaConnectionAdapter');
    SolanaConnectionAdapter = mod.SolanaConnectionAdapter;
  });

  it('should classify ENOTFOUND as a network error', async () => {
    const adapter = new SolanaConnectionAdapter({
      endpoint: 'https://dead-rpc.example.com',
      enableRetries: false,
      enableCircuitBreaker: false,
    });
    latestMockConnection.getSlot = vi.fn().mockRejectedValue(
      new Error('getaddrinfo ENOTFOUND solana-mainnet.gateway.pokt.network')
    );

    const result = await adapter.getSlot();
    expect(result.isFailure).toBe(true);
    const error = result.getError();
    expect(error).toBeInstanceOf(NetworkError);
  });

  it('should classify ERR_NAME_NOT_RESOLVED as a network error', async () => {
    const adapter = new SolanaConnectionAdapter({
      endpoint: 'https://dead-rpc.example.com',
      enableRetries: false,
      enableCircuitBreaker: false,
    });
    latestMockConnection.getSlot = vi.fn().mockRejectedValue(
      new Error('ERR_NAME_NOT_RESOLVED')
    );

    const result = await adapter.getSlot();
    expect(result.isFailure).toBe(true);
    const error = result.getError();
    expect(error).toBeInstanceOf(NetworkError);
  });

  it('should classify DNS lookup failure as a network error', async () => {
    const adapter = new SolanaConnectionAdapter({
      endpoint: 'https://dead-rpc.example.com',
      enableRetries: false,
      enableCircuitBreaker: false,
    });
    latestMockConnection.getSlot = vi.fn().mockRejectedValue(
      new Error('DNS lookup failed for solana-mainnet.gateway.pokt.network')
    );

    const result = await adapter.getSlot();
    expect(result.isFailure).toBe(true);
    const error = result.getError();
    expect(error).toBeInstanceOf(NetworkError);
  });
});

describe('Fallback resilience logging', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let SolanaConnectionAdapterClass: typeof import('../../infrastructure/connection/SolanaConnectionAdapter').SolanaConnectionAdapter;

  beforeEach(async () => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await import('../../infrastructure/connection/SolanaConnectionAdapter');
    SolanaConnectionAdapterClass = mod.SolanaConnectionAdapter;
  });

  afterEach(() => {
    debugSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('should log circuit breaker state changes at debug level, not warn', async () => {
    const adapter = new SolanaConnectionAdapterClass({
      endpoint: 'https://test-rpc.example.com',
      enableRetries: false,
      enableCircuitBreaker: true,
      circuitBreakerConfig: {
        failureThreshold: 1,
        recoveryTimeout: 100,
        successThreshold: 1,
      },
    });

    // Trigger a failure to cause circuit breaker state change
    latestMockConnection.getSlot = vi.fn().mockRejectedValue(
      new Error('ENOTFOUND test-rpc.example.com')
    );
    await adapter.getSlot();

    // Circuit breaker messages should go to debug, not warn
    const cbWarnMessages = warnSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('Circuit breaker')
    );
    expect(cbWarnMessages).toHaveLength(0);
  });

  it('should log retry attempts at debug level, not warn', async () => {
    const adapter = new SolanaConnectionAdapterClass({
      endpoint: 'https://test-rpc.example.com',
      enableRetries: true,
      enableCircuitBreaker: false,
      maxRetries: 2,
      retryBaseDelay: 1,
    });

    // Trigger failures to cause retries
    latestMockConnection.getSlot = vi.fn().mockRejectedValue(
      new Error('ENOTFOUND test-rpc.example.com')
    );
    await adapter.getSlot();

    // Retry messages should go to debug, not warn
    const retryWarnMessages = warnSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('Retry attempt')
    );
    expect(retryWarnMessages).toHaveLength(0);
  });

  it('should not emit console.warn or console.error during fallback', async () => {
    const adapter = new SolanaConnectionAdapterClass({
      endpoint: 'https://dead-pocket-network.example.com',
      enableRetries: false,
      enableCircuitBreaker: false,
    });

    latestMockConnection.getSlot = vi.fn().mockRejectedValue(
      new Error('getaddrinfo ENOTFOUND dead-pocket-network.example.com')
    );
    await adapter.getSlot();

    // No warn or error calls should come from the resilience layer
    const infraWarnMessages = warnSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && (
        call[0].includes('Circuit breaker') ||
        call[0].includes('Retry attempt') ||
        call[0].includes('dead-pocket-network')
      )
    );
    const infraErrorMessages = errorSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && (
        call[0].includes('Health check') ||
        call[0].includes('Recovery attempt')
      )
    );
    expect(infraWarnMessages).toHaveLength(0);
    expect(infraErrorMessages).toHaveLength(0);
  });
});
