import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { Chain, AssetType } from '@cygnus-wealth/data-models';
import {
  JupiterAdapter,
  JUPITER_DCA_PROGRAM_ID,
  JUPITER_LIMIT_ORDER_PROGRAM_ID,
  JUPITER_PERPS_PROGRAM_ID,
} from './JupiterAdapter';

vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual('@solana/web3.js');
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getProgramAccounts: vi.fn(),
    })),
  };
});

describe('JupiterAdapter', () => {
  let adapter: JupiterAdapter;
  let mockConnection: any;
  const testAddress = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';
  const testOwner = new PublicKey(testAddress);

  beforeEach(() => {
    mockConnection = {
      getProgramAccounts: vi.fn().mockResolvedValue([]),
    };
    adapter = new JupiterAdapter({ connection: mockConnection as unknown as Connection });
  });

  describe('protocol metadata', () => {
    it('should have correct protocol name', () => {
      expect(adapter.protocolName).toBe('Jupiter');
    });

    it('should export correct DCA program ID', () => {
      expect(JUPITER_DCA_PROGRAM_ID.toBase58()).toBe(
        'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M',
      );
    });

    it('should export correct limit order program ID', () => {
      expect(JUPITER_LIMIT_ORDER_PROGRAM_ID.toBase58()).toBe(
        'jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu',
      );
    });

    it('should export correct perps program ID', () => {
      expect(JUPITER_PERPS_PROGRAM_ID.toBase58()).toBe(
        'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu',
      );
    });
  });

  describe('getStakedPositions', () => {
    it('should return empty array when no DCA or limit orders exist', async () => {
      const positions = await adapter.getStakedPositions(testAddress);

      expect(positions).toHaveLength(0);
    });

    it('should return DCA positions', async () => {
      const inputMint = PublicKey.unique();
      const outputMint = PublicKey.unique();
      const dcaPubkey = PublicKey.unique();

      // Create DCA account data (296 bytes)
      const dcaData = Buffer.alloc(296);
      // Write discriminator (8 bytes)
      // Write owner at offset 8
      testOwner.toBuffer().copy(dcaData, 8);
      // Write input mint at offset 40
      inputMint.toBuffer().copy(dcaData, 40);
      // Write output mint at offset 72
      outputMint.toBuffer().copy(dcaData, 72);
      // Write inDeposited at offset 104 (1000 tokens)
      dcaData.writeBigUInt64LE(1000000000n, 104);
      // Write inWithdrawn at offset 112 (300 tokens already used)
      dcaData.writeBigUInt64LE(300000000n, 112);
      // Write inAmountPerCycle at offset 136
      dcaData.writeBigUInt64LE(100000000n, 136);
      // Write cycleFrequency at offset 144 (86400 = daily)
      dcaData.writeBigInt64LE(86400n, 144);

      mockConnection.getProgramAccounts
        .mockResolvedValueOnce([
          { pubkey: dcaPubkey, account: { data: dcaData } },
        ])
        .mockResolvedValueOnce([]); // No limit orders

      const positions = await adapter.getStakedPositions(testAddress);

      expect(positions).toHaveLength(1);
      expect(positions[0].protocol).toBe('Jupiter');
      expect(positions[0].chain).toBe(Chain.SOLANA);
      expect(positions[0].metadata?.['jupiter:positionType']).toBe('DCA');
      expect(positions[0].stakedAmount).toBe('700000000');
      expect(positions[0].metadata?.['jupiter:cycleFrequency']).toBe(86400);
    });

    it('should return limit order positions', async () => {
      const inputMint = PublicKey.unique();
      const outputMint = PublicKey.unique();
      const orderPubkey = PublicKey.unique();

      // Create limit order account data (372 bytes)
      const orderData = Buffer.alloc(372);
      testOwner.toBuffer().copy(orderData, 8);
      inputMint.toBuffer().copy(orderData, 40);
      outputMint.toBuffer().copy(orderData, 72);
      // Write makingAmount at offset 104
      orderData.writeBigUInt64LE(5000000000n, 104);
      // Write takingAmount at offset 112
      orderData.writeBigUInt64LE(25000000000n, 112);

      mockConnection.getProgramAccounts
        .mockResolvedValueOnce([]) // No DCA
        .mockResolvedValueOnce([
          { pubkey: orderPubkey, account: { data: orderData } },
        ]);

      const positions = await adapter.getStakedPositions(testAddress);

      expect(positions).toHaveLength(1);
      expect(positions[0].metadata?.['jupiter:positionType']).toBe('LIMIT_ORDER');
      expect(positions[0].stakedAmount).toBe('5000000000');
    });

    it('should skip DCA positions with zero remaining amount', async () => {
      const dcaData = Buffer.alloc(296);
      testOwner.toBuffer().copy(dcaData, 8);
      PublicKey.unique().toBuffer().copy(dcaData, 40);
      PublicKey.unique().toBuffer().copy(dcaData, 72);
      // inDeposited == inWithdrawn (fully executed)
      dcaData.writeBigUInt64LE(1000000000n, 104);
      dcaData.writeBigUInt64LE(1000000000n, 112);

      mockConnection.getProgramAccounts
        .mockResolvedValueOnce([
          { pubkey: PublicKey.unique(), account: { data: dcaData } },
        ])
        .mockResolvedValueOnce([]);

      const positions = await adapter.getStakedPositions(testAddress);

      expect(positions).toHaveLength(0);
    });

    it('should handle RPC errors gracefully', async () => {
      mockConnection.getProgramAccounts.mockRejectedValue(
        new Error('RPC connection failed'),
      );

      const positions = await adapter.getStakedPositions(testAddress);

      expect(positions).toHaveLength(0);
    });
  });

  describe('unimplemented methods', () => {
    it('should return empty lending positions', async () => {
      const positions = await adapter.getLendingPositions(testAddress);
      expect(positions).toEqual([]);
    });

    it('should return empty liquidity positions', async () => {
      const positions = await adapter.getLiquidityPositions(testAddress);
      expect(positions).toEqual([]);
    });
  });
});
