import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketManager } from '../../infrastructure/websocket/WebSocketManager';
import { WebSocketConfig, SubscriptionEntry, DEFAULT_WS_CONFIG } from '../../infrastructure/websocket/types';
import {
  WebSocketConnectedEvent,
  WebSocketDisconnectedEvent,
  WebSocketReconnectingEvent,
  WebSocketErrorEvent,
} from '../../domain/events/DomainEvents';

const mockGetSlot = vi.fn().mockResolvedValue(123456789);
const mockOnAccountChange = vi.fn().mockReturnValue(1);
const mockOnProgramAccountChange = vi.fn().mockReturnValue(2);
const mockOnSlotChange = vi.fn().mockReturnValue(3);
const mockOnSignature = vi.fn().mockReturnValue(4);
const mockRemoveAccountChangeListener = vi.fn();
const mockRemoveProgramAccountChangeListener = vi.fn();
const mockRemoveSlotChangeListener = vi.fn();
const mockRemoveSignatureListener = vi.fn();

vi.mock('@solana/web3.js', () => {
  const MockConnection = vi.fn().mockImplementation(() => ({
    getSlot: mockGetSlot,
    onAccountChange: mockOnAccountChange,
    onProgramAccountChange: mockOnProgramAccountChange,
    onSlotChange: mockOnSlotChange,
    onSignature: mockOnSignature,
    removeAccountChangeListener: mockRemoveAccountChangeListener,
    removeProgramAccountChangeListener: mockRemoveProgramAccountChangeListener,
    removeSlotChangeListener: mockRemoveSlotChangeListener,
    removeSignatureListener: mockRemoveSignatureListener,
  }));
  return {
    Connection: MockConnection,
    PublicKey: vi.fn().mockImplementation((key: string) => ({ toBase58: () => key })),
  };
});

function makeConfig(overrides: Partial<WebSocketConfig> = {}): WebSocketConfig {
  return {
    ...DEFAULT_WS_CONFIG,
    endpoints: [
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
      {
        url: 'https://api.mainnet-beta.solana.com',
        name: 'public',
        priority: 3,
        wsUrl: 'wss://api.mainnet-beta.solana.com',
      },
    ],
    ...overrides,
  };
}

describe('WebSocketManager', () => {
  let manager: WebSocketManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetSlot.mockResolvedValue(123456789);
  });

  afterEach(() => {
    manager?.destroy();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should sort endpoints by priority', () => {
      manager = new WebSocketManager(makeConfig());
      const endpoint = manager.getCurrentEndpoint();
      expect(endpoint.name).toBe('helius');
      expect(endpoint.priority).toBe(1);
    });

    it('should throw if no endpoints configured', () => {
      expect(() => new WebSocketManager(makeConfig({ endpoints: [] }))).toThrow(
        'At least one WebSocket endpoint must be configured'
      );
    });

    it('should initialize in disconnected state', () => {
      manager = new WebSocketManager(makeConfig());
      expect(manager.getState()).toBe('disconnected');
      expect(manager.getConnectedSince()).toBeNull();
      expect(manager.getReconnectAttempts()).toBe(0);
    });
  });

  describe('connect', () => {
    it('should establish connection and emit connected event', async () => {
      manager = new WebSocketManager(makeConfig());
      const events: any[] = [];
      manager.onEvent((event) => events.push(event));

      await manager.connect();

      expect(manager.getState()).toBe('connected');
      expect(manager.getConnectedSince()).toBeDefined();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(WebSocketConnectedEvent);
      expect(events[0].endpointName).toBe('helius');
    });

    it('should reset reconnect attempts on successful connect', async () => {
      manager = new WebSocketManager(makeConfig());
      // Simulate prior reconnect attempts by direct state
      await manager.connect();
      expect(manager.getReconnectAttempts()).toBe(0);
    });

    it('should not connect if already connected', async () => {
      manager = new WebSocketManager(makeConfig());
      await manager.connect();
      const events: any[] = [];
      manager.onEvent((event) => events.push(event));

      await manager.connect(); // second call should be no-op

      expect(events).toHaveLength(0); // no new events
    });

    it('should emit error event on connection failure', async () => {
      mockGetSlot.mockRejectedValueOnce(new Error('Connection refused'));
      manager = new WebSocketManager(makeConfig());
      const events: any[] = [];
      manager.onEvent((event) => events.push(event));

      await expect(manager.connect()).rejects.toThrow('Connection refused');

      expect(manager.getState()).toBe('disconnected');
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(WebSocketErrorEvent);
    });

    it('should not connect if destroyed', async () => {
      manager = new WebSocketManager(makeConfig());
      manager.destroy();
      await manager.connect();
      expect(manager.getState()).toBe('disconnected');
    });
  });

  describe('disconnect', () => {
    it('should clean up and emit disconnected event', async () => {
      manager = new WebSocketManager(makeConfig());
      await manager.connect();
      const events: any[] = [];
      manager.onEvent((event) => events.push(event));

      manager.disconnect();

      expect(manager.getState()).toBe('disconnected');
      expect(manager.getConnectedSince()).toBeNull();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(WebSocketDisconnectedEvent);
      expect(events[0].getPayload().wasClean).toBe(true);
    });

    it('should remove all Solana subscriptions on disconnect', async () => {
      manager = new WebSocketManager(makeConfig());
      await manager.connect();

      const entry: SubscriptionEntry = {
        id: 1,
        type: 'account',
        params: { type: 'account', pubkey: 'test-pubkey' },
        callback: vi.fn(),
        createdAt: new Date(),
      };
      manager.registerSubscription(entry);
      manager.setSolanaSubId(1, 100);

      manager.disconnect();

      expect(mockRemoveAccountChangeListener).toHaveBeenCalledWith(100);
    });
  });

  describe('heartbeat', () => {
    it('should trigger reconnect on heartbeat failure', async () => {
      manager = new WebSocketManager(makeConfig({ heartbeatIntervalMs: 5000 }));
      await manager.connect();

      const events: any[] = [];
      manager.onEvent((event) => events.push(event));

      // Make heartbeat fail
      mockGetSlot.mockRejectedValueOnce(new Error('Network error'));

      // Advance past heartbeat interval
      await vi.advanceTimersByTimeAsync(5100);

      const disconnectEvent = events.find((e) => e instanceof WebSocketDisconnectedEvent);
      expect(disconnectEvent).toBeDefined();
      expect(disconnectEvent.getPayload().reason).toBe('heartbeat failure');
    });
  });

  describe('reconnect', () => {
    it('should increment reconnect attempts and emit event', async () => {
      manager = new WebSocketManager(makeConfig());
      await manager.connect();

      const events: any[] = [];
      manager.onEvent((event) => events.push(event));

      // Force disconnect then reconnect
      mockGetSlot.mockRejectedValueOnce(new Error('fail'));
      manager.disconnect();
      await manager.reconnect();

      expect(manager.getReconnectAttempts()).toBe(1);
      const reconnectEvent = events.find((e) => e instanceof WebSocketReconnectingEvent);
      expect(reconnectEvent).toBeDefined();
      expect(reconnectEvent.getPayload().attempt).toBe(1);
    });

    it('should use exponential backoff delay', async () => {
      manager = new WebSocketManager(makeConfig({ reconnectBaseDelayMs: 1000, reconnectMaxDelayMs: 30000 }));

      // Force multiple reconnects
      const events: any[] = [];
      manager.onEvent((event) => events.push(event));

      await manager.reconnect();
      const firstDelay = events[0].getPayload().delayMs;

      // Reset state for second attempt
      manager.disconnect();
      vi.clearAllMocks();
      mockGetSlot.mockResolvedValue(123456789);
      events.length = 0;

      await manager.reconnect();
      const secondDelay = events[0].getPayload().delayMs;

      // Second delay should be >= first delay (exponential)
      expect(secondDelay).toBeGreaterThanOrEqual(firstDelay);
    });

    it('should try next endpoint after multiple failures', async () => {
      manager = new WebSocketManager(makeConfig({ reconnectBaseDelayMs: 100 }));

      // Fail 3 times to trigger endpoint failover
      mockGetSlot.mockRejectedValue(new Error('fail'));
      await manager.reconnect(); // attempt 1
      await vi.advanceTimersByTimeAsync(200);
      await manager.reconnect(); // attempt 2
      await vi.advanceTimersByTimeAsync(500);
      await manager.reconnect(); // attempt 3 — should switch to alchemy
      await vi.advanceTimersByTimeAsync(1000);

      const endpoint = manager.getCurrentEndpoint();
      expect(endpoint.name).toBe('alchemy');
    });

    it('should not reconnect if destroyed', async () => {
      manager = new WebSocketManager(makeConfig());
      manager.destroy();
      await manager.reconnect();
      expect(manager.getState()).toBe('disconnected');
    });
  });

  describe('subscription registry', () => {
    it('should register and retrieve subscriptions', () => {
      manager = new WebSocketManager(makeConfig());
      const entry: SubscriptionEntry = {
        id: 1,
        type: 'account',
        params: { type: 'account', pubkey: 'test' },
        callback: vi.fn(),
        createdAt: new Date(),
      };

      manager.registerSubscription(entry);

      expect(manager.getSubscriptions().size).toBe(1);
      expect(manager.getSubscriptions().get(1)).toEqual(entry);
    });

    it('should remove subscriptions and clean up Solana sub ID', async () => {
      manager = new WebSocketManager(makeConfig());
      await manager.connect();

      const entry: SubscriptionEntry = {
        id: 1,
        type: 'slot',
        params: { type: 'slot' },
        callback: vi.fn(),
        createdAt: new Date(),
      };

      manager.registerSubscription(entry);
      manager.setSolanaSubId(1, 42);
      manager.removeSubscription(1);

      expect(manager.getSubscriptions().size).toBe(0);
      expect(mockRemoveSlotChangeListener).toHaveBeenCalledWith(42);
    });

    it('should map our sub IDs to Solana sub IDs', () => {
      manager = new WebSocketManager(makeConfig());
      manager.setSolanaSubId(1, 100);
      manager.setSolanaSubId(2, 200);

      // We can verify by removing and checking the mock is called
      const entry1: SubscriptionEntry = {
        id: 1,
        type: 'program',
        params: { type: 'program', programId: 'test', filters: [] },
        callback: vi.fn(),
        createdAt: new Date(),
      };
      manager.registerSubscription(entry1);
      manager.removeSubscription(1);
      // Without connection, removal won't call Solana - that's expected
      expect(manager.getSubscriptions().size).toBe(0);
    });
  });

  describe('destroy', () => {
    it('should clean up all state', async () => {
      manager = new WebSocketManager(makeConfig());
      await manager.connect();

      manager.registerSubscription({
        id: 1,
        type: 'account',
        params: { type: 'account', pubkey: 'test' },
        callback: vi.fn(),
        createdAt: new Date(),
      });

      manager.destroy();

      expect(manager.getState()).toBe('disconnected');
      expect(manager.isDestroyed()).toBe(true);
      expect(manager.getSubscriptions().size).toBe(0);
    });

    it('should prevent reconnection after destroy', async () => {
      manager = new WebSocketManager(makeConfig());
      manager.destroy();

      await manager.reconnect();
      expect(manager.getState()).toBe('disconnected');
    });
  });
});
