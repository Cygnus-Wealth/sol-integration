/**
 * Polling Fallback
 *
 * Falls back to 30-second HTTP polling when WebSocket connection fails.
 * Attempts WS recovery every 60 seconds. Polls account balances and
 * program accounts via standard RPC calls to provide best-effort
 * real-time data when WebSocket is unavailable.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { WebSocketManager } from './WebSocketManager';
import {
  WebSocketConfig,
  SubscriptionEntry,
  SubscriptionNotification,
  AccountSubscriptionParams,
  TokenAccountSubscriptionParams,
  ProgramSubscriptionParams,
  SignatureSubscriptionParams,
} from './types';

export class PollingFallback {
  private readonly config: WebSocketConfig;
  private readonly wsManager: WebSocketManager;
  private readonly pollingEntries: Map<number, SubscriptionEntry> = new Map();
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private wsRecoveryTimer: ReturnType<typeof setInterval> | null = null;
  private httpConnection: Connection | null = null;
  private destroyed: boolean = false;

  // Track last known account data for change detection
  private readonly lastAccountData: Map<string, string> = new Map();

  constructor(config: WebSocketConfig, wsManager: WebSocketManager) {
    this.config = config;
    this.wsManager = wsManager;
  }

  /**
   * Start polling and WS recovery timers.
   */
  start(): void {
    if (this.destroyed) return;
    this.ensureHttpConnection();
    this.startPolling();
    this.startWsRecovery();
  }

  /**
   * Stop polling and WS recovery timers.
   */
  stop(): void {
    this.stopPolling();
    this.stopWsRecovery();
  }

  /**
   * Add a subscription to be polled.
   */
  addPollingSubscription(entry: SubscriptionEntry): void {
    this.pollingEntries.set(entry.id, entry);
  }

  /**
   * Remove a subscription from polling.
   */
  removePollingSubscription(id: number): void {
    this.pollingEntries.delete(id);
  }

  /**
   * Destroy the fallback and clean up.
   */
  destroy(): void {
    this.destroyed = true;
    this.stop();
    this.pollingEntries.clear();
    this.lastAccountData.clear();
    this.httpConnection = null;
  }

  /**
   * Get count of active polling subscriptions.
   */
  getPollingCount(): number {
    return this.pollingEntries.size;
  }

  /**
   * Check if polling is active.
   */
  isPolling(): boolean {
    return this.pollingTimer !== null;
  }

  // -- Private Methods --

  private ensureHttpConnection(): void {
    if (this.httpConnection) return;
    const endpoint = this.wsManager.getCurrentEndpoint();
    this.httpConnection = new Connection(endpoint.url, {
      commitment: this.config.commitment,
    });
  }

  private startPolling(): void {
    this.stopPolling();
    // Poll immediately then on interval
    this.pollAll();
    this.pollingTimer = setInterval(() => {
      this.pollAll();
    }, this.config.pollingIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  private startWsRecovery(): void {
    this.stopWsRecovery();
    this.wsRecoveryTimer = setInterval(async () => {
      if (this.destroyed) return;
      try {
        await this.wsManager.reconnect();
      } catch {
        // Recovery attempt failed — will retry on next interval
      }
    }, this.config.wsRecoveryIntervalMs);
  }

  private stopWsRecovery(): void {
    if (this.wsRecoveryTimer) {
      clearInterval(this.wsRecoveryTimer);
      this.wsRecoveryTimer = null;
    }
  }

  private async pollAll(): Promise<void> {
    if (this.destroyed || !this.httpConnection) return;

    const entries = Array.from(this.pollingEntries.values());
    const pollPromises = entries.map((entry) => this.pollEntry(entry));

    await Promise.allSettled(pollPromises);
  }

  private async pollEntry(entry: SubscriptionEntry): Promise<void> {
    if (!this.httpConnection) return;

    try {
      switch (entry.type) {
        case 'account':
        case 'tokenAccount': {
          const params = entry.params as AccountSubscriptionParams | TokenAccountSubscriptionParams;
          const pubkey = new PublicKey(params.pubkey);
          const accountInfo = await this.httpConnection.getAccountInfo(pubkey, this.config.commitment);

          // Change detection: only notify if data changed
          const dataKey = `${entry.type}:${params.pubkey}`;
          const newDataStr = accountInfo ? JSON.stringify(accountInfo.data) : 'null';
          const oldDataStr = this.lastAccountData.get(dataKey);

          if (newDataStr !== oldDataStr) {
            this.lastAccountData.set(dataKey, newDataStr);

            // Don't notify on the first poll (we don't have a baseline)
            if (oldDataStr !== undefined) {
              const notification: SubscriptionNotification = {
                type: entry.type,
                data: { accountInfo, pubkey: params.pubkey },
                timestamp: new Date(),
              };
              entry.callback(notification);
            }
          }
          break;
        }

        case 'program': {
          const params = entry.params as ProgramSubscriptionParams;
          const programId = new PublicKey(params.programId);
          const filters = (params.filters || []).map((f) => {
            if (f.memcmp) {
              return { memcmp: { offset: f.memcmp.offset, bytes: f.memcmp.bytes } };
            }
            return { dataSize: f.dataSize! };
          });

          const accounts = await this.httpConnection.getProgramAccounts(programId, {
            commitment: this.config.commitment,
            filters,
          });

          // Notify for each account (simplified — no per-account change tracking)
          const dataKey = `program:${params.programId}`;
          const newDataStr = JSON.stringify(accounts.map((a) => a.pubkey.toBase58()));
          const oldDataStr = this.lastAccountData.get(dataKey);

          if (newDataStr !== oldDataStr) {
            this.lastAccountData.set(dataKey, newDataStr);

            if (oldDataStr !== undefined) {
              for (const account of accounts) {
                const notification: SubscriptionNotification = {
                  type: 'program',
                  data: {
                    accountId: account.pubkey.toBase58(),
                    accountInfo: account.account,
                    programId: params.programId,
                  },
                  timestamp: new Date(),
                };
                entry.callback(notification);
              }
            }
          }
          break;
        }

        case 'signature': {
          const params = entry.params as SignatureSubscriptionParams;
          const status = await this.httpConnection.getSignatureStatus(params.signature);

          if (status.value?.confirmationStatus === this.config.commitment ||
              status.value?.confirmationStatus === 'finalized') {
            const notification: SubscriptionNotification = {
              type: 'signature',
              data: { result: status.value, signature: params.signature },
              slot: status.context?.slot,
              timestamp: new Date(),
            };
            entry.callback(notification);

            // Signature subscriptions are one-shot
            this.pollingEntries.delete(entry.id);
            this.wsManager.removeSubscription(entry.id);
          }
          break;
        }

        case 'slot': {
          // Slot polling: get current slot
          const slot = await this.httpConnection.getSlot(this.config.commitment);
          const notification: SubscriptionNotification = {
            type: 'slot',
            data: { slot, parent: slot - 1, root: slot - 32 },
            slot,
            timestamp: new Date(),
          };
          entry.callback(notification);
          break;
        }
      }
    } catch {
      // Individual poll errors are silently swallowed — the next poll cycle retries
    }
  }
}
