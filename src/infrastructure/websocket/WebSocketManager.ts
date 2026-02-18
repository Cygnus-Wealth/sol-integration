/**
 * WebSocket Manager
 *
 * Manages Solana WebSocket connections with lazy establishment,
 * exponential backoff reconnection, heartbeat monitoring, and
 * multi-endpoint failover.
 *
 * Uses application-level ping (getHealth) for heartbeat since
 * Solana WS may not support native ping/pong.
 */

import { Connection } from '@solana/web3.js';
import {
  WebSocketConfig,
  WebSocketEndpointConfig,
  WebSocketState,
  SubscriptionEntry,
} from './types';
import {
  WebSocketConnectedEvent,
  WebSocketDisconnectedEvent,
  WebSocketReconnectingEvent,
  WebSocketErrorEvent,
  DomainEvent,
} from '../../domain/events/DomainEvents';

export type WebSocketEventHandler = (event: DomainEvent) => void;

export class WebSocketManager {
  private connection: Connection | null = null;
  private state: WebSocketState = 'disconnected';
  private currentEndpointIndex: number = 0;
  private reconnectAttempts: number = 0;
  private connectedSince: Date | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed: boolean = false;

  private readonly config: WebSocketConfig;
  private readonly sortedEndpoints: WebSocketEndpointConfig[];
  private readonly subscriptionRegistry: Map<number, SubscriptionEntry> = new Map();
  private readonly solanaSubIds: Map<number, number> = new Map(); // our id -> solana sub id
  private readonly eventHandlers: WebSocketEventHandler[] = [];

  constructor(config: WebSocketConfig) {
    this.config = config;
    this.sortedEndpoints = [...config.endpoints].sort((a, b) => a.priority - b.priority);

    if (this.sortedEndpoints.length === 0) {
      throw new Error('At least one WebSocket endpoint must be configured');
    }
  }

  /**
   * Lazily establish WebSocket connection on first subscription.
   */
  async connect(): Promise<void> {
    if (this.destroyed) return;
    if (this.state === 'connected' || this.state === 'connecting') return;

    this.state = 'connecting';
    const endpoint = this.getCurrentEndpoint();

    try {
      this.connection = new Connection(endpoint.url, {
        commitment: this.config.commitment,
        wsEndpoint: endpoint.wsUrl,
      });

      // Verify connection by calling getHealth (application-level ping)
      await this.performHealthCheck();

      this.state = 'connected';
      this.connectedSince = new Date();
      this.reconnectAttempts = 0;
      this.startHeartbeat();

      this.emitEvent(new WebSocketConnectedEvent(endpoint.wsUrl, endpoint.name));
    } catch (error) {
      this.state = 'disconnected';
      this.connection = null;
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.emitEvent(new WebSocketErrorEvent(endpoint.wsUrl, endpoint.name, errorMsg));
      throw error;
    }
  }

  /**
   * Disconnect and clean up all resources.
   */
  disconnect(): void {
    this.stopHeartbeat();
    this.clearReconnectTimer();

    // Remove all Solana subscriptions
    this.removeAllSolanaSubscriptions();

    const endpoint = this.getCurrentEndpoint();
    const wasConnected = this.state === 'connected';
    this.state = 'disconnected';
    this.connection = null;
    this.connectedSince = null;

    if (wasConnected) {
      this.emitEvent(
        new WebSocketDisconnectedEvent(endpoint.wsUrl, endpoint.name, 'manual disconnect', true)
      );
    }
  }

  /**
   * Destroy the manager, preventing further reconnection.
   */
  destroy(): void {
    this.destroyed = true;
    this.disconnect();
    this.subscriptionRegistry.clear();
    this.solanaSubIds.clear();
    this.eventHandlers.length = 0;
  }

  /**
   * Get the underlying Connection (establishing lazily if needed).
   */
  async getConnection(): Promise<Connection> {
    if (!this.connection || this.state !== 'connected') {
      await this.connect();
    }
    return this.connection!;
  }

  /**
   * Register a subscription in the registry.
   * Actual Solana subscription is established via resubscribeAll or on connect.
   */
  registerSubscription(entry: SubscriptionEntry): void {
    this.subscriptionRegistry.set(entry.id, entry);
  }

  /**
   * Remove a subscription from the registry and unsubscribe from Solana.
   */
  removeSubscription(id: number): void {
    const solanaSubId = this.solanaSubIds.get(id);
    const entry = this.subscriptionRegistry.get(id);

    if (solanaSubId !== undefined && this.connection && entry) {
      this.removeSolanaSubscription(entry.type, solanaSubId);
    }

    this.subscriptionRegistry.delete(id);
    this.solanaSubIds.delete(id);
  }

  /**
   * Map our subscription ID to a Solana subscription ID.
   */
  setSolanaSubId(ourId: number, solanaSubId: number): void {
    this.solanaSubIds.set(ourId, solanaSubId);
  }

  /**
   * Get all registered subscriptions.
   */
  getSubscriptions(): Map<number, SubscriptionEntry> {
    return this.subscriptionRegistry;
  }

  /**
   * Get current WebSocket state.
   */
  getState(): WebSocketState {
    return this.state;
  }

  /**
   * Get current endpoint config.
   */
  getCurrentEndpoint(): WebSocketEndpointConfig {
    return this.sortedEndpoints[this.currentEndpointIndex];
  }

  /**
   * Get connected-since timestamp.
   */
  getConnectedSince(): Date | null {
    return this.connectedSince;
  }

  /**
   * Get reconnect attempt count.
   */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /**
   * Register an event handler for domain events.
   */
  onEvent(handler: WebSocketEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Trigger reconnection (called by PollingFallback or on heartbeat failure).
   */
  async reconnect(): Promise<void> {
    if (this.destroyed) return;
    if (this.state === 'connecting' || this.state === 'reconnecting') return;

    this.state = 'reconnecting';
    this.stopHeartbeat();
    this.removeAllSolanaSubscriptions();
    this.connection = null;

    this.reconnectAttempts++;
    const delay = this.calculateBackoffDelay();
    const endpoint = this.getCurrentEndpoint();

    this.emitEvent(
      new WebSocketReconnectingEvent(endpoint.wsUrl, endpoint.name, this.reconnectAttempts, delay)
    );

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(async () => {
      try {
        // Try next endpoint if current has failed multiple times
        if (this.reconnectAttempts > 2 && this.sortedEndpoints.length > 1) {
          this.currentEndpointIndex = (this.currentEndpointIndex + 1) % this.sortedEndpoints.length;
        }

        this.state = 'disconnected';
        await this.connect();
      } catch {
        // connect() already emits error event; schedule another retry
        if (!this.destroyed) {
          this.reconnect();
        }
      }
    }, delay);
  }

  /**
   * Check if manager is destroyed.
   */
  isDestroyed(): boolean {
    return this.destroyed;
  }

  // -- Private Methods --

  private async performHealthCheck(): Promise<void> {
    if (!this.connection) throw new Error('No connection');

    // Use getSlot as a lightweight health check (works on all endpoints).
    // Helius-specific getHealth is not available via @solana/web3.js directly.
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Health check timed out')), 10_000)
    );
    await Promise.race([this.connection.getSlot(), timeoutPromise]);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      if (this.state !== 'connected' || this.destroyed) return;
      try {
        await this.performHealthCheck();
      } catch {
        // Heartbeat failed — trigger reconnection
        const endpoint = this.getCurrentEndpoint();
        this.emitEvent(
          new WebSocketDisconnectedEvent(endpoint.wsUrl, endpoint.name, 'heartbeat failure', false)
        );
        this.reconnect();
      }
    }, this.config.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private calculateBackoffDelay(): number {
    const base = this.config.reconnectBaseDelayMs;
    const max = this.config.reconnectMaxDelayMs;
    // Exponential backoff with jitter
    const exponential = base * Math.pow(2, Math.min(this.reconnectAttempts - 1, 10));
    const jitter = Math.random() * base;
    return Math.min(exponential + jitter, max);
  }

  private removeSolanaSubscription(type: string, solanaSubId: number): void {
    if (!this.connection) return;
    try {
      switch (type) {
        case 'account':
        case 'tokenAccount':
          this.connection.removeAccountChangeListener(solanaSubId);
          break;
        case 'program':
          this.connection.removeProgramAccountChangeListener(solanaSubId);
          break;
        case 'slot':
          this.connection.removeSlotChangeListener(solanaSubId);
          break;
        case 'signature':
          this.connection.removeSignatureListener(solanaSubId);
          break;
      }
    } catch {
      // Ignore removal errors during teardown
    }
  }

  private removeAllSolanaSubscriptions(): void {
    for (const [ourId, solanaSubId] of this.solanaSubIds) {
      const entry = this.subscriptionRegistry.get(ourId);
      if (entry) {
        this.removeSolanaSubscription(entry.type, solanaSubId);
      }
    }
    this.solanaSubIds.clear();
  }

  private emitEvent(event: DomainEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Don't let handler errors affect manager operation
      }
    }
  }
}
