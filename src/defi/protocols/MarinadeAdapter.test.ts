import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { Chain, AssetType } from '@cygnus-wealth/data-models';
import { MarinadeAdapter, MSOL_MINT, MARINADE_FINANCE_PROGRAM_ID, MARINADE_STATE_ADDRESS } from './MarinadeAdapter';

// Mock @solana/web3.js
vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual('@solana/web3.js');
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getTokenAccountsByOwner: vi.fn(),
      getAccountInfo: vi.fn(),
    })),
  };
});

describe('MarinadeAdapter', () => {
  let adapter: MarinadeAdapter;
  let mockConnection: any;
  const testAddress = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';

  beforeEach(() => {
    mockConnection = {
      getTokenAccountsByOwner: vi.fn(),
      getAccountInfo: vi.fn(),
    };
    adapter = new MarinadeAdapter({ connection: mockConnection as unknown as Connection });
  });

  describe('protocol metadata', () => {
    it('should have correct protocol name', () => {
      expect(adapter.protocolName).toBe('Marinade Finance');
    });

    it('should export correct program ID', () => {
      expect(MARINADE_FINANCE_PROGRAM_ID.toBase58()).toBe(
        'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD',
      );
    });

    it('should export correct mSOL mint', () => {
      expect(MSOL_MINT.toBase58()).toBe(
        'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
      );
    });
  });

  describe('getStakedPositions', () => {
    it('should return empty array when no mSOL accounts found', async () => {
      mockConnection.getTokenAccountsByOwner.mockResolvedValue({ value: [] });

      const positions = await adapter.getStakedPositions(testAddress);

      expect(positions).toHaveLength(0);
      expect(mockConnection.getTokenAccountsByOwner).toHaveBeenCalledWith(
        expect.any(PublicKey),
        { mint: MSOL_MINT },
      );
    });

    it('should return staked positions with mSOL balance', async () => {
      // Create a mock SPL token account buffer
      const tokenAccountData = Buffer.alloc(165);
      // Write mint address at offset 0
      MSOL_MINT.toBuffer().copy(tokenAccountData, 0);
      // Write amount (100.5 mSOL = 100500000000 lamports) at offset 64
      tokenAccountData.writeBigUInt64LE(100500000000n, 64);

      const accountPubkey = PublicKey.unique();

      mockConnection.getTokenAccountsByOwner.mockResolvedValue({
        value: [
          {
            pubkey: accountPubkey,
            account: { data: tokenAccountData },
          },
        ],
      });

      // Mock exchange rate state account (matched by any getAccountInfo call)
      const stateData = Buffer.alloc(256);
      // Write total lamports at offset 72 (110 SOL worth)
      stateData.writeBigUInt64LE(110000000000n, 72);
      // Write mSOL supply at offset 64 (100 mSOL)
      stateData.writeBigUInt64LE(100000000000n, 64);

      mockConnection.getAccountInfo.mockImplementation(async () => ({
        data: stateData,
      }));

      const positions = await adapter.getStakedPositions(testAddress);

      expect(positions).toHaveLength(1);
      expect(positions[0].protocol).toBe('Marinade Finance');
      expect(positions[0].chain).toBe(Chain.SOLANA);
      expect(positions[0].asset.symbol).toBe('mSOL');
      expect(positions[0].asset.type).toBe(AssetType.STAKED_POSITION);
      expect(parseFloat(positions[0].stakedAmount)).toBeCloseTo(100.5, 1);
      expect(positions[0].metadata?.['marinade:exchangeRate']).toBeCloseTo(1.1, 1);
    });

    it('should skip zero-balance accounts', async () => {
      const tokenAccountData = Buffer.alloc(165);
      MSOL_MINT.toBuffer().copy(tokenAccountData, 0);
      tokenAccountData.writeBigUInt64LE(0n, 64);

      mockConnection.getTokenAccountsByOwner.mockResolvedValue({
        value: [
          {
            pubkey: PublicKey.unique(),
            account: { data: tokenAccountData },
          },
        ],
      });

      mockConnection.getAccountInfo.mockResolvedValue({ data: Buffer.alloc(256) });

      const positions = await adapter.getStakedPositions(testAddress);

      expect(positions).toHaveLength(0);
    });

    it('should handle RPC errors gracefully', async () => {
      mockConnection.getTokenAccountsByOwner.mockRejectedValue(
        new Error('RPC connection failed'),
      );

      const positions = await adapter.getStakedPositions(testAddress);

      expect(positions).toHaveLength(0);
    });
  });

  describe('getMsolExchangeRate', () => {
    it('should calculate exchange rate from state account', async () => {
      const stateData = Buffer.alloc(256);
      stateData.writeBigUInt64LE(115000000000n, 72); // 115 SOL total
      stateData.writeBigUInt64LE(100000000000n, 64); // 100 mSOL supply

      mockConnection.getAccountInfo.mockImplementation(async () => ({ data: stateData }));

      const rate = await adapter.getMsolExchangeRate();

      expect(mockConnection.getAccountInfo).toHaveBeenCalled();
      expect(rate).toBeCloseTo(1.15, 2);
    });

    it('should return 1.0 when state account is unavailable', async () => {
      mockConnection.getAccountInfo.mockImplementation(async () => null);

      const rate = await adapter.getMsolExchangeRate();

      expect(rate).toBe(1.0);
    });

    it('should return 1.0 when mSOL supply is zero', async () => {
      const stateData = Buffer.alloc(256);
      stateData.writeBigUInt64LE(0n, 72);
      stateData.writeBigUInt64LE(0n, 64);

      mockConnection.getAccountInfo.mockImplementation(async () => ({ data: stateData }));

      const rate = await adapter.getMsolExchangeRate();

      expect(rate).toBe(1.0);
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
