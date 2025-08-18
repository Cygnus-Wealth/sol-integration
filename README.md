# @cygnus-wealth/sol-integration

Read-only Solana integration library for CygnusWealth portfolio aggregation platform. Built with Domain-Driven Design principles for browser-first, decentralized portfolio tracking.

## Features

- 🔍 **Read-only balance fetching** for SOL, SPL tokens, and NFTs
- 🏗️ **DDD Architecture** with clear bounded contexts and domain models
- 🌐 **Browser-compatible** - runs entirely client-side
- ⚡ **High performance** with LRU caching and connection pooling
- 🔄 **Resilient** with circuit breakers and retry logic
- 🔐 **Privacy-focused** - no private keys or transaction signing
- 📊 **Comprehensive metrics** and health monitoring

## Installation

```bash
npm install @cygnus-wealth/sol-integration
```

## Quick Start

```typescript
import { SolanaIntegrationFacade } from '@cygnus-wealth/sol-integration';

// Initialize with RPC endpoints
const solana = new SolanaIntegrationFacade({
  rpcEndpoints: [
    'https://api.mainnet-beta.solana.com',
    'https://solana-api.projectserum.com'
  ],
  commitment: 'confirmed',
  cacheTTL: 300000, // 5 minutes
  maxRetries: 3,
  enableCircuitBreaker: true
});

// Get complete portfolio snapshot
const portfolio = await solana.getPortfolio('wallet-address');
if (portfolio.isSuccess) {
  console.log('Portfolio:', portfolio.getValue());
}

// Get SOL balance only
const balance = await solana.getSolanaBalance('wallet-address');
if (balance.isSuccess) {
  console.log('SOL Balance:', balance.getValue());
}

// Get SPL token balances
const tokens = await solana.getTokenBalances('wallet-address');
if (tokens.isSuccess) {
  console.log('Tokens:', tokens.getValue());
}

// Get NFTs
const nfts = await solana.getNFTs('wallet-address');
if (nfts.isSuccess) {
  console.log('NFTs:', nfts.getValue());
}
```

## Architecture

The library follows Domain-Driven Design with three main layers:

### Domain Layer
- **Value Objects**: PublicKeyVO, TokenAmount, TokenMetadata
- **Entities**: SolanaAsset, NFTAsset
- **Aggregates**: PortfolioAggregate
- **Services**: SolanaBalanceService, TokenDiscoveryService
- **Events**: Balance updates, asset discovery, connection failures

### Infrastructure Layer
- **Adapters**: SolanaConnectionAdapter, SPLTokenAdapter, MetaplexAdapter
- **Repositories**: InMemory implementations with caching
- **Resilience**: Circuit breakers, retry policies, connection pooling

### Application Layer
- **Facade**: SolanaIntegrationFacade provides clean API for integration

## Configuration

```typescript
interface SolanaConfig {
  rpcEndpoints: string[];           // Multiple endpoints for failover
  commitment?: 'processed' | 'confirmed' | 'finalized';
  cacheTTL?: number;                // Cache time-to-live in ms
  maxRetries?: number;              // Max retry attempts
  enableCircuitBreaker?: boolean;   // Enable circuit breaker
  enableMetrics?: boolean;          // Enable performance metrics
}
```

## Error Handling

All operations return `Result<T, DomainError>` following functional programming patterns:

```typescript
const result = await solana.getSolanaBalance('invalid-address');
if (result.isFailure) {
  console.error('Error:', result.error.message);
  console.error('Code:', result.error.code);
}
```

## Events

Subscribe to real-time updates:

```typescript
// Portfolio updates
solana.onPortfolioUpdate((event) => {
  console.log('Portfolio synced:', event);
});

// Balance updates  
solana.onBalanceUpdate((event) => {
  console.log('Balance updated:', event);
});
```

## Performance

- **LRU Cache**: Automatic cache eviction for memory efficiency
- **Connection Pooling**: Reuse connections across requests
- **Circuit Breakers**: Fail fast when endpoints are unhealthy
- **Batch Operations**: Efficient token discovery
- **Progressive Loading**: Stream results as they arrive

## Testing

```bash
# Run all tests
npm test

# Run with UI
npm run test:ui

# Integration tests
npm run test:integration

# E2E tests
npm run test:e2e
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev
```

## Security

- ✅ Read-only operations only
- ✅ No private key handling
- ✅ No transaction signing
- ✅ Client-side only execution
- ✅ Encrypted local caching
- ✅ No server dependencies

## License

MIT

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## Support

For issues and questions, please open an issue on GitHub.