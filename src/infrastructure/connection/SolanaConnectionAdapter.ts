/**
 * Enhanced Solana Connection Adapter
 * 
 * Anti-corruption layer adapting @solana/web3.js to domain interfaces.
 * Handles RPC communication, retries, circuit breaker, and error translation.
 */

import { Connection, PublicKey, ParsedAccountData, GetProgramAccountsFilter } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PublicKeyVO } from '../../domain/asset/valueObjects/PublicKeyVO';
import { ISolanaConnection, TokenAccountInfo } from '../../domain/services/SolanaBalanceService';
import {
  ITokenDiscoveryConnection,
  TokenAccountData as DiscoveryTokenAccountData,
  SPLTokenMetadata
} from '../../domain/services/TokenDiscoveryService';
import { NFTMetaplexMetadata } from '../../domain/asset/entities/NFTAsset';
import { Result } from '../../domain/shared/Result';
import { DomainError, NetworkError, TimeoutError, RPCError, OperationError } from '../../domain/shared/DomainError';
import { CircuitBreaker, CircuitBreakerConfig } from '../resilience/CircuitBreaker';
import { RetryPolicy, RetryStrategy } from '../resilience/RetryPolicy';

export interface ConnectionConfig {
  endpoint: string;
  commitment?: 'processed' | 'confirmed' | 'finalized';
  timeout?: number;
  wsEndpoint?: string;
  httpHeaders?: Record<string, string>;
  network?: 'mainnet-beta' | 'testnet' | 'devnet';
  enableRetries?: boolean;
  enableCircuitBreaker?: boolean;
  maxRetries?: number;
  retryBaseDelay?: number;
  circuitBreakerConfig?: Partial<CircuitBreakerConfig>;
}

export class SolanaConnectionAdapter implements ISolanaConnection, ITokenDiscoveryConnection {
  private connection: Connection;
  private readonly timeout: number;
  private readonly commitment: 'processed' | 'confirmed' | 'finalized';
  private readonly circuitBreaker?: CircuitBreaker;
  private readonly retryPolicy?: RetryPolicy;
  private readonly config: ConnectionConfig;

  constructor(config: ConnectionConfig) {
    this.config = config;
    this.timeout = config.timeout || 30000;
    this.commitment = config.commitment || 'confirmed';
    
    this.connection = new Connection(config.endpoint, {
      commitment: this.commitment,
      wsEndpoint: config.wsEndpoint,
      httpHeaders: config.httpHeaders,
      confirmTransactionInitialTimeout: this.timeout
    });

    // Initialize circuit breaker if enabled
    if (config.enableCircuitBreaker !== false) {
      const circuitConfig: CircuitBreakerConfig = {
        failureThreshold: 5,
        recoveryTimeout: 30000,
        successThreshold: 2,
        timeout: this.timeout,
        monitoringPeriod: 60000,
        ...config.circuitBreakerConfig,
        onStateChange: (oldState, newState, reason) => {
          console.warn(`[${config.endpoint}] Circuit breaker state changed: ${oldState} -> ${newState}. Reason: ${reason}`);
        }
      };
      
      this.circuitBreaker = new CircuitBreaker(`solana-connection-${config.endpoint}`, circuitConfig);
    }

    // Initialize retry policy if enabled
    if (config.enableRetries !== false) {
      this.retryPolicy = new RetryPolicy(`solana-connection-${config.endpoint}`, {
        maxAttempts: config.maxRetries || 3,
        baseDelay: config.retryBaseDelay || 1000,
        maxDelay: 30000,
        backoffMultiplier: 2,
        jitter: true,
        retryableErrors: ['NETWORK_ERROR', 'TIMEOUT_ERROR', 'RPC_ERROR'],
        onRetry: (attempt, error, delay) => {
          console.warn(`[${config.endpoint}] Retry attempt ${attempt} after ${delay}ms. Error: ${error.message}`);
        }
      }, RetryStrategy.EXPONENTIAL_BACKOFF);
    }
  }

  async getBalance(wallet: PublicKeyVO): Promise<Result<bigint, DomainError>> {
    return this.executeWithResilience(async () => {
      const publicKey = wallet.toPublicKey();
      const lamports = await this.withTimeout(
        this.connection.getBalance(publicKey, this.commitment),
        'getBalance'
      );
      
      return BigInt(lamports);
    }, 'getBalance');
  }

  async getTokenAccounts(wallet: PublicKeyVO): Promise<Result<TokenAccountInfo[], DomainError>> {
    return this.executeWithResilience(async () => {
      const publicKey = wallet.toPublicKey();
      const tokenAccounts: TokenAccountInfo[] = [];

      // Fetch both TOKEN_PROGRAM_ID and TOKEN_2022_PROGRAM_ID accounts
      const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
      
      for (const programId of programs) {
        const accounts = await this.withTimeout(
          this.connection.getParsedTokenAccountsByOwner(
            publicKey,
            { programId },
            this.commitment
          ),
          'getTokenAccounts'
        );

        for (const account of accounts.value) {
          const parsedData = account.account.data as ParsedAccountData;
          const info = parsedData.parsed.info;
          
          if (info.tokenAmount) {
            tokenAccounts.push({
              pubkey: PublicKeyVO.fromPublicKey(account.pubkey),
              mint: PublicKeyVO.create(info.mint),
              amount: info.tokenAmount.amount,
              decimals: info.tokenAmount.decimals,
              uiAmount: info.tokenAmount.uiAmount
            });
          }
        }
      }

      return tokenAccounts;
    }, 'getTokenAccounts');
  }

  async getTokenAccountsByOwner(owner: PublicKeyVO): Promise<Result<DiscoveryTokenAccountData[], DomainError>> {
    return this.executeWithResilience(async () => {
      const publicKey = owner.toPublicKey();
      const tokenAccounts: DiscoveryTokenAccountData[] = [];

      const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

      for (const programId of programs) {
        const accounts = await this.withTimeout(
          this.connection.getParsedTokenAccountsByOwner(
            publicKey,
            { programId },
            this.commitment
          ),
          'getTokenAccountsByOwner'
        );

        for (const account of accounts.value) {
          const parsedData = account.account.data as ParsedAccountData;
          const info = parsedData.parsed.info;

          if (info.tokenAmount) {
            tokenAccounts.push({
              pubkey: PublicKeyVO.fromPublicKey(account.pubkey),
              mint: PublicKeyVO.create(info.mint),
              owner: owner,
              amount: info.tokenAmount.amount,
              decimals: info.tokenAmount.decimals,
              uiAmount: info.tokenAmount.uiAmount,
              state: info.state || 'initialized'
            });
          }
        }
      }

      return tokenAccounts;
    }, 'getTokenAccountsByOwner');
  }

  async getNFTMetadata(mint: PublicKeyVO): Promise<Result<NFTMetaplexMetadata | null, DomainError>> {
    return this.executeWithResilience(async () => {
      const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
      const [metadataPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('metadata'),
          METADATA_PROGRAM_ID.toBuffer(),
          mint.toPublicKey().toBuffer()
        ],
        METADATA_PROGRAM_ID
      );

      const accountInfo = await this.withTimeout(
        this.connection.getAccountInfo(metadataPDA),
        'getNFTMetadata'
      );

      if (!accountInfo) {
        return null;
      }

      // Parse minimal NFT metadata from on-chain data
      return {
        name: 'Unknown NFT',
        symbol: 'NFT',
        description: undefined,
        image: undefined,
        external_url: undefined,
        attributes: []
      };
    }, 'getNFTMetadata');
  }

  async getMultipleTokenMetadata(mints: PublicKeyVO[]): Promise<Result<Map<string, SPLTokenMetadata>, DomainError>> {
    return this.executeWithResilience(async () => {
      const metadataMap = new Map<string, SPLTokenMetadata>();

      for (const mint of mints) {
        const result = await this.getTokenMetadata(mint);
        if (result.isSuccess) {
          const metadata = result.getValue();
          if (metadata) {
            metadataMap.set(mint.toBase58(), metadata);
          }
        }
      }

      return metadataMap;
    }, 'getMultipleTokenMetadata');
  }

  async getSlot(): Promise<Result<number, DomainError>> {
    return this.executeWithResilience(async () => {
      const slot = await this.withTimeout(
        this.connection.getSlot(this.commitment),
        'getSlot'
      );
      return slot;
    }, 'getSlot');
  }

  async getMultipleAccounts(addresses: PublicKeyVO[]): Promise<Result<any[], DomainError>> {
    return this.executeWithResilience(async () => {
      const publicKeys = addresses.map(addr => addr.toPublicKey());
      const accounts = await this.withTimeout(
        this.connection.getMultipleAccountsInfo(publicKeys, this.commitment),
        'getMultipleAccounts'
      );
      
      return accounts;
    }, 'getMultipleAccounts');
  }

  /**
   * Get token metadata (Metaplex standard)
   */
  async getTokenMetadata(mint: PublicKeyVO): Promise<Result<SPLTokenMetadata | null, DomainError>> {
    return this.executeWithResilience(async () => {
      // Metaplex metadata PDA derivation
      const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
      const [metadataPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('metadata'),
          METADATA_PROGRAM_ID.toBuffer(),
          mint.toPublicKey().toBuffer()
        ],
        METADATA_PROGRAM_ID
      );

      const accountInfo = await this.withTimeout(
        this.connection.getAccountInfo(metadataPDA),
        'getTokenMetadata'
      );

      if (!accountInfo) {
        return null;
      }

      // Parse minimal metadata from on-chain account
      return {
        mint,
        name: 'Unknown Token',
        symbol: 'UNKNOWN',
        decimals: 0,
        verified: false,
        tags: []
      };
    }, 'getTokenMetadata');
  }

  /**
   * Check connection health
   */
  async checkHealth(): Promise<Result<boolean, DomainError>> {
    return this.executeWithResilience(async () => {
      // Use getSlot as a simple health check since getHealth() doesn't exist
      const slot = await this.withTimeout(
        this.connection.getSlot(),
        'checkHealth'
      );
      return slot > 0;
    }, 'checkHealth');
  }

  /**
   * Get RPC version
   */
  async getVersion(): Promise<Result<any, DomainError>> {
    return this.executeWithResilience(async () => {
      const version = await this.withTimeout(
        this.connection.getVersion(),
        'getVersion'
      );
      return version;
    }, 'getVersion');
  }

  /**
   * Get recent blockhash (for transaction building)
   */
  async getRecentBlockhash(): Promise<Result<string, DomainError>> {
    return this.executeWithResilience(async () => {
      const { blockhash } = await this.withTimeout(
        this.connection.getLatestBlockhash(this.commitment),
        'getRecentBlockhash'
      );
      return blockhash;
    }, 'getRecentBlockhash');
  }

  /**
   * Update connection endpoint
   */
  updateEndpoint(endpoint: string): void {
    this.connection = new Connection(endpoint, {
      commitment: this.commitment,
      confirmTransactionInitialTimeout: this.timeout
    });
  }

  /**
   * Get current endpoint
   */
  getEndpoint(): string {
    return this.connection.rpcEndpoint;
  }

  /**
   * Execute operation with resilience patterns (retry and circuit breaker)
   */
  private async executeWithResilience<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<Result<T, DomainError>> {
    try {
      if (this.circuitBreaker && this.retryPolicy) {
        // Use both circuit breaker and retry policy
        // First apply retry policy, then circuit breaker
        return await this.circuitBreaker.execute(async () => {
          const retryResult = await this.retryPolicy!.execute(operation);
          if (retryResult.isFailure) {
            throw retryResult.getError();
          }
          return retryResult.getValue();
        });
      } else if (this.circuitBreaker) {
        // Use only circuit breaker
        return await this.circuitBreaker.execute(operation);
      } else if (this.retryPolicy) {
        // Use only retry policy
        return await this.retryPolicy.execute(operation);
      } else {
        // No resilience patterns, execute directly
        const result = await operation();
        return Result.ok(result);
      }
    } catch (error) {
      return Result.fail(this.translateError(error, operationName));
    }
  }

  /**
   * Add timeout to async operations
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    operation: string
  ): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new TimeoutError(operation, this.timeout, this.connection.rpcEndpoint));
      }, this.timeout);
    });

    return Promise.race([promise, timeoutPromise]);
  }

  /**
   * Translate external errors to domain errors
   */
  private translateError(error: any, operation: string): DomainError {
    if (error instanceof DomainError) {
      return error;
    }

    if (error instanceof TimeoutError) {
      return error;
    }

    const message = error?.message || 'Unknown error';
    const endpoint = this.connection.rpcEndpoint;

    // Check for RPC-specific errors
    if (error?.code || error?.data?.code) {
      const code = error.code || error.data?.code;
      const rpcMessage = error.data?.message || message;
      return new RPCError(
        `RPC error in ${operation}: ${rpcMessage}`,
        endpoint,
        code,
        rpcMessage
      );
    }

    // Check for network errors
    if (
      message.includes('fetch') ||
      message.includes('network') ||
      message.includes('ECONNREFUSED') ||
      message.includes('ETIMEDOUT')
    ) {
      return new NetworkError(
        `Network error in ${operation}: ${message}`,
        endpoint,
        true
      );
    }

    // Generic domain error
    return new OperationError(
      'CONNECTION_ERROR',
      `Connection error in ${operation}: ${message}`,
      { endpoint, operation }
    );
  }

  /**
   * Get connection metrics
   */
  getMetrics(): {
    endpoint: string;
    circuitBreakerMetrics?: any;
    retryMetrics?: any;
  } {
    return {
      endpoint: this.connection.rpcEndpoint,
      circuitBreakerMetrics: this.circuitBreaker?.getMetrics(),
      retryMetrics: this.retryPolicy?.getMetrics()
    };
  }

  /**
   * Reset resilience components
   */
  resetResilience(): void {
    if (this.circuitBreaker) {
      this.circuitBreaker.reset();
    }
    if (this.retryPolicy) {
      this.retryPolicy.resetMetrics();
    }
  }

  /**
   * Force circuit breaker open (for testing/maintenance)
   */
  forceCircuitOpen(reason: string = 'Manually forced'): void {
    if (this.circuitBreaker) {
      this.circuitBreaker.forceOpen(reason);
    }
  }

  /**
   * Force circuit breaker closed (recovery)
   */
  forceCircuitClosed(reason: string = 'Manually forced'): void {
    if (this.circuitBreaker) {
      this.circuitBreaker.forceClosed(reason);
    }
  }

  /**
   * Check if circuit breaker is open
   */
  isCircuitOpen(): boolean {
    return this.circuitBreaker?.isOpen() || false;
  }

  /**
   * Get connection configuration
   */
  getConfig(): ConnectionConfig {
    return { ...this.config };
  }
}