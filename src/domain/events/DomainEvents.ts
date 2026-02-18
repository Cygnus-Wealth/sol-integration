/**
 * Domain Events
 * 
 * Defines domain events for the Solana integration.
 * Enables decoupled communication between domain components.
 */

import { PublicKeyVO } from '../asset/valueObjects/PublicKeyVO';
import { TokenAmount } from '../asset/valueObjects/TokenAmount';
import { DomainError } from '../shared/DomainError';

/**
 * Base Domain Event
 */
export abstract class DomainEvent {
  public readonly eventId: string;
  public readonly eventType: string;
  public readonly aggregateId: string;
  public readonly aggregateType: string;
  public readonly occurredAt: Date;
  public readonly version: number;

  constructor(
    eventType: string,
    aggregateId: string,
    aggregateType: string,
    version: number = 1
  ) {
    this.eventId = this.generateEventId();
    this.eventType = eventType;
    this.aggregateId = aggregateId;
    this.aggregateType = aggregateType;
    this.occurredAt = new Date();
    this.version = version;
  }

  private generateEventId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  abstract getPayload(): Record<string, any>;

  toJSON(): Record<string, any> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      aggregateType: this.aggregateType,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      payload: this.getPayload()
    };
  }
}

/**
 * Balance Updated Event
 */
export class BalanceUpdatedEvent extends DomainEvent {
  constructor(
    public readonly walletAddress: PublicKeyVO,
    public readonly mintAddress: PublicKeyVO,
    public readonly oldBalance: TokenAmount,
    public readonly newBalance: TokenAmount,
    public readonly tokenAccount?: PublicKeyVO,
    public readonly slot?: number
  ) {
    super(
      'BalanceUpdated',
      walletAddress.toBase58(),
      'Wallet'
    );
  }

  getPayload(): Record<string, any> {
    return {
      walletAddress: this.walletAddress.toBase58(),
      mintAddress: this.mintAddress.toBase58(),
      oldBalance: {
        amount: this.oldBalance.getAmount(),
        decimals: this.oldBalance.getDecimals(),
        uiAmount: this.oldBalance.getUIAmount()
      },
      newBalance: {
        amount: this.newBalance.getAmount(),
        decimals: this.newBalance.getDecimals(),
        uiAmount: this.newBalance.getUIAmount()
      },
      tokenAccount: this.tokenAccount?.toBase58(),
      slot: this.slot,
      balanceChange: {
        amount: this.newBalance.subtract(this.oldBalance).getAmount(),
        percentage: this.calculatePercentageChange()
      }
    };
  }

  private calculatePercentageChange(): number {
    if (this.oldBalance.isZero()) {
      return this.newBalance.isZero() ? 0 : 100;
    }
    
    const oldAmount = this.oldBalance.getUIAmount();
    const newAmount = this.newBalance.getUIAmount();
    
    return ((newAmount - oldAmount) / oldAmount) * 100;
  }

  isIncrease(): boolean {
    return this.newBalance.compareTo(this.oldBalance) > 0;
  }

  isDecrease(): boolean {
    return this.newBalance.compareTo(this.oldBalance) < 0;
  }

  isSignificantChange(thresholdPercentage: number = 5): boolean {
    return Math.abs(this.calculatePercentageChange()) >= thresholdPercentage;
  }
}

/**
 * Asset Discovered Event
 */
export class AssetDiscoveredEvent extends DomainEvent {
  constructor(
    public readonly walletAddress: PublicKeyVO,
    public readonly mintAddress: PublicKeyVO,
    public readonly assetType: 'native' | 'token' | 'nft',
    public readonly symbol: string,
    public readonly name: string,
    public readonly balance: TokenAmount,
    public readonly tokenAccount?: PublicKeyVO,
    public readonly isVerified: boolean = false,
    public readonly discoveryMethod: 'token_account_scan' | 'metadata_lookup' | 'manual_add' = 'token_account_scan'
  ) {
    super(
      'AssetDiscovered',
      walletAddress.toBase58(),
      'Wallet'
    );
  }

  getPayload(): Record<string, any> {
    return {
      walletAddress: this.walletAddress.toBase58(),
      mintAddress: this.mintAddress.toBase58(),
      assetType: this.assetType,
      symbol: this.symbol,
      name: this.name,
      balance: {
        amount: this.balance.getAmount(),
        decimals: this.balance.getDecimals(),
        uiAmount: this.balance.getUIAmount()
      },
      tokenAccount: this.tokenAccount?.toBase58(),
      isVerified: this.isVerified,
      discoveryMethod: this.discoveryMethod
    };
  }

  isFirstDiscovery(): boolean {
    return this.discoveryMethod === 'token_account_scan';
  }

  isManuallyAdded(): boolean {
    return this.discoveryMethod === 'manual_add';
  }

  hasBalance(): boolean {
    return this.balance.isPositive();
  }
}

/**
 * Connection Failed Event
 */
export class ConnectionFailedEvent extends DomainEvent {
  constructor(
    public readonly endpointId: string,
    public readonly endpointUrl: string,
    public readonly error: DomainError,
    public readonly operation: string,
    public readonly attemptNumber: number = 1,
    public readonly willRetry: boolean = false,
    public readonly latency?: number
  ) {
    super(
      'ConnectionFailed',
      endpointId,
      'ConnectionEndpoint'
    );
  }

  getPayload(): Record<string, any> {
    return {
      endpointId: this.endpointId,
      endpointUrl: this.endpointUrl,
      error: {
        code: this.error.code,
        message: this.error.message,
        context: this.error.context
      },
      operation: this.operation,
      attemptNumber: this.attemptNumber,
      willRetry: this.willRetry,
      latency: this.latency,
      isRetryableError: this.isRetryableError(),
      failureCategory: this.categorizeFailure()
    };
  }

  private isRetryableError(): boolean {
    return this.error.code === 'NETWORK_ERROR' || 
           this.error.code === 'TIMEOUT_ERROR' ||
           this.error.code === 'RPC_ERROR';
  }

  private categorizeFailure(): string {
    if (this.error.code === 'TIMEOUT_ERROR') return 'timeout';
    if (this.error.code === 'NETWORK_ERROR') return 'network';
    if (this.error.code === 'RPC_ERROR') return 'rpc';
    if (this.error.code === 'VALIDATION_ERROR') return 'validation';
    return 'unknown';
  }

  isCriticalFailure(): boolean {
    return !this.isRetryableError() || this.attemptNumber >= 3;
  }
}

/**
 * Portfolio Synced Event
 */
export class PortfolioSyncedEvent extends DomainEvent {
  constructor(
    public readonly walletAddress: PublicKeyVO,
    public readonly assetCount: number,
    public readonly nftCount: number,
    public readonly totalValueSOL: TokenAmount,
    public readonly syncDuration: number, // milliseconds
    public readonly changedAssets: string[] = [],
    public readonly newAssets: string[] = [],
    public readonly removedAssets: string[] = []
  ) {
    super(
      'PortfolioSynced',
      walletAddress.toBase58(),
      'Portfolio'
    );
  }

  getPayload(): Record<string, any> {
    return {
      walletAddress: this.walletAddress.toBase58(),
      assetCount: this.assetCount,
      nftCount: this.nftCount,
      totalValueSOL: {
        amount: this.totalValueSOL.getAmount(),
        uiAmount: this.totalValueSOL.getUIAmount()
      },
      syncDuration: this.syncDuration,
      changedAssets: this.changedAssets,
      newAssets: this.newAssets,
      removedAssets: this.removedAssets,
      hasChanges: this.hasChanges(),
      syncPerformance: this.categorizePerformance()
    };
  }

  hasChanges(): boolean {
    return this.changedAssets.length > 0 || 
           this.newAssets.length > 0 || 
           this.removedAssets.length > 0;
  }

  private categorizePerformance(): string {
    if (this.syncDuration < 1000) return 'fast';
    if (this.syncDuration < 5000) return 'normal';
    if (this.syncDuration < 15000) return 'slow';
    return 'very_slow';
  }

  getTotalAssets(): number {
    return this.assetCount + this.nftCount;
  }
}

/**
 * NFT Metadata Updated Event
 */
export class NFTMetadataUpdatedEvent extends DomainEvent {
  constructor(
    public readonly mintAddress: PublicKeyVO,
    public readonly walletAddress: PublicKeyVO,
    public readonly updatedFields: string[],
    public readonly previousMetadata: Record<string, any>,
    public readonly newMetadata: Record<string, any>
  ) {
    super(
      'NFTMetadataUpdated',
      mintAddress.toBase58(),
      'NFT'
    );
  }

  getPayload(): Record<string, any> {
    return {
      mintAddress: this.mintAddress.toBase58(),
      walletAddress: this.walletAddress.toBase58(),
      updatedFields: this.updatedFields,
      previousMetadata: this.previousMetadata,
      newMetadata: this.newMetadata,
      changes: this.calculateChanges()
    };
  }

  private calculateChanges(): Record<string, { from: any; to: any }> {
    const changes: Record<string, { from: any; to: any }> = {};
    
    for (const field of this.updatedFields) {
      changes[field] = {
        from: this.previousMetadata[field],
        to: this.newMetadata[field]
      };
    }
    
    return changes;
  }

  isNameChanged(): boolean {
    return this.updatedFields.includes('name');
  }

  isImageChanged(): boolean {
    return this.updatedFields.includes('image');
  }

  isVerificationChanged(): boolean {
    return this.updatedFields.includes('verified');
  }
}

/**
 * Token Account Created Event
 */
export class TokenAccountCreatedEvent extends DomainEvent {
  constructor(
    public readonly walletAddress: PublicKeyVO,
    public readonly tokenAccount: PublicKeyVO,
    public readonly mintAddress: PublicKeyVO,
    public readonly initialBalance: TokenAmount
  ) {
    super(
      'TokenAccountCreated',
      walletAddress.toBase58(),
      'Wallet'
    );
  }

  getPayload(): Record<string, any> {
    return {
      walletAddress: this.walletAddress.toBase58(),
      tokenAccount: this.tokenAccount.toBase58(),
      mintAddress: this.mintAddress.toBase58(),
      initialBalance: {
        amount: this.initialBalance.getAmount(),
        decimals: this.initialBalance.getDecimals(),
        uiAmount: this.initialBalance.getUIAmount()
      }
    };
  }
}

/**
 * Rate Limit Exceeded Event
 */
export class RateLimitExceededEvent extends DomainEvent {
  constructor(
    public readonly endpointId: string,
    public readonly endpointUrl: string,
    public readonly operation: string,
    public readonly currentRate: number,
    public readonly rateLimit: number,
    public readonly resetTime?: Date
  ) {
    super(
      'RateLimitExceeded',
      endpointId,
      'ConnectionEndpoint'
    );
  }

  getPayload(): Record<string, any> {
    return {
      endpointId: this.endpointId,
      endpointUrl: this.endpointUrl,
      operation: this.operation,
      currentRate: this.currentRate,
      rateLimit: this.rateLimit,
      utilizationPercentage: (this.currentRate / this.rateLimit) * 100,
      resetTime: this.resetTime?.toISOString(),
      waitTimeSeconds: this.calculateWaitTime()
    };
  }

  private calculateWaitTime(): number {
    if (!this.resetTime) return 60; // Default 1 minute
    return Math.max(0, Math.ceil((this.resetTime.getTime() - Date.now()) / 1000));
  }
}

/**
 * Circuit Breaker Opened Event
 */
export class CircuitBreakerOpenedEvent extends DomainEvent {
  constructor(
    public readonly endpointId: string,
    public readonly endpointUrl: string,
    public readonly failureCount: number,
    public readonly failureThreshold: number,
    public readonly timeWindow: number, // milliseconds
    public readonly lastErrors: DomainError[]
  ) {
    super(
      'CircuitBreakerOpened',
      endpointId,
      'ConnectionEndpoint'
    );
  }

  getPayload(): Record<string, any> {
    return {
      endpointId: this.endpointId,
      endpointUrl: this.endpointUrl,
      failureCount: this.failureCount,
      failureThreshold: this.failureThreshold,
      failureRate: (this.failureCount / this.failureThreshold) * 100,
      timeWindow: this.timeWindow,
      lastErrors: this.lastErrors.map(error => ({
        code: error.code,
        message: error.message,
        context: error.context
      })),
      estimatedRecoveryTime: new Date(Date.now() + this.timeWindow).toISOString()
    };
  }
}

/**
 * WebSocket Connected Event
 */
export class WebSocketConnectedEvent extends DomainEvent {
  constructor(
    public readonly endpointUrl: string,
    public readonly endpointName: string
  ) {
    super('WebSocketConnected', endpointName, 'WebSocket');
  }

  getPayload(): Record<string, any> {
    return {
      endpointUrl: this.endpointUrl,
      endpointName: this.endpointName,
    };
  }
}

/**
 * WebSocket Disconnected Event
 */
export class WebSocketDisconnectedEvent extends DomainEvent {
  constructor(
    public readonly endpointUrl: string,
    public readonly endpointName: string,
    public readonly reason: string,
    public readonly wasClean: boolean
  ) {
    super('WebSocketDisconnected', endpointName, 'WebSocket');
  }

  getPayload(): Record<string, any> {
    return {
      endpointUrl: this.endpointUrl,
      endpointName: this.endpointName,
      reason: this.reason,
      wasClean: this.wasClean,
    };
  }
}

/**
 * WebSocket Reconnecting Event
 */
export class WebSocketReconnectingEvent extends DomainEvent {
  constructor(
    public readonly endpointUrl: string,
    public readonly endpointName: string,
    public readonly attempt: number,
    public readonly delayMs: number
  ) {
    super('WebSocketReconnecting', endpointName, 'WebSocket');
  }

  getPayload(): Record<string, any> {
    return {
      endpointUrl: this.endpointUrl,
      endpointName: this.endpointName,
      attempt: this.attempt,
      delayMs: this.delayMs,
    };
  }
}

/**
 * WebSocket Error Event
 */
export class WebSocketErrorEvent extends DomainEvent {
  constructor(
    public readonly endpointUrl: string,
    public readonly endpointName: string,
    public readonly errorMessage: string
  ) {
    super('WebSocketError', endpointName, 'WebSocket');
  }

  getPayload(): Record<string, any> {
    return {
      endpointUrl: this.endpointUrl,
      endpointName: this.endpointName,
      errorMessage: this.errorMessage,
    };
  }
}

/**
 * WebSocket Fallback Activated Event
 */
export class WebSocketFallbackActivatedEvent extends DomainEvent {
  constructor(
    public readonly endpointName: string,
    public readonly pollingIntervalMs: number
  ) {
    super('WebSocketFallbackActivated', endpointName, 'WebSocket');
  }

  getPayload(): Record<string, any> {
    return {
      endpointName: this.endpointName,
      pollingIntervalMs: this.pollingIntervalMs,
    };
  }
}

/**
 * WebSocket Fallback Deactivated Event
 */
export class WebSocketFallbackDeactivatedEvent extends DomainEvent {
  constructor(
    public readonly endpointName: string
  ) {
    super('WebSocketFallbackDeactivated', endpointName, 'WebSocket');
  }

  getPayload(): Record<string, any> {
    return {
      endpointName: this.endpointName,
    };
  }
}

/**
 * Event Bus Interface
 */
export interface IDomainEventBus {
  /**
   * Publish a domain event
   */
  publish<T extends DomainEvent>(event: T): Promise<void>;

  /**
   * Subscribe to domain events
   */
  subscribe<T extends DomainEvent>(
    eventType: string,
    handler: (event: T) => Promise<void>
  ): void;

  /**
   * Unsubscribe from domain events
   */
  unsubscribe(eventType: string, handler: Function): void;

  /**
   * Publish multiple events as a batch
   */
  publishBatch(events: DomainEvent[]): Promise<void>;

  /**
   * Get event history for an aggregate
   */
  getEventHistory(aggregateId: string, aggregateType: string): Promise<DomainEvent[]>;

  /**
   * Clear event history
   */
  clearEventHistory(aggregateId?: string): Promise<void>;
}

/**
 * Event Store Interface
 */
export interface IDomainEventStore {
  /**
   * Store a domain event
   */
  store(event: DomainEvent): Promise<void>;

  /**
   * Store multiple events
   */
  storeBatch(events: DomainEvent[]): Promise<void>;

  /**
   * Get events by aggregate ID
   */
  getEvents(aggregateId: string, aggregateType?: string): Promise<DomainEvent[]>;

  /**
   * Get events by type
   */
  getEventsByType(eventType: string): Promise<DomainEvent[]>;

  /**
   * Get events in time range
   */
  getEventsInRange(startTime: Date, endTime: Date): Promise<DomainEvent[]>;

  /**
   * Get event count
   */
  getEventCount(aggregateId?: string, eventType?: string): Promise<number>;

  /**
   * Delete old events
   */
  deleteOldEvents(olderThanDate: Date): Promise<number>;
}