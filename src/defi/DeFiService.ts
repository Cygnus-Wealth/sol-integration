import { PublicKeyVO } from '../domain/asset/valueObjects/PublicKeyVO';
import { LRUCache } from '../infrastructure/cache/LRUCache';
import {
  ISolanaDeFiProtocol,
  DeFiPositions,
  DeFiServiceConfig,
} from './types';

export interface DeFiQueryOptions {
  forceFresh?: boolean;
}

export interface DeFiServiceStats {
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  failedRequests: number;
}

export class DeFiService {
  private protocols: ISolanaDeFiProtocol[];
  private cache: LRUCache<DeFiPositions>;
  private config: DeFiServiceConfig;
  private stats: DeFiServiceStats;

  constructor(protocols: ISolanaDeFiProtocol[], config?: Partial<DeFiServiceConfig>) {
    this.protocols = protocols;
    this.config = {
      enableCache: config?.enableCache ?? true,
      cacheTTL: config?.cacheTTL ?? 60000,
      maxRetries: config?.maxRetries ?? 3,
      retryDelay: config?.retryDelay ?? 1000,
    };

    this.cache = new LRUCache<DeFiPositions>({
      maxSize: 500,
      defaultTTL: this.config.cacheTTL,
    });

    this.stats = {
      totalRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      failedRequests: 0,
    };
  }

  /**
   * Fetch DeFi positions for one or more wallet addresses.
   * Aggregates positions from all registered protocol adapters.
   */
  async getDeFiPositions(
    addresses: string[],
    options?: DeFiQueryOptions,
  ): Promise<DeFiPositions> {
    this.stats.totalRequests++;

    // Validate all addresses
    for (const address of addresses) {
      PublicKeyVO.create(address);
    }

    const result: DeFiPositions = {
      lendingPositions: [],
      stakedPositions: [],
      liquidityPositions: [],
    };

    // Fetch positions for each address
    const addressResults = await Promise.allSettled(
      addresses.map(address => this.getPositionsForAddress(address, options)),
    );

    for (const res of addressResults) {
      if (res.status === 'fulfilled') {
        result.lendingPositions.push(...res.value.lendingPositions);
        result.stakedPositions.push(...res.value.stakedPositions);
        result.liquidityPositions.push(...res.value.liquidityPositions);
      }
    }

    return result;
  }

  getStats(): Readonly<DeFiServiceStats> {
    return { ...this.stats };
  }

  destroy(): void {
    this.cache.destroy();
  }

  private async getPositionsForAddress(
    address: string,
    options?: DeFiQueryOptions,
  ): Promise<DeFiPositions> {
    // Check cache
    if (this.config.enableCache && !options?.forceFresh) {
      const cacheKey = `defi:solana:${address}`;
      const cached = this.cache.get(cacheKey);
      if (cached.isSuccess && cached.getValue() !== null) {
        this.stats.cacheHits++;
        return cached.getValue()!;
      }
      this.stats.cacheMisses++;
    }

    const result: DeFiPositions = {
      lendingPositions: [],
      stakedPositions: [],
      liquidityPositions: [],
    };

    // Query all protocols in parallel with graceful degradation
    const protocolResults = await Promise.allSettled(
      this.protocols.map(async (protocol) => {
        const [lending, staked, liquidity] = await Promise.all([
          protocol.getLendingPositions(address),
          protocol.getStakedPositions(address),
          protocol.getLiquidityPositions(address),
        ]);
        return { lending, staked, liquidity };
      }),
    );

    for (const res of protocolResults) {
      if (res.status === 'fulfilled') {
        result.lendingPositions.push(...res.value.lending);
        result.stakedPositions.push(...res.value.staked);
        result.liquidityPositions.push(...res.value.liquidity);
      } else {
        this.stats.failedRequests++;
      }
    }

    // Cache the result
    if (this.config.enableCache) {
      const cacheKey = `defi:solana:${address}`;
      this.cache.set(cacheKey, result);
    }

    return result;
  }
}
