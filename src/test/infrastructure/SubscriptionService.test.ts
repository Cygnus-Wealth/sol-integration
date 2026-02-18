import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SubscriptionService } from '../../infrastructure/websocket/SubscriptionService';
import { WebSocketEndpointConfig, DEFAULT_WS_CONFIG } from '../../infrastructure/websocket/types';
import {
  WebSocketConnectedEvent,
  WebSocketDisconnectedEvent,
  WebSocketFallbackActivatedEvent,
  WebSocketFallbackDeactivatedEvent,
} from '../../domain/events/DomainEvents';

// Mock callbacks captured by the Connection mock
let onAccountChangeCallback: Function | null = null;
let onProgramAccountChangeCallback: Function | null = null;
let onSlotChangeCallback: Function | null = null;
let onSignatureCallback: Function | null = null;

const mockGetSlot = vi.fn().mockResolvedValue(123456789);
const mockGetAccountInfo = vi.fn().mockResolvedValue(null);
const mockGetProgramAccounts = vi.fn().mockResolvedValue([]);
const mockGetSignatureStatus = vi.fn().mockResolvedValue({ value: null, context: { slot: 100 } });
let accountSubIdCounter = 0;

vi.mock('@solana/web3.js', () => {
  const MockConnection = vi.fn().mockImplementation(() => ({
    getSlot: mockGetSlot,
    getAccountInfo: mockGetAccountInfo,
    getProgramAccounts: mockGetProgramAccounts,
    getSignatureStatus: mockGetSignatureStatus,
    onAccountChange: vi.fn().mockImplementation((_pubkey: any, cb: Function) => {
      onAccountChangeCallback = cb;
      return ++accountSubIdCounter;
    }),
    onProgramAccountChange: vi.fn().mockImplementation((_programId: any, cb: Function) => {
      onProgramAccountChangeCallback = cb;
      return ++accountSubIdCounter;
    }),
    onSlotChange: vi.fn().mockImplementation((cb: Function) => {
      onSlotChangeCallback = cb;
      return ++accountSubIdCounter;
    }),
    onSignature: vi.fn().mockImplementation((_sig: any, cb: Function) => {
      onSignatureCallback = cb;
      return ++accountSubIdCounter;
    }),
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

const testEndpoints: WebSocketEndpointConfig[] = [
  {
    url: 'https://mainnet.helius-rpc.com/?api-key=test',
    name: 'helius',
    priority: 1,
    wsUrl: 'wss://mainnet.helius-rpc.com/?api-key=test',
    maxSubscriptions: 40000,
  },
  {
    url: 'https://solana-mainnet.g.alchemy.com/v2/test',
    name: 'alchemy',
    priority: 2,
    wsUrl: 'wss://solana-mainnet.g.alchemy.com/v2/test',
  },
];

describe('SubscriptionService', () => {
  let service: SubscriptionService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    accountSubIdCounter = 0;
    onAccountChangeCallback = null;
    onProgramAccountChangeCallback = null;
    onSlotChangeCallback = null;
    onSignatureCallback = null;
    mockGetSlot.mockResolvedValue(123456789);
  });

  afterEach(() => {
    service?.destroy();
    vi.useRealTimers();
  });

  describe('subscribeAccountChanges', () => {
    it('should return a subscription ID', async () => {
      service = new SubscriptionService(testEndpoints);
      const callback = vi.fn();
      const id = service.subscribeAccountChanges('wallet-pubkey', callback);
      expect(id).toBe(1);
    });

    it('should forward account change notifications to callback', async () => {
      service = new SubscriptionService(testEndpoints);
      const callback = vi.fn();
      service.subscribeAccountChanges('wallet-pubkey', callback);

      // Wait for lazy connection
      await vi.advanceTimersByTimeAsync(100);

      // Simulate Solana sending an account change notification
      if (onAccountChangeCallback) {
        onAccountChangeCallback(
          { lamports: 1_000_000_000, data: Buffer.from([]), owner: 'system', executable: false, rentEpoch: 0 },
          { slot: 200 }
        );
      }

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'account',
          slot: 200,
          data: expect.objectContaining({ pubkey: 'wallet-pubkey' }),
        })
      );
    });

    it('should increment subscription IDs', () => {
      service = new SubscriptionService(testEndpoints);
      const id1 = service.subscribeAccountChanges('pubkey1', vi.fn());
      const id2 = service.subscribeAccountChanges('pubkey2', vi.fn());
      expect(id2).toBe(id1 + 1);
    });
  });

  describe('subscribeTokenAccounts', () => {
    it('should return a subscription ID', () => {
      service = new SubscriptionService(testEndpoints);
      const id = service.subscribeTokenAccounts('token-account-pubkey', vi.fn());
      expect(id).toBeGreaterThan(0);
    });

    it('should track subscription in status', () => {
      service = new SubscriptionService(testEndpoints);
      service.subscribeTokenAccounts('token-account', vi.fn());

      const status = service.getSubscriptionStatus();
      expect(status.activeSubscriptions).toBe(1);
      expect(status.subscriptions[0].type).toBe('tokenAccount');
    });
  });

  describe('subscribeProgramChanges', () => {
    it('should accept program ID and filters', () => {
      service = new SubscriptionService(testEndpoints);
      const filters = [{ memcmp: { offset: 0, bytes: 'abc' } }];
      const id = service.subscribeProgramChanges('program-id', filters, vi.fn());
      expect(id).toBeGreaterThan(0);
    });

    it('should forward program account change notifications', async () => {
      service = new SubscriptionService(testEndpoints);
      const callback = vi.fn();
      service.subscribeProgramChanges('program-id', [], callback);

      await vi.advanceTimersByTimeAsync(100);

      if (onProgramAccountChangeCallback) {
        onProgramAccountChangeCallback(
          {
            accountId: { toBase58: () => 'account-1' },
            accountInfo: { data: Buffer.from([]) },
          },
          { slot: 300 }
        );
      }

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'program',
          slot: 300,
          data: expect.objectContaining({ programId: 'program-id' }),
        })
      );
    });
  });

  describe('subscribeSlotChanges', () => {
    it('should debounce slot notifications to configured window', async () => {
      service = new SubscriptionService(testEndpoints, { slotDebounceDurationMs: 2000 });
      const callback = vi.fn();
      service.subscribeSlotChanges(callback);

      await vi.advanceTimersByTimeAsync(100);

      // Simulate rapid slot updates (0.4s Solana slots)
      if (onSlotChangeCallback) {
        onSlotChangeCallback({ slot: 100, parent: 99, root: 68 });
        onSlotChangeCallback({ slot: 101, parent: 100, root: 69 });
        onSlotChangeCallback({ slot: 102, parent: 101, root: 70 });
        onSlotChangeCallback({ slot: 103, parent: 102, root: 71 });
        onSlotChangeCallback({ slot: 104, parent: 103, root: 72 });
      }

      // Before debounce window: no callbacks yet
      expect(callback).not.toHaveBeenCalled();

      // After 2-second debounce window
      await vi.advanceTimersByTimeAsync(2100);

      // Should have received exactly ONE debounced notification with the latest slot
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'slot',
          slot: 104, // latest slot
        })
      );
    });

    it('should deliver to multiple slot subscribers', async () => {
      service = new SubscriptionService(testEndpoints, { slotDebounceDurationMs: 2000 });
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      service.subscribeSlotChanges(callback1);
      service.subscribeSlotChanges(callback2);

      await vi.advanceTimersByTimeAsync(100);

      if (onSlotChangeCallback) {
        onSlotChangeCallback({ slot: 100, parent: 99, root: 68 });
      }

      await vi.advanceTimersByTimeAsync(2100);

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribeSignatureStatus', () => {
    it('should auto-unsubscribe after signature confirmed', async () => {
      service = new SubscriptionService(testEndpoints);
      const callback = vi.fn();
      const id = service.subscribeSignatureStatus('sig-abc', callback);

      await vi.advanceTimersByTimeAsync(100);

      // Simulate signature confirmation
      if (onSignatureCallback) {
        onSignatureCallback({ err: null }, { slot: 500 });
      }

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'signature',
          slot: 500,
          data: expect.objectContaining({ signature: 'sig-abc' }),
        })
      );

      // Should be auto-removed from subscriptions
      const status = service.getSubscriptionStatus();
      const sigSub = status.subscriptions.find((s) => s.id === id);
      expect(sigSub).toBeUndefined();
    });
  });

  describe('unsubscribe', () => {
    it('should remove subscription from status', () => {
      service = new SubscriptionService(testEndpoints);
      const id = service.subscribeAccountChanges('pubkey', vi.fn());

      expect(service.getSubscriptionStatus().activeSubscriptions).toBe(1);

      service.unsubscribe(id);

      expect(service.getSubscriptionStatus().activeSubscriptions).toBe(0);
    });
  });

  describe('getSubscriptionStatus', () => {
    it('should return complete status information', () => {
      service = new SubscriptionService(testEndpoints);
      service.subscribeAccountChanges('pubkey1', vi.fn());
      service.subscribeTokenAccounts('pubkey2', vi.fn());

      const status = service.getSubscriptionStatus();

      expect(status.endpointName).toBe('helius');
      expect(status.activeSubscriptions).toBe(2);
      expect(status.isPollingFallback).toBe(false);
      expect(status.subscriptions).toHaveLength(2);
      expect(status.subscriptions[0].type).toBe('account');
      expect(status.subscriptions[1].type).toBe('tokenAccount');
    });
  });

  describe('polling fallback', () => {
    it('should activate fallback when connection fails', async () => {
      mockGetSlot.mockRejectedValue(new Error('Connection refused'));
      service = new SubscriptionService(testEndpoints);

      const events: any[] = [];
      service.onEvent((event) => events.push(event));

      // Subscribe — this will trigger lazy connect which fails
      service.subscribeAccountChanges('pubkey', vi.fn());

      await vi.advanceTimersByTimeAsync(500);

      const status = service.getSubscriptionStatus();
      expect(status.isPollingFallback).toBe(true);

      const fallbackEvent = events.find((e) => e instanceof WebSocketFallbackActivatedEvent);
      expect(fallbackEvent).toBeDefined();
    });
  });

  describe('domain events', () => {
    it('should forward WebSocket events to registered handlers', async () => {
      service = new SubscriptionService(testEndpoints);
      const events: any[] = [];
      service.onEvent((event) => events.push(event));

      // Trigger a connect (which emits WebSocketConnectedEvent)
      service.subscribeAccountChanges('pubkey', vi.fn());
      await vi.advanceTimersByTimeAsync(100);

      const connectedEvent = events.find((e) => e instanceof WebSocketConnectedEvent);
      expect(connectedEvent).toBeDefined();
    });
  });

  describe('destroy', () => {
    it('should clean up all resources', () => {
      service = new SubscriptionService(testEndpoints);
      service.subscribeAccountChanges('pubkey1', vi.fn());
      service.subscribeSlotChanges(vi.fn());

      service.destroy();

      const status = service.getSubscriptionStatus();
      expect(status.activeSubscriptions).toBe(0);
    });
  });
});
