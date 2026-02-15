# SolIntegration Architecture

## Overview

SolIntegration is a read-only Solana integration for CygnusWealth portfolio aggregation. It follows Domain-Driven Design (DDD) principles with a layered architecture:

- **Domain Layer** (`src/domain/`) — Aggregates, entities, value objects, domain services, events
- **Infrastructure Layer** (`src/infrastructure/`) — Connection adapters, repositories, resilience patterns
- **Application Layer** (`src/application/`) — Facade orchestrating domain and infrastructure
- **Config** (`src/config/`) — Network environment configuration

## E2E Testing Strategy

SolIntegration E2E tests serve as the **enterprise reference implementation** for Solana-based portfolio integrations.

### Test Scenarios by Priority

| Priority | Scenario | Test File | Description |
|----------|----------|-----------|-------------|
| P0 | SOL balance fetch | `SolanaIntegration.e2e.test.ts` | Fetch native SOL balance via facade, validate against direct RPC |
| P0 | Empty wallet handling | `SolanaIntegration.e2e.test.ts` | Confirm zero balance for newly generated wallet |
| P0 | Invalid address | `SolanaIntegration.e2e.test.ts` | Validate error code/message for malformed addresses |
| P1 | SPL token fetch | `SolanaIntegration.e2e.test.ts` | Fetch token accounts, verify structure (mint, symbol, balance, decimals) |
| P1 | Full portfolio snapshot | `SolanaIntegration.e2e.test.ts` | End-to-end portfolio aggregation: SOL + tokens + NFTs |
| P1 | NFT detection | `SolanaIntegration.e2e.test.ts` | Fetch NFTs via Metaplex, verify metadata structure |
| P1 | RPC failover | `SolanaIntegration.e2e.test.ts` | Verify balance fetch succeeds with invalid primary + valid fallback |
| P1 | Connection health | `SolanaIntegration.e2e.test.ts` | Verify health metrics (request count, failures, avg response time) |
| P2 | Cache invalidation | `SolanaIntegration.e2e.test.ts` | Verify cache hit/miss behavior and explicit cache clearing |
| P2 | Concurrent requests | `SolanaIntegration.e2e.test.ts` | Parallel balance fetches complete within time budget |

Additionally, `SimpleBalance.e2e.test.ts` provides low-level validation of direct Solana RPC connectivity (devnet balance, testnet slot, account info, token accounts, multiple endpoints).

### Infrastructure Setup

**Network**: Tests run against Solana **devnet** (mapped from `testnet` environment in `src/config/networks.ts`).

**RPC Endpoint**: `https://api.devnet.solana.com` (default). The facade supports multiple endpoints with automatic failover.

**Rate Limiting**: Devnet has aggressive rate limits. Tests use sequential execution (`singleFork: true`) and the facade's built-in retry policy with exponential backoff to handle 429 responses.

### Test Wallets

| Wallet | Purpose |
|--------|---------|
| `DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK` | Devnet wallet with SOL balance (~3 SOL) |
| `7VHS8XAGP3ohBodZXpSLJpqJvjE5p5rWjGXFpRqc9gBU` | Secondary test wallet |
| `GKNcUmNacSJo4S2Kq1DuYRYRGw3sNUfJ4tyqd198t6vQ` | SPL token holder (USDC-Dev) |
| `Keypair.generate().publicKey` | Ephemeral empty wallet (generated per test run) |

All wallets are public devnet addresses. No private keys are required — tests are read-only.

### Devnet Considerations

- Devnet balances/tokens can change; tests assert structure and types, not specific values
- Devnet may be unstable; the E2E config uses `retry: 2` to handle transient failures
- 429 rate limiting is expected during concurrent tests; the retry policy handles this automatically
- Devnet is distinct from testnet in Solana terminology; our `testnet` environment maps to Solana's devnet cluster

### Test Configuration (`vitest.e2e.config.ts`)

Matches enterprise standard:
- **Timeout**: 60s per test (`testTimeout: 60000`)
- **Execution**: Sequential (`singleFork: true`) to avoid rate limit cascades
- **Retries**: 2 (`retry: 2`) for transient network failures
- **Output**: Verbose (`reporters: ['verbose']`)
- **Environment**: Node (not jsdom — E2E tests make real network calls)

### How to Run Locally

```bash
# Install dependencies
npm install

# Run unit tests (excludes E2E)
npm test

# Run E2E tests
npm run test:e2e

# Run E2E tests in watch mode
npm run test:e2e:watch

# Full validation (build + unit + E2E)
npm run build && npm test -- --run && npm run test:e2e
```

### Test File Structure

```
src/test/
  e2e/
    SimpleBalance.e2e.test.ts    # Low-level RPC connectivity validation
    SolanaIntegration.e2e.test.ts # Full facade E2E (enterprise scenarios)
vitest.e2e.config.ts             # E2E-specific vitest configuration
```
