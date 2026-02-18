import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { Chain } from '@cygnus-wealth/data-models';
import { OrcaAdapter, ORCA_WHIRLPOOL_PROGRAM_ID } from './OrcaAdapter';

vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual('@solana/web3.js');
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getProgramAccounts: vi.fn(),
    })),
  };
});

describe('OrcaAdapter', () => {
  let adapter: OrcaAdapter;
  let mockConnection: any;
  const testAddress = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';

  beforeEach(() => {
    mockConnection = {
      getProgramAccounts: vi.fn().mockResolvedValue([]),
    };
    adapter = new OrcaAdapter({ connection: mockConnection as unknown as Connection });
  });

  describe('protocol metadata', () => {
    it('should have correct protocol name', () => {
      expect(adapter.protocolName).toBe('Orca');
    });

    it('should export correct Whirlpool program ID', () => {
      expect(ORCA_WHIRLPOOL_PROGRAM_ID.toBase58()).toBe(
        'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
      );
    });
  });

  describe('getLiquidityPositions', () => {
    it('should return empty array when no whirlpool positions found', async () => {
      const positions = await adapter.getLiquidityPositions(testAddress);

      expect(positions).toHaveLength(0);
    });

    it('should return whirlpool positions with tick range data', async () => {
      const whirlpool = PublicKey.unique();
      const positionMint = PublicKey.unique();
      const positionPubkey = PublicKey.unique();

      // Create position account data (216 bytes)
      const positionData = Buffer.alloc(216);
      // Write whirlpool pubkey at offset 8
      whirlpool.toBuffer().copy(positionData, 8);
      // Write position mint at offset 40
      positionMint.toBuffer().copy(positionData, 40);
      // Write liquidity at offset 72 (u128 as two u64s)
      positionData.writeBigUInt64LE(50000000000n, 72); // low
      positionData.writeBigUInt64LE(0n, 80); // high
      // Write tick_lower_index at offset 88
      positionData.writeInt32LE(-10000, 88);
      // Write tick_upper_index at offset 92
      positionData.writeInt32LE(10000, 92);

      mockConnection.getProgramAccounts.mockResolvedValue([
        { pubkey: positionPubkey, account: { data: positionData } },
      ]);

      const positions = await adapter.getLiquidityPositions(testAddress);

      expect(positions).toHaveLength(1);
      expect(positions[0].protocol).toBe('Orca');
      expect(positions[0].chain).toBe(Chain.SOLANA);
      expect(positions[0].poolAddress).toBe(whirlpool.toBase58());
      expect(positions[0].metadata?.['orca:positionType']).toBe('CONCENTRATED_LIQUIDITY');
      expect(positions[0].metadata?.['orca:tickLowerIndex']).toBe(-10000);
      expect(positions[0].metadata?.['orca:tickUpperIndex']).toBe(10000);
      expect(positions[0].metadata?.['orca:positionMint']).toBe(positionMint.toBase58());
      expect(positions[0].lpTokenBalance).toBe('50000000000');
    });

    it('should skip positions with zero liquidity', async () => {
      const positionData = Buffer.alloc(216);
      PublicKey.unique().toBuffer().copy(positionData, 8);
      PublicKey.unique().toBuffer().copy(positionData, 40);
      // Zero liquidity
      positionData.writeBigUInt64LE(0n, 72);
      positionData.writeBigUInt64LE(0n, 80);

      mockConnection.getProgramAccounts.mockResolvedValue([
        { pubkey: PublicKey.unique(), account: { data: positionData } },
      ]);

      const positions = await adapter.getLiquidityPositions(testAddress);

      expect(positions).toHaveLength(0);
    });

    it('should handle multiple positions', async () => {
      const createPositionData = (liquidity: bigint, tickLower: number, tickUpper: number) => {
        const data = Buffer.alloc(216);
        PublicKey.unique().toBuffer().copy(data, 8);
        PublicKey.unique().toBuffer().copy(data, 40);
        data.writeBigUInt64LE(liquidity, 72);
        data.writeBigUInt64LE(0n, 80);
        data.writeInt32LE(tickLower, 88);
        data.writeInt32LE(tickUpper, 92);
        return data;
      };

      mockConnection.getProgramAccounts.mockResolvedValue([
        {
          pubkey: PublicKey.unique(),
          account: { data: createPositionData(1000000n, -5000, 5000) },
        },
        {
          pubkey: PublicKey.unique(),
          account: { data: createPositionData(2000000n, -20000, 20000) },
        },
      ]);

      const positions = await adapter.getLiquidityPositions(testAddress);

      expect(positions).toHaveLength(2);
      expect(positions[0].metadata?.['orca:tickLowerIndex']).toBe(-5000);
      expect(positions[1].metadata?.['orca:tickLowerIndex']).toBe(-20000);
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
