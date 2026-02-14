/**
 * Domain Error Types
 * 
 * Comprehensive error hierarchy for Solana integration domain.
 * Enables precise error handling and recovery strategies.
 */

export abstract class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context?: Record<string, any>
  ) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, any> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context
    };
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, field?: string, value?: any) {
    super('VALIDATION_ERROR', message, { field, value });
  }
}

export class InvalidPublicKeyError extends ValidationError {
  constructor(publicKey: string) {
    super(`Invalid Solana public key: ${publicKey}`, 'publicKey', publicKey);
  }
}

export class InvalidMintAddressError extends ValidationError {
  constructor(mint: string) {
    super(`Invalid SPL token mint address: ${mint}`, 'mint', mint);
  }
}

export class NetworkError extends DomainError {
  constructor(
    message: string,
    public readonly endpoint?: string,
    public readonly retryable: boolean = true
  ) {
    super('NETWORK_ERROR', message, { endpoint, retryable });
  }
}

export class RPCError extends NetworkError {
  constructor(
    message: string,
    endpoint: string,
    public readonly rpcCode?: number,
    public readonly rpcMessage?: string
  ) {
    super(message, endpoint, true);
    this.context = { ...this.context, rpcCode, rpcMessage };
  }
}

export class TimeoutError extends NetworkError {
  constructor(operation: string, timeoutMs: number, endpoint?: string) {
    super(
      `Operation '${operation}' timed out after ${timeoutMs}ms`,
      endpoint,
      true
    );
    this.context = { ...this.context, operation, timeoutMs };
  }
}

export class InsufficientBalanceError extends DomainError {
  constructor(
    required: string,
    available: string,
    token: string
  ) {
    super(
      'INSUFFICIENT_BALANCE',
      `Insufficient ${token} balance: required ${required}, available ${available}`,
      { required, available, token }
    );
  }
}

export class AssetNotFoundError extends DomainError {
  constructor(assetId: string, context?: string) {
    super(
      'ASSET_NOT_FOUND',
      `Asset '${assetId}' not found${context ? ` in ${context}` : ''}`,
      { assetId, context }
    );
  }
}

export class MetadataFetchError extends DomainError {
  constructor(
    mint: string,
    reason?: string,
    public readonly retryable: boolean = true
  ) {
    super(
      'METADATA_FETCH_ERROR',
      `Failed to fetch metadata for mint ${mint}${reason ? `: ${reason}` : ''}`,
      { mint, retryable }
    );
  }
}

export class NFTParseError extends DomainError {
  constructor(mint: string, reason: string) {
    super(
      'NFT_PARSE_ERROR',
      `Failed to parse NFT metadata for ${mint}: ${reason}`,
      { mint }
    );
  }
}

export class PortfolioError extends DomainError {
  constructor(message: string, context?: Record<string, any>) {
    super('PORTFOLIO_ERROR', message, context);
  }
}

export class CacheError extends DomainError {
  constructor(operation: string, reason?: string) {
    super(
      'CACHE_ERROR',
      `Cache operation '${operation}' failed${reason ? `: ${reason}` : ''}`,
      { operation }
    );
  }
}

export class AggregationError extends DomainError {
  constructor(message: string, items?: any[]) {
    super('AGGREGATION_ERROR', message, { itemCount: items?.length });
  }
}

export class ConfigurationError extends DomainError {
  constructor(setting: string, reason?: string) {
    super(
      'CONFIGURATION_ERROR',
      `Invalid configuration for '${setting}'${reason ? `: ${reason}` : ''}`,
      { setting }
    );
  }
}

export class RPCConnectionError extends NetworkError {
  constructor(
    message: string,
    endpoint: string,
    public readonly connectionType: 'websocket' | 'http' = 'http'
  ) {
    super(message, endpoint, true);
    this.context = { ...this.context, connectionType };
  }
}

export class TokenNotFoundError extends DomainError {
  constructor(
    public readonly mintAddress: string,
    public readonly searchContext?: string
  ) {
    super(
      'TOKEN_NOT_FOUND',
      `Token with mint address '${mintAddress}' not found${searchContext ? ` in ${searchContext}` : ''}`,
      { mintAddress, searchContext }
    );
  }
}

export class CircuitBreakerOpenError extends DomainError {
  constructor(
    endpointId: string,
    public readonly estimatedRecoveryTime: Date
  ) {
    super(
      'CIRCUIT_BREAKER_OPEN',
      `Circuit breaker is open for endpoint '${endpointId}'. Estimated recovery time: ${estimatedRecoveryTime.toISOString()}`,
      { endpointId, estimatedRecoveryTime: estimatedRecoveryTime.toISOString() }
    );
  }
}

export class RateLimitError extends NetworkError {
  constructor(
    operation: string,
    endpoint: string,
    public readonly resetTime?: Date,
    public readonly remainingQuota?: number
  ) {
    super(
      `Rate limit exceeded for operation '${operation}' on endpoint ${endpoint}`,
      endpoint,
      true
    );
    this.context = { 
      ...this.context, 
      operation, 
      resetTime: resetTime?.toISOString(),
      remainingQuota 
    };
  }
}

export class PortfolioValidationError extends DomainError {
  constructor(
    portfolioId: string,
    validationMessage: string,
    public readonly field?: string
  ) {
    super(
      'PORTFOLIO_VALIDATION_ERROR',
      `Portfolio validation failed for '${portfolioId}': ${validationMessage}`,
      { portfolioId, field }
    );
  }
}

export class TokenAccountError extends DomainError {
  constructor(
    public readonly tokenAccount: string,
    message: string,
    public readonly mint?: string,
    public readonly owner?: string
  ) {
    super(
      'TOKEN_ACCOUNT_ERROR',
      message,
      { tokenAccount, mint, owner }
    );
  }
}

export class MetaplexMetadataError extends DomainError {
  constructor(
    mint: string,
    reason: string,
    public readonly metadataAccount?: string
  ) {
    super(
      'METAPLEX_METADATA_ERROR',
      `Failed to process Metaplex metadata for mint ${mint}: ${reason}`,
      { mint, metadataAccount }
    );
  }
}

export class BalanceMismatchError extends DomainError {
  constructor(
    public readonly mintAddress: string,
    public readonly expectedBalance: string,
    public readonly actualBalance: string,
    public readonly tokenAccount?: string
  ) {
    super(
      'BALANCE_MISMATCH_ERROR',
      `Balance mismatch for token ${mintAddress}: expected ${expectedBalance}, got ${actualBalance}`,
      { mintAddress, expectedBalance, actualBalance, tokenAccount }
    );
  }
}

export class DuplicateAssetError extends DomainError {
  constructor(
    public readonly mintAddress: string,
    public readonly portfolioId?: string
  ) {
    super(
      'DUPLICATE_ASSET_ERROR',
      `Asset with mint address '${mintAddress}' already exists${portfolioId ? ` in portfolio '${portfolioId}'` : ''}`,
      { mintAddress, portfolioId }
    );
  }
}

export class StaleDataError extends DomainError {
  constructor(
    dataType: string,
    public readonly lastUpdated: Date,
    public readonly maxAge: number // milliseconds
  ) {
    const ageMs = Date.now() - lastUpdated.getTime();
    super(
      'STALE_DATA_ERROR',
      `${dataType} data is stale: last updated ${lastUpdated.toISOString()}, age ${ageMs}ms, max age ${maxAge}ms`,
      { dataType, lastUpdated: lastUpdated.toISOString(), ageMs, maxAge }
    );
  }
}

export class ConnectionPoolExhaustedError extends DomainError {
  constructor(
    public readonly poolSize: number,
    public readonly activeConnections: number
  ) {
    super(
      'CONNECTION_POOL_EXHAUSTED',
      `Connection pool exhausted: ${activeConnections}/${poolSize} connections in use`,
      { poolSize, activeConnections }
    );
  }
}

export class UnsupportedOperationError extends DomainError {
  constructor(
    operation: string,
    context?: string
  ) {
    super(
      'UNSUPPORTED_OPERATION',
      `Operation '${operation}' is not supported${context ? ` in ${context}` : ''}`,
      { operation, context }
    );
  }
}

export class ConcurrencyLimitError extends DomainError {
  constructor(
    operation: string,
    public readonly currentConcurrency: number,
    public readonly maxConcurrency: number
  ) {
    super(
      'CONCURRENCY_LIMIT_ERROR',
      `Concurrency limit exceeded for operation '${operation}': ${currentConcurrency}/${maxConcurrency}`,
      { operation, currentConcurrency, maxConcurrency }
    );
  }
}

export class ResourceNotFoundError extends DomainError {
  constructor(
    resourceType: string,
    resourceId: string,
    public readonly searchCriteria?: Record<string, any>
  ) {
    super(
      'RESOURCE_NOT_FOUND',
      `${resourceType} with ID '${resourceId}' not found`,
      { resourceType, resourceId, searchCriteria }
    );
  }
}

export class SerializationError extends DomainError {
  constructor(
    objectType: string,
    reason: string,
    public readonly data?: any
  ) {
    super(
      'SERIALIZATION_ERROR',
      `Failed to serialize ${objectType}: ${reason}`,
      { objectType, dataType: typeof data }
    );
  }
}

export class DeserializationError extends DomainError {
  constructor(
    objectType: string,
    reason: string,
    public readonly rawData?: any
  ) {
    super(
      'DESERIALIZATION_ERROR',
      `Failed to deserialize ${objectType}: ${reason}`,
      { objectType, rawDataType: typeof rawData }
    );
  }
}

/**
 * Generic operation error for infrastructure and application layer failures
 */
export class OperationError extends DomainError {
  constructor(
    code: string,
    message: string,
    context?: Record<string, any>
  ) {
    super(code, message, context);
  }
}