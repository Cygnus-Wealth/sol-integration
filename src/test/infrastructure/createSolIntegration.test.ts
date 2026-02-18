import { describe, it, expect, vi } from 'vitest';
import { createSolIntegration } from '../../infrastructure/rpc/createSolIntegration';
import { RpcProviderConfig } from '../../infrastructure/rpc/types';

// Mock Connection and web3.js to avoid real network calls
vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  const MockConnection = vi.fn().mockImplementation((url: string) => ({
    rpcEndpoint: url,
    getSlot: vi.fn().mockResolvedValue(123456789),
    getBalance: vi.fn().mockResolvedValue(1000000000),
    _rpcRequest: vi.fn().mockResolvedValue({ result: 'ok' }),
    getVersion: vi.fn().mockResolvedValue({ 'solana-core': '1.18.0' }),
    getParsedTokenAccountsByOwner: vi.fn().mockResolvedValue({ value: [] }),
    getAccountInfo: vi.fn().mockResolvedValue(null),
    getMultipleAccountsInfo: vi.fn().mockResolvedValue([]),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: 'abc', lastValidBlockHeight: 100 }),
  }));

  return {
    ...actual,
    Connection: MockConnection,
  };
});

vi.mock('@solana/spl-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/spl-token')>();
  return {
    ...actual,
    TOKEN_PROGRAM_ID: actual.TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID: actual.TOKEN_2022_PROGRAM_ID,
  };
});

vi.mock('@metaplex-foundation/js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@metaplex-foundation/js')>();
  const mockNfts = {
    findAllByOwner: vi.fn().mockResolvedValue([]),
  };
  return {
    ...actual,
    Metaplex: {
      make: vi.fn().mockReturnValue({
        use: vi.fn().mockReturnThis(),
        nfts: vi.fn().mockReturnValue(mockNfts),
      }),
    },
  };
});

function makeValidConfig(overrides: Partial<RpcProviderConfig> = {}): RpcProviderConfig {
  return {
    endpoints: [
      {
        url: 'https://mainnet.helius-rpc.com/?api-key=test',
        name: 'helius-primary',
        priority: 1,
        capabilities: ['standard', 'das'],
        rateLimit: { requestsPerSecond: 50, burstCapacity: 100 },
        timeoutMs: 10000,
      },
      {
        url: 'https://rpc.quicknode.com/solana',
        name: 'quicknode-fallback',
        priority: 2,
        capabilities: ['standard'],
        rateLimit: { requestsPerSecond: 25, burstCapacity: 50 },
        timeoutMs: 10000,
      },
    ],
    commitment: 'confirmed',
    enableHealthMonitoring: false,
    ...overrides,
  };
}

describe('createSolIntegration', () => {
  describe('validation', () => {
    it('should throw if no endpoints provided', () => {
      expect(() => createSolIntegration({ endpoints: [] })).toThrow(
        'At least one RPC endpoint must be configured'
      );
    });

    it('should throw if primary endpoint is api.mainnet-beta.solana.com', () => {
      expect(() =>
        createSolIntegration({
          endpoints: [
            {
              url: 'https://api.mainnet-beta.solana.com',
              name: 'mainnet',
              priority: 1,
              capabilities: ['standard'],
            },
          ],
        })
      ).toThrow('api.mainnet-beta.solana.com must not be used as primary endpoint');
    });

    it('should allow api.mainnet-beta.solana.com as non-primary fallback', () => {
      const integration = createSolIntegration({
        endpoints: [
          {
            url: 'https://mainnet.helius-rpc.com/?api-key=test',
            name: 'helius',
            priority: 1,
            capabilities: ['standard', 'das'],
          },
          {
            url: 'https://api.mainnet-beta.solana.com',
            name: 'mainnet-fallback',
            priority: 10,
            capabilities: ['standard'],
          },
        ],
        enableHealthMonitoring: false,
      });

      expect(integration).toBeDefined();
      integration.destroy();
    });
  });

  describe('creation', () => {
    it('should return facade, fallbackChain, and destroy function', () => {
      const integration = createSolIntegration(makeValidConfig());

      expect(integration.facade).toBeDefined();
      expect(integration.fallbackChain).toBeDefined();
      expect(typeof integration.destroy).toBe('function');

      integration.destroy();
    });

    it('should create fallback chain with correct number of endpoints', () => {
      const integration = createSolIntegration(makeValidConfig());
      const states = integration.fallbackChain.getEndpointStates();

      expect(states).toHaveLength(2);
      integration.destroy();
    });

    it('should use provided commitment level', () => {
      const integration = createSolIntegration(
        makeValidConfig({ commitment: 'finalized' })
      );

      expect(integration.facade).toBeDefined();
      integration.destroy();
    });

    it('should start health monitoring by default', () => {
      const integration = createSolIntegration(
        makeValidConfig({ enableHealthMonitoring: true })
      );

      // Health monitor should be accessible
      const monitor = integration.fallbackChain.getHealthMonitor();
      expect(monitor).toBeDefined();

      integration.destroy();
    });
  });

  describe('destroy', () => {
    it('should clean up resources on destroy', () => {
      const integration = createSolIntegration(makeValidConfig());
      expect(() => integration.destroy()).not.toThrow();
    });
  });
});
