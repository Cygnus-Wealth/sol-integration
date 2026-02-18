import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PollingFallback } from '../../infrastructure/websocket/PollingFallback';
import { WebSocketManager } from '../../infrastructure/websocket/WebSocketManager';
import { WebSocketConfig, SubscriptionEntry, DEFAULT_WS_CONFIG } from '../../infrastructure/websocket/types';

const mockGetSlot = vi.fn().mockResolvedValue(123456789);
const mockGetAccountInfo = vi.fn().mockResolvedValue(null);
const mockGetProgramAccounts = vi.fn().mockResolvedValue([]);
const mockGetSignatureStatus = vi.fn().mockResolvedValue({ value: null, context: { slot: 100 } });

vi.mock('@solana/web3.js', () => {
  const MockConnection = vi.fn().mockImplementation(() => ({
    getSlot: mockGetSlot,
    getAccountInfo: mockGetAccountInfo,
    getProgramAccounts: mockGetProgramAccounts,
    getSignatureStatus: mockGetSignatureStatus,
    onAccountChange: vi.fn().mockReturnValue(1),
    onProgramAccountChange: vi.fn().mockReturnValue(2),
    onSlotChange: vi.fn().mockReturnValue(3),
    onSignature: vi.fn().mockReturnValue(4),
    removeAccountChangeListener: vi.fn(),
    removeProgramAccountChangeListener: vi.fn(),
    removeSlotChangeListener: vi.fn(),
    removeSignatureListener: vi.fn(),
  }));
  return {
    Connection: MockConnection,
    PublicKey: vi.fn().mockImplementation((key: string) => ({
      toBase58: () => key,
      toString: () => key,
    })),
  };
});

function makeConfig(overrides: Partial<WebSocketConfig> = {}): WebSocketConfig {
  return {
    ...DEFAULT_WS_CONFIG,
    pollingIntervalMs: 1000, // Faster for tests
    wsRecoveryIntervalMs: 5000,
    endpoints: [
      {
        url: 'https://mainnet.helius-rpc.com/?api-key=test',
        name: 'helius',
        priority: 1,
        wsUrl: 'wss://mainnet.helius-rpc.com/?api-key=test',
      },
    ],
    ...overrides,
  };
}

describe('PollingFallback', () => {
  let fallback: PollingFallback;
  let wsManager: WebSocketManager;
  let config: WebSocketConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetSlot.mockResolvedValue(123456789);
    mockGetAccountInfo.mockResolvedValue(null);
    mockGetProgramAccounts.mockResolvedValue([]);
    config = makeConfig();
    wsManager = new WebSocketManager(config);
    fallback = new PollingFallback(config, wsManager);
  });

  afterEach(() => {
    fallback?.destroy();
    wsManager?.destroy();
    vi.useRealTimers();
  });

  describe('start/stop', () => {
    it('should start polling timer', () => {
      fallback.start();
      expect(fallback.isPolling()).toBe(true);
    });

    it('should stop polling timer', () => {
      fallback.start();
      fallback.stop();
      expect(fallback.isPolling()).toBe(false);
    });
  });

  describe('subscription management', () => {
    it('should track polling subscriptions', () => {
      const entry: SubscriptionEntry = {
        id: 1,
        type: 'account',
        params: { type: 'account', pubkey: 'test-pubkey' },
        callback: vi.fn(),
        createdAt: new Date(),
      };

      fallback.addPollingSubscription(entry);
      expect(fallback.getPollingCount()).toBe(1);
    });

    it('should remove polling subscriptions', () => {
      const entry: SubscriptionEntry = {
        id: 1,
        type: 'account',
        params: { type: 'account', pubkey: 'test-pubkey' },
        callback: vi.fn(),
        createdAt: new Date(),
      };

      fallback.addPollingSubscription(entry);
      fallback.removePollingSubscription(1);
      expect(fallback.getPollingCount()).toBe(0);
    });
  });

  describe('account polling', () => {
    it('should poll account info on interval', async () => {
      const callback = vi.fn();
      const entry: SubscriptionEntry = {
        id: 1,
        type: 'account',
        params: { type: 'account', pubkey: 'test-pubkey' },
        callback,
        createdAt: new Date(),
      };

      fallback.addPollingSubscription(entry);
      fallback.start();

      // First poll establishes baseline — no notification
      await vi.advanceTimersByTimeAsync(100);
      expect(callback).not.toHaveBeenCalled();

      // Change account data
      mockGetAccountInfo.mockResolvedValue({
        lamports: 2_000_000_000,
        data: Buffer.from([1, 2, 3]),
        owner: 'system',
        executable: false,
        rentEpoch: 0,
      });

      // Second poll detects change
      await vi.advanceTimersByTimeAsync(1100);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'account',
          data: expect.objectContaining({ pubkey: 'test-pubkey' }),
        })
      );
    });

    it('should not notify when account data has not changed', async () => {
      const callback = vi.fn();
      const accountData = {
        lamports: 1_000_000_000,
        data: Buffer.from([1]),
        owner: 'system',
        executable: false,
        rentEpoch: 0,
      };
      mockGetAccountInfo.mockResolvedValue(accountData);

      const entry: SubscriptionEntry = {
        id: 1,
        type: 'account',
        params: { type: 'account', pubkey: 'test-pubkey' },
        callback,
        createdAt: new Date(),
      };

      fallback.addPollingSubscription(entry);
      fallback.start();

      // First poll: baseline
      await vi.advanceTimersByTimeAsync(100);

      // Second poll: same data — no notification
      await vi.advanceTimersByTimeAsync(1100);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('signature polling', () => {
    it('should auto-remove subscription when signature confirmed', async () => {
      const callback = vi.fn();
      const entry: SubscriptionEntry = {
        id: 1,
        type: 'signature',
        params: { type: 'signature', signature: 'sig-abc' },
        callback,
        createdAt: new Date(),
      };

      fallback.addPollingSubscription(entry);
      wsManager.registerSubscription(entry);
      fallback.start();

      // Simulate signature confirmation
      mockGetSignatureStatus.mockResolvedValue({
        value: { confirmationStatus: 'confirmed', err: null },
        context: { slot: 200 },
      });

      await vi.advanceTimersByTimeAsync(1100);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'signature',
          data: expect.objectContaining({ signature: 'sig-abc' }),
        })
      );

      // Should be auto-removed
      expect(fallback.getPollingCount()).toBe(0);
    });
  });

  describe('slot polling', () => {
    it('should poll current slot', async () => {
      const callback = vi.fn();
      const entry: SubscriptionEntry = {
        id: 1,
        type: 'slot',
        params: { type: 'slot' },
        callback,
        createdAt: new Date(),
      };

      fallback.addPollingSubscription(entry);
      fallback.start();

      await vi.advanceTimersByTimeAsync(100);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'slot',
          slot: 123456789,
        })
      );
    });
  });

  describe('WS recovery', () => {
    it('should attempt WS reconnection on recovery interval', async () => {
      const reconnectSpy = vi.spyOn(wsManager, 'reconnect').mockResolvedValue();

      fallback.start();

      // Wait for recovery interval
      await vi.advanceTimersByTimeAsync(5100);

      expect(reconnectSpy).toHaveBeenCalled();
    });
  });

  describe('destroy', () => {
    it('should clean up all resources', () => {
      fallback.addPollingSubscription({
        id: 1,
        type: 'account',
        params: { type: 'account', pubkey: 'test' },
        callback: vi.fn(),
        createdAt: new Date(),
      });

      fallback.start();
      fallback.destroy();

      expect(fallback.isPolling()).toBe(false);
      expect(fallback.getPollingCount()).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should silently handle individual poll errors', async () => {
      mockGetAccountInfo.mockRejectedValue(new Error('RPC error'));

      const entry: SubscriptionEntry = {
        id: 1,
        type: 'account',
        params: { type: 'account', pubkey: 'test-pubkey' },
        callback: vi.fn(),
        createdAt: new Date(),
      };

      fallback.addPollingSubscription(entry);
      fallback.start();

      // Should not throw
      await vi.advanceTimersByTimeAsync(1100);

      expect(fallback.isPolling()).toBe(true); // Still polling
    });
  });
});
