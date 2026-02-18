import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { Chain, AssetType } from '@cygnus-wealth/data-models';
import { RaydiumAdapter, RAYDIUM_AMM_PROGRAM_ID } from './RaydiumAdapter';

vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual('@solana/web3.js');
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getProgramAccounts: vi.fn(),
      getTokenAccountsByOwner: vi.fn(),
    })),
  };
});

describe('RaydiumAdapter', () => {
  let adapter: RaydiumAdapter;
  let mockConnection: any;
  const testAddress = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';

  beforeEach(() => {
    mockConnection = {
      getProgramAccounts: vi.fn(),
      getTokenAccountsByOwner: vi.fn(),
    };
    adapter = new RaydiumAdapter({ connection: mockConnection as unknown as Connection });
  });

  describe('protocol metadata', () => {
    it('should have correct protocol name', () => {
      expect(adapter.protocolName).toBe('Raydium');
    });

    it('should export correct AMM program ID', () => {
      expect(RAYDIUM_AMM_PROGRAM_ID.toBase58()).toBe(
        '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      );
    });
  });

  describe('getLiquidityPositions', () => {
    it('should return empty array when no LP positions found', async () => {
      mockConnection.getProgramAccounts.mockResolvedValue([]);
      mockConnection.getTokenAccountsByOwner.mockResolvedValue({ value: [] });

      const positions = await adapter.getLiquidityPositions(testAddress);

      expect(positions).toHaveLength(0);
    });

    it('should return LP positions when user holds LP tokens', async () => {
      // Create mock pool data (752 bytes)
      const poolData = Buffer.alloc(752);
      const lpMint = PublicKey.unique();
      const coinMint = PublicKey.unique();
      const pcMint = PublicKey.unique();
      const poolPubkey = PublicKey.unique();

      // Write LP mint at offset 128
      lpMint.toBuffer().copy(poolData, 128);
      // Write coin mint at offset 400
      coinMint.toBuffer().copy(poolData, 400);
      // Write pc mint at offset 432
      pcMint.toBuffer().copy(poolData, 432);
      // Write coin reserve at offset 224 (1000 tokens)
      poolData.writeBigUInt64LE(1000000000n, 224);
      // Write pc reserve at offset 232 (5000 tokens)
      poolData.writeBigUInt64LE(5000000000n, 232);
      // Write LP supply at offset 240 (100 LP tokens)
      poolData.writeBigUInt64LE(100000000000n, 240);

      mockConnection.getProgramAccounts.mockResolvedValue([
        { pubkey: poolPubkey, account: { data: poolData } },
      ]);

      // Create mock user LP token account (165 bytes SPL token)
      const tokenData = Buffer.alloc(165);
      lpMint.toBuffer().copy(tokenData, 0);
      tokenData.writeBigUInt64LE(10000000000n, 64); // 10 LP tokens

      mockConnection.getTokenAccountsByOwner.mockResolvedValue({
        value: [
          { pubkey: PublicKey.unique(), account: { data: tokenData } },
        ],
      });

      const positions = await adapter.getLiquidityPositions(testAddress);

      expect(positions).toHaveLength(1);
      expect(positions[0].protocol).toBe('Raydium');
      expect(positions[0].chain).toBe(Chain.SOLANA);
      expect(positions[0].tokens).toHaveLength(2);
      expect(positions[0].share).toBeCloseTo(0.1, 2);
      expect(positions[0].metadata?.['raydium:lpMint']).toBe(lpMint.toBase58());
    });

    it('should skip pools where user has no LP balance', async () => {
      const poolData = Buffer.alloc(752);
      const lpMint = PublicKey.unique();
      lpMint.toBuffer().copy(poolData, 128);

      mockConnection.getProgramAccounts.mockResolvedValue([
        { pubkey: PublicKey.unique(), account: { data: poolData } },
      ]);

      mockConnection.getTokenAccountsByOwner.mockResolvedValue({ value: [] });

      const positions = await adapter.getLiquidityPositions(testAddress);

      expect(positions).toHaveLength(0);
    });

    it('should handle RPC errors gracefully', async () => {
      mockConnection.getProgramAccounts.mockRejectedValue(
        new Error('RPC connection failed'),
      );

      const positions = await adapter.getLiquidityPositions(testAddress);

      expect(positions).toHaveLength(0);
    });
  });

  describe('unimplemented methods', () => {
    it('should return empty lending positions', async () => {
      const positions = await adapter.getLendingPositions(testAddress);
      expect(positions).toEqual([]);
    });

    it('should return empty staked positions', async () => {
      const positions = await adapter.getStakedPositions(testAddress);
      expect(positions).toEqual([]);
    });
  });
});
