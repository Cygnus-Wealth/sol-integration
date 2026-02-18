/**
 * Subscription Service
 *
 * Implements Solana WebSocket subscriptions with automatic
 * polling fallback. Provides accountSubscribe, programSubscribe,
 * slotSubscribe, and signatureSubscribe with connection management.
 *
 * Slot events are debounced to 2-second windows (0.4s Solana slots
 * produce too many events for downstream consumers).
 */

import { PublicKey, AccountInfo, Context } from '@solana/web3.js';
import { ISubscriptionService } from '../../domain/services/ISubscriptionService';
import { WebSocketManager } from './WebSocketManager';
import { PollingFallback } from './PollingFallback';
import {
  WebSocketConfig,
  DEFAULT_WS_CONFIG,
  WebSocketEndpointConfig,
  SubscriptionType,
  SubscriptionEntry,
  SubscriptionCallback,
  SubscriptionNotification,
  SubscriptionStatus,
  ProgramFilter,
  AccountSubscriptionParams,
  TokenAccountSubscriptionParams,
  ProgramSubscriptionParams,
  SlotSubscriptionParams,
  SignatureSubscriptionParams,
} from './types';
import {
  DomainEvent,
  WebSocketConnectedEvent,
  WebSocketDisconnectedEvent,
  WebSocketFallbackActivatedEvent,
  WebSocketFallbackDeactivatedEvent,
} from '../../domain/events/DomainEvents';

export type SubscriptionEventHandler = (event: DomainEvent) => void;

export class SubscriptionService implements ISubscriptionService {
  private readonly wsManager: WebSocketManager;
  private readonly pollingFallback: PollingFallback;
  private readonly config: WebSocketConfig;
  private readonly eventHandlers: SubscriptionEventHandler[] = [];
  private nextSubscriptionId: number = 1;
  private isUsingFallback: boolean = false;
  private destroyed: boolean = false;

  // Slot debounce state
  private slotDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSlotNotification: SubscriptionNotification | null = null;
  private slotCallbacks: Map<number, SubscriptionCallback> = new Map();

  constructor(endpoints: WebSocketEndpointConfig[], config?: Partial<Omit<WebSocketConfig, 'endpoints'>>) {
    this.config = {
      ...DEFAULT_WS_CONFIG,
      ...config,
      endpoints,
    };

    this.wsManager = new WebSocketManager(this.config);
    this.pollingFallback = new PollingFallback(this.config, this.wsManager);

    // Forward WS manager events and handle fallback transitions
    this.wsManager.onEvent((event) => {
      this.emitEvent(event);

      if (event instanceof WebSocketDisconnectedEvent && !event.getPayload().wasClean) {
        this.activateFallback();
      }

      if (event instanceof WebSocketConnectedEvent && this.isUsingFallback) {
        this.deactivateFallback();
      }
    });
  }

  subscribeAccountChanges(pubkey: string, callback: SubscriptionCallback): number {
    const id = this.nextSubscriptionId++;
    const params: AccountSubscriptionParams = { type: 'account', pubkey };
    const entry: SubscriptionEntry = {
      id,
      type: 'account',
      params,
      callback,
      createdAt: new Date(),
    };

    this.wsManager.registerSubscription(entry);
    this.establishSolanaSubscription(entry);
    return id;
  }

  subscribeTokenAccounts(pubkey: string, callback: SubscriptionCallback): number {
    const id = this.nextSubscriptionId++;
    const params: TokenAccountSubscriptionParams = { type: 'tokenAccount', pubkey };
    const entry: SubscriptionEntry = {
      id,
      type: 'tokenAccount',
      params,
      callback,
      createdAt: new Date(),
    };

    this.wsManager.registerSubscription(entry);
    this.establishSolanaSubscription(entry);
    return id;
  }

  subscribeProgramChanges(
    programId: string,
    filters: ProgramFilter[],
    callback: SubscriptionCallback
  ): number {
    const id = this.nextSubscriptionId++;
    const params: ProgramSubscriptionParams = { type: 'program', programId, filters };
    const entry: SubscriptionEntry = {
      id,
      type: 'program',
      params,
      callback,
      createdAt: new Date(),
    };

    this.wsManager.registerSubscription(entry);
    this.establishSolanaSubscription(entry);
    return id;
  }

  subscribeSlotChanges(callback: SubscriptionCallback): number {
    const id = this.nextSubscriptionId++;
    const params: SlotSubscriptionParams = { type: 'slot' };
    const entry: SubscriptionEntry = {
      id,
      type: 'slot',
      params,
      callback,
      createdAt: new Date(),
    };

    this.slotCallbacks.set(id, callback);
    this.wsManager.registerSubscription(entry);
    this.establishSolanaSubscription(entry);
    return id;
  }

  subscribeSignatureStatus(signature: string, callback: SubscriptionCallback): number {
    const id = this.nextSubscriptionId++;
    const params: SignatureSubscriptionParams = { type: 'signature', signature };
    const entry: SubscriptionEntry = {
      id,
      type: 'signature',
      params,
      callback,
      createdAt: new Date(),
    };

    this.wsManager.registerSubscription(entry);
    this.establishSolanaSubscription(entry);
    return id;
  }

  unsubscribe(subscriptionId: number): void {
    this.slotCallbacks.delete(subscriptionId);
    this.wsManager.removeSubscription(subscriptionId);

    if (this.isUsingFallback) {
      this.pollingFallback.removePollingSubscription(subscriptionId);
    }
  }

  getSubscriptionStatus(): SubscriptionStatus {
    const endpoint = this.wsManager.getCurrentEndpoint();
    const subscriptions = this.wsManager.getSubscriptions();

    return {
      state: this.wsManager.getState(),
      activeSubscriptions: subscriptions.size,
      endpointName: endpoint.name,
      endpointUrl: endpoint.wsUrl,
      connectedSince: this.wsManager.getConnectedSince() ?? undefined,
      reconnectAttempts: this.wsManager.getReconnectAttempts(),
      isPollingFallback: this.isUsingFallback,
      subscriptions: Array.from(subscriptions.values()).map((entry) => ({
        id: entry.id,
        type: entry.type,
        createdAt: entry.createdAt,
      })),
    };
  }

  /**
   * Register an event handler for domain events.
   */
  onEvent(handler: SubscriptionEventHandler): void {
    this.eventHandlers.push(handler);
  }

  destroy(): void {
    this.destroyed = true;
    this.clearSlotDebounce();
    this.pollingFallback.destroy();
    this.wsManager.destroy();
    this.slotCallbacks.clear();
    this.eventHandlers.length = 0;
  }

  /**
   * Re-establish all subscriptions (called after reconnect).
   */
  async resubscribeAll(): Promise<void> {
    const subscriptions = this.wsManager.getSubscriptions();
    for (const entry of subscriptions.values()) {
      await this.establishSolanaSubscription(entry);
    }
  }

  // -- Private Methods --

  private async establishSolanaSubscription(entry: SubscriptionEntry): Promise<void> {
    if (this.destroyed) return;

    // If using polling fallback, register with poller instead
    if (this.isUsingFallback) {
      this.pollingFallback.addPollingSubscription(entry);
      return;
    }

    try {
      const connection = await this.wsManager.getConnection();

      switch (entry.type) {
        case 'account': {
          const params = entry.params as AccountSubscriptionParams;
          const pubkey = new PublicKey(params.pubkey);
          const solanaSubId = connection.onAccountChange(
            pubkey,
            (accountInfo: AccountInfo<Buffer>, context: Context) => {
              const notification: SubscriptionNotification = {
                type: 'account',
                data: { accountInfo, pubkey: params.pubkey },
                slot: context.slot,
                timestamp: new Date(),
              };
              entry.callback(notification);
            },
            this.config.commitment
          );
          this.wsManager.setSolanaSubId(entry.id, solanaSubId);
          break;
        }

        case 'tokenAccount': {
          const params = entry.params as TokenAccountSubscriptionParams;
          const pubkey = new PublicKey(params.pubkey);
          const solanaSubId = connection.onAccountChange(
            pubkey,
            (accountInfo: AccountInfo<Buffer>, context: Context) => {
              const notification: SubscriptionNotification = {
                type: 'tokenAccount',
                data: { accountInfo, pubkey: params.pubkey },
                slot: context.slot,
                timestamp: new Date(),
              };
              entry.callback(notification);
            },
            this.config.commitment
          );
          this.wsManager.setSolanaSubId(entry.id, solanaSubId);
          break;
        }

        case 'program': {
          const params = entry.params as ProgramSubscriptionParams;
          const programId = new PublicKey(params.programId);
          const solanaFilters = (params.filters || []).map((f) => {
            if (f.memcmp) {
              return { memcmp: { offset: f.memcmp.offset, bytes: f.memcmp.bytes } };
            }
            return { dataSize: f.dataSize! };
          });

          const solanaSubId = connection.onProgramAccountChange(
            programId,
            (keyedAccountInfo, context) => {
              const notification: SubscriptionNotification = {
                type: 'program',
                data: {
                  accountId: keyedAccountInfo.accountId.toBase58(),
                  accountInfo: keyedAccountInfo.accountInfo,
                  programId: params.programId,
                },
                slot: context.slot,
                timestamp: new Date(),
              };
              entry.callback(notification);
            },
            this.config.commitment,
            solanaFilters
          );
          this.wsManager.setSolanaSubId(entry.id, solanaSubId);
          break;
        }

        case 'slot': {
          const solanaSubId = connection.onSlotChange((slotInfo) => {
            // Debounce: buffer slot notifications and fire at 2-second intervals
            const notification: SubscriptionNotification = {
              type: 'slot',
              data: slotInfo,
              slot: slotInfo.slot,
              timestamp: new Date(),
            };
            this.handleSlotNotification(notification);
          });
          this.wsManager.setSolanaSubId(entry.id, solanaSubId);
          break;
        }

        case 'signature': {
          const params = entry.params as SignatureSubscriptionParams;
          const solanaSubId = connection.onSignature(
            params.signature,
            (signatureResult, context) => {
              const notification: SubscriptionNotification = {
                type: 'signature',
                data: { result: signatureResult, signature: params.signature },
                slot: context.slot,
                timestamp: new Date(),
              };
              entry.callback(notification);

              // Signature subscriptions are one-shot — auto-remove
              this.wsManager.removeSubscription(entry.id);
            },
            this.config.commitment
          );
          this.wsManager.setSolanaSubId(entry.id, solanaSubId);
          break;
        }
      }
    } catch {
      // Connection failed — activate polling fallback
      this.activateFallback();
      this.pollingFallback.addPollingSubscription(entry);
    }
  }

  /**
   * Debounce slot notifications to 2-second windows.
   * Only the latest slot notification in each window is forwarded.
   */
  private handleSlotNotification(notification: SubscriptionNotification): void {
    this.lastSlotNotification = notification;

    if (!this.slotDebounceTimer) {
      this.slotDebounceTimer = setTimeout(() => {
        this.slotDebounceTimer = null;
        if (this.lastSlotNotification) {
          const notif = this.lastSlotNotification;
          this.lastSlotNotification = null;
          for (const callback of this.slotCallbacks.values()) {
            try {
              callback(notif);
            } catch {
              // Don't let callback errors affect other subscribers
            }
          }
        }
      }, this.config.slotDebounceDurationMs);
    }
  }

  private clearSlotDebounce(): void {
    if (this.slotDebounceTimer) {
      clearTimeout(this.slotDebounceTimer);
      this.slotDebounceTimer = null;
    }
    this.lastSlotNotification = null;
  }

  private activateFallback(): void {
    if (this.isUsingFallback || this.destroyed) return;

    this.isUsingFallback = true;
    const endpoint = this.wsManager.getCurrentEndpoint();
    this.emitEvent(new WebSocketFallbackActivatedEvent(endpoint.name, this.config.pollingIntervalMs));

    // Transfer all active subscriptions to polling
    const subscriptions = this.wsManager.getSubscriptions();
    for (const entry of subscriptions.values()) {
      this.pollingFallback.addPollingSubscription(entry);
    }

    this.pollingFallback.start();
  }

  private deactivateFallback(): void {
    if (!this.isUsingFallback || this.destroyed) return;

    this.isUsingFallback = false;
    this.pollingFallback.stop();

    const endpoint = this.wsManager.getCurrentEndpoint();
    this.emitEvent(new WebSocketFallbackDeactivatedEvent(endpoint.name));

    // Re-establish all subscriptions on WS
    this.resubscribeAll();
  }

  private emitEvent(event: DomainEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Don't let handler errors affect service operation
      }
    }
  }
}
