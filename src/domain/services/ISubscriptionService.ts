/**
 * Subscription Service Interface
 *
 * Domain interface for WebSocket subscription service.
 * Matches EVM subscription service interface shape.
 */

import {
  SubscriptionCallback,
  SubscriptionStatus,
  ProgramFilter,
} from '../../infrastructure/websocket/types';

export interface ISubscriptionService {
  /**
   * Subscribe to SOL balance changes for a wallet.
   * Uses accountSubscribe(pubkey, {commitment: 'confirmed'}).
   */
  subscribeAccountChanges(pubkey: string, callback: SubscriptionCallback): number;

  /**
   * Subscribe to SPL token account changes.
   * Uses accountSubscribe(tokenAccountPubkey, {commitment: 'confirmed'}).
   */
  subscribeTokenAccounts(pubkey: string, callback: SubscriptionCallback): number;

  /**
   * Subscribe to program account changes for DeFi position tracking.
   * Uses programSubscribe(programId, {filters, commitment: 'confirmed'}).
   */
  subscribeProgramChanges(
    programId: string,
    filters: ProgramFilter[],
    callback: SubscriptionCallback
  ): number;

  /**
   * Subscribe to slot changes (new blocks).
   * Uses slotSubscribe() with 2-second debounce window.
   */
  subscribeSlotChanges(callback: SubscriptionCallback): number;

  /**
   * Subscribe to transaction signature status.
   * Uses signatureSubscribe(signature, {commitment: 'confirmed'}).
   */
  subscribeSignatureStatus(signature: string, callback: SubscriptionCallback): number;

  /**
   * Unsubscribe from a subscription by ID.
   */
  unsubscribe(subscriptionId: number): void;

  /**
   * Get current subscription service status.
   */
  getSubscriptionStatus(): SubscriptionStatus;

  /**
   * Destroy the service and clean up all resources.
   */
  destroy(): void;
}
