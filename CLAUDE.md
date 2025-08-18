# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Context

This is the Solana integration library for CygnusWealth, a decentralized portfolio aggregation platform. The library provides read-only access to Solana blockchain data including SOL balances, SPL tokens, and NFTs. It follows Domain-Driven Design (DDD) principles with clear separation between domain, infrastructure, and application layers.

## Build and Development Commands

```bash
# Build TypeScript to JavaScript
npm run build

# Run all tests (unit + integration + E2E)
npm test

# Run specific test suites
npm run test:unit          # Unit tests only (excludes E2E)
npm run test:e2e           # E2E tests against Solana testnet/devnet
npm run test:e2e:watch     # E2E tests in watch mode
npm run test:integration   # Integration tests
npm run test:coverage      # Run tests with coverage report

# Run tests with UI
npm run test:ui

# Run a single test file
npx vitest run path/to/test.ts

# Run tests matching a pattern
npx vitest run -t "should fetch balance"
```

## Architecture Overview

### Three-Layer DDD Architecture

1. **Domain Layer** (`src/domain/`)
   - Pure business logic with no external dependencies
   - Entities wrapped in Results pattern for error handling (no exceptions thrown)
   - All operations return `Result<T, DomainError>` following functional programming
   - Value objects are immutable with factory methods using `create()` pattern
   - Aggregates enforce business invariants and emit domain events

2. **Infrastructure Layer** (`src/infrastructure/`)
   - Anti-corruption layer between Solana SDK and domain
   - Implements resilience patterns: Circuit Breaker, Retry Policy, Connection Pooling
   - All repositories use in-memory LRU caching with TTL support
   - Adapters translate between external SDKs (@solana/web3.js, @metaplex-foundation/js) and domain models
   - ConnectionManager handles multiple RPC endpoints with automatic failover

3. **Application Layer** (`src/application/`)
   - SolanaIntegrationFacade provides the main public API
   - Orchestrates domain services and infrastructure components
   - Returns simplified DTOs while internally using domain models

### Key Design Patterns

**Result Pattern**: All operations use `Result<T, DomainError>` instead of throwing exceptions
```typescript
const result = await service.getBalance(publicKey);
if (result.isFailure) {
  // Handle error
  console.error(result.error.code, result.error.message);
} else {
  // Use value
  const balance = result.getValue();
}
```

**Value Object Creation**: Always use factory methods
```typescript
// Correct
const publicKeyResult = PublicKeyVO.create(address);

// Never use constructor directly
// const publicKey = new PublicKeyVO(address); // Wrong
```

**Repository Pattern**: All data access goes through repository interfaces defined in domain, implemented in infrastructure

**Circuit Breaker**: Protects against failing RPC endpoints by opening circuit after threshold failures

## Testing Strategy

### E2E Tests
- Located in `src/test/e2e/`
- Use real Solana testnet/devnet endpoints
- Test wallets with known balances on devnet
- 60-second timeout for network operations
- Retry logic for transient failures

### Test Networks
- **Devnet**: https://api.devnet.solana.com (primary for testing)
- **Testnet**: https://api.testnet.solana.com (backup)
- Test wallet with balance: `DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK`

## Important Implementation Notes

### Browser Compatibility
- Library is designed to run entirely client-side in browsers
- No Node.js-specific dependencies allowed
- All caching is in-memory (future: IndexedDB support)

### Error Handling
- Never throw exceptions across layer boundaries
- All errors wrapped in DomainError with specific error codes
- Infrastructure errors mapped to domain errors at adapter level

### Performance Optimizations
- LRU cache evicts least recently used items when full
- TTL-based cache expiration for balance data
- Connection pooling reuses RPC connections
- Parallel fetching for multiple assets

### Current Limitations
- TypeScript compilation has some errors (work in progress)
- Full facade integration tests need fixing
- Simple E2E tests are fully functional and passing

## Dependencies

Core Solana SDKs:
- `@solana/web3.js`: Core Solana client library
- `@solana/spl-token`: SPL token program interface
- `@metaplex-foundation/js`: NFT metadata handling

The library depends on a sibling package `@cygnus-wealth/data-models` (located at `../data-models`).

## Connection to CygnusWealth

This library is part of the larger CygnusWealth ecosystem:
- Provides the Solana blockchain integration module
- Designed for modular repository structure (separate repos per blockchain)
- Follows enterprise DDD patterns for consistency across all integration modules
- Emphasizes client-side sovereignty and privacy (no private keys, read-only)