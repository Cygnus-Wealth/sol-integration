import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Chain,
  AssetType,
  StakedPosition,
  LiquidityPosition,
} from '@cygnus-wealth/data-models';
import { DeFiService } from './DeFiService';
import { ISolanaDeFiProtocol } from './types';

describe('DeFiService', () => {
  let service: DeFiService;
  let mockProtocol1: ISolanaDeFiProtocol;
  let mockProtocol2: ISolanaDeFiProtocol;
  const testAddress = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';

  const mockStakedPosition: StakedPosition = {
    id: 'marinade-msol-1',
    protocol: 'Marinade Finance',
    chain: Chain.SOLANA,
    asset: {
      id: 'solana-msol',
      symbol: 'mSOL',
      name: 'Marinade Staked SOL',
      type: AssetType.STAKED_POSITION,
      decimals: 9,
      chain: Chain.SOLANA,
    },
    stakedAmount: '100.5',
    rewards: [],
    apr: 6.8,
  };

  const mockLiquidityPosition: LiquidityPosition = {
    id: 'raydium-sol-usdc-1',
    protocol: 'Raydium',
    poolAddress: 'FakePoolAddress11111111111111111111111111111',
    poolName: 'SOL/USDC',
    chain: Chain.SOLANA,
    tokens: [],
  };

  beforeEach(() => {
    mockProtocol1 = {
      protocolName: 'Marinade Finance',
      getLendingPositions: vi.fn().mockResolvedValue([]),
      getStakedPositions: vi.fn().mockResolvedValue([mockStakedPosition]),
      getLiquidityPositions: vi.fn().mockResolvedValue([]),
    };

    mockProtocol2 = {
      protocolName: 'Raydium',
      getLendingPositions: vi.fn().mockResolvedValue([]),
      getStakedPositions: vi.fn().mockResolvedValue([]),
      getLiquidityPositions: vi.fn().mockResolvedValue([mockLiquidityPosition]),
    };

    service = new DeFiService([mockProtocol1, mockProtocol2]);
  });

  afterEach(() => {
    service.destroy();
  });

  describe('constructor', () => {
    it('should initialize with protocols', () => {
      expect(service).toBeDefined();
    });

    it('should accept custom config', () => {
      const customService = new DeFiService([mockProtocol1], {
        enableCache: false,
        cacheTTL: 120000,
      });
      expect(customService).toBeDefined();
      customService.destroy();
    });
  });

  describe('getDeFiPositions', () => {
    it('should aggregate positions from all protocols', async () => {
      const result = await service.getDeFiPositions([testAddress]);

      expect(result.stakedPositions).toHaveLength(1);
      expect(result.stakedPositions[0]).toEqual(mockStakedPosition);

      expect(result.liquidityPositions).toHaveLength(1);
      expect(result.liquidityPositions[0]).toEqual(mockLiquidityPosition);

      expect(result.lendingPositions).toHaveLength(0);
    });

    it('should validate addresses', async () => {
      await expect(
        service.getDeFiPositions(['invalid-address']),
      ).rejects.toThrow();
    });

    it('should handle protocol errors gracefully', async () => {
      (mockProtocol1.getStakedPositions as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('Protocol error'));

      const result = await service.getDeFiPositions([testAddress]);

      // Should still return positions from working protocol
      expect(result.liquidityPositions).toHaveLength(1);
      // Failed protocol's positions should not appear
      expect(result.stakedPositions).toHaveLength(0);
    });

    it('should fetch positions for multiple addresses', async () => {
      const testAddress2 = '7VHS8XAGP3ohBodZXpSLJpqJvjE5p5rWjGXFpRqc9gBU';

      const result = await service.getDeFiPositions([testAddress, testAddress2]);

      // Each address queries all protocols
      expect(mockProtocol1.getStakedPositions).toHaveBeenCalledTimes(2);
      expect(mockProtocol2.getLiquidityPositions).toHaveBeenCalledTimes(2);

      // Positions are aggregated across addresses
      expect(result.stakedPositions).toHaveLength(2);
      expect(result.liquidityPositions).toHaveLength(2);
    });

    it('should merge positions from multiple protocols', async () => {
      const extraStakedPosition: StakedPosition = {
        ...mockStakedPosition,
        id: 'marinade-msol-2',
        stakedAmount: '50.0',
      };

      (mockProtocol1.getStakedPositions as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([mockStakedPosition, extraStakedPosition]);

      const result = await service.getDeFiPositions([testAddress]);

      expect(result.stakedPositions).toHaveLength(2);
    });
  });

  describe('caching', () => {
    it('should cache positions and return cached on second call', async () => {
      await service.getDeFiPositions([testAddress]);
      await service.getDeFiPositions([testAddress]);

      // Protocol should only be called once (second was cached)
      expect(mockProtocol1.getStakedPositions).toHaveBeenCalledTimes(1);
      expect(mockProtocol2.getLiquidityPositions).toHaveBeenCalledTimes(1);
    });

    it('should bypass cache when forceFresh is true', async () => {
      await service.getDeFiPositions([testAddress]);
      await service.getDeFiPositions([testAddress], { forceFresh: true });

      expect(mockProtocol1.getStakedPositions).toHaveBeenCalledTimes(2);
    });
  });

  describe('getStats', () => {
    it('should track request statistics', async () => {
      await service.getDeFiPositions([testAddress]);

      const stats = service.getStats();
      expect(stats.totalRequests).toBe(1);
    });

    it('should track cache hits', async () => {
      await service.getDeFiPositions([testAddress]);
      await service.getDeFiPositions([testAddress]);

      const stats = service.getStats();
      expect(stats.cacheHits).toBeGreaterThan(0);
    });

    it('should track failed requests', async () => {
      (mockProtocol1.getStakedPositions as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('fail'));
      (mockProtocol2.getLiquidityPositions as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('fail'));

      await service.getDeFiPositions([testAddress]);

      const stats = service.getStats();
      expect(stats.failedRequests).toBeGreaterThan(0);
    });
  });

  describe('destroy', () => {
    it('should clean up resources', () => {
      service.destroy();
      // Should not throw on double destroy
      service.destroy();
    });
  });
});
