/**
 * WebSocket Subscription Types
 *
 * Defines types for the Solana WebSocket subscription service.
 */

export type SubscriptionType = 'account' | 'tokenAccount' | 'program' | 'slot' | 'signature';

export type WebSocketState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface WebSocketEndpointConfig {
  url: string;
  name: string;
  priority: number;
  wsUrl: string;
  maxSubscriptions?: number;
}

export interface WebSocketConfig {
  endpoints: WebSocketEndpointConfig[];
  commitment: 'processed' | 'confirmed' | 'finalized';
  heartbeatIntervalMs: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  reconnectMaxAttempts: number;
  slotDebounceDurationMs: number;
  pollingIntervalMs: number;
  wsRecoveryIntervalMs: number;
}

export const DEFAULT_WS_CONFIG: Omit<WebSocketConfig, 'endpoints'> = {
  commitment: 'confirmed',
  heartbeatIntervalMs: 30_000,
  reconnectBaseDelayMs: 1_000,
  reconnectMaxDelayMs: 60_000,
  reconnectMaxAttempts: Infinity,
  slotDebounceDurationMs: 2_000,
  pollingIntervalMs: 30_000,
  wsRecoveryIntervalMs: 60_000,
};

export interface SubscriptionEntry {
  id: number;
  type: SubscriptionType;
  params: SubscriptionParams;
  callback: SubscriptionCallback;
  createdAt: Date;
}

export type SubscriptionParams =
  | AccountSubscriptionParams
  | TokenAccountSubscriptionParams
  | ProgramSubscriptionParams
  | SlotSubscriptionParams
  | SignatureSubscriptionParams;

export interface AccountSubscriptionParams {
  type: 'account';
  pubkey: string;
}

export interface TokenAccountSubscriptionParams {
  type: 'tokenAccount';
  pubkey: string;
}

export interface ProgramSubscriptionParams {
  type: 'program';
  programId: string;
  filters?: ProgramFilter[];
}

export interface ProgramFilter {
  memcmp?: { offset: number; bytes: string };
  dataSize?: number;
}

export interface SlotSubscriptionParams {
  type: 'slot';
}

export interface SignatureSubscriptionParams {
  type: 'signature';
  signature: string;
}

export type SubscriptionCallback = (data: SubscriptionNotification) => void;

export interface SubscriptionNotification {
  type: SubscriptionType;
  data: any;
  slot?: number;
  timestamp: Date;
}

export interface SubscriptionStatus {
  state: WebSocketState;
  activeSubscriptions: number;
  endpointName: string;
  endpointUrl: string;
  connectedSince?: Date;
  reconnectAttempts: number;
  isPollingFallback: boolean;
  subscriptions: SubscriptionSummary[];
}

export interface SubscriptionSummary {
  id: number;
  type: SubscriptionType;
  createdAt: Date;
}
