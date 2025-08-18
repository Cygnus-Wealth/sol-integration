# Solana Integration Domain Layer

## Overview
This domain layer implements the core business logic for Solana blockchain integration within the CygnusWealth ecosystem. It follows Domain-Driven Design (DDD) principles with clear bounded contexts and separation of concerns.

## Bounded Contexts

### 1. Asset Context
Handles Solana assets including SOL, SPL tokens, and NFTs.

**Aggregates:**
- `SolanaAsset`: Root aggregate for managing asset information
- `TokenMetadata`: Aggregate for token-specific metadata

**Value Objects:**
- `PublicKeyVO`: Encapsulates Solana public key validation and formatting
- `TokenAmount`: Represents token amounts with proper decimal handling
- `MintAddress`: SPL token mint address value object
- `TokenSymbol`: Token symbol with validation

**Domain Events:**
- `AssetDiscovered`: New asset found in wallet
- `MetadataUpdated`: Asset metadata refreshed
- `BalanceChanged`: Asset balance updated

### 2. Balance Context
Manages balance fetching and caching for Solana wallets.

**Aggregates:**
- `WalletBalance`: Root aggregate for wallet balance state
- `TokenBalance`: Individual token balance aggregate

**Value Objects:**
- `Lamports`: SOL amount in lamports
- `TokenUnit`: SPL token smallest unit
- `BalanceSnapshot`: Point-in-time balance state

**Domain Services:**
- `BalanceCalculator`: Complex balance calculations
- `BalanceAggregator`: Aggregates multiple token balances

### 3. NFT Context
Specialized handling for Solana NFTs (Metaplex standard).

**Aggregates:**
- `NFTCollection`: Collection-level aggregate
- `NFTAsset`: Individual NFT aggregate

**Value Objects:**
- `NFTMetadata`: Metaplex metadata standard
- `CollectionKey`: Collection identifier
- `NFTAttributes`: Trait/attribute value objects

**Domain Events:**
- `NFTDiscovered`: New NFT found
- `CollectionIdentified`: NFT collection detected
- `MetadataResolved`: NFT metadata fetched

## Anti-Corruption Layer
Protects the domain from external changes in Solana SDK or RPC providers.

**Interfaces:**
- `ISolanaConnection`: Abstract connection interface
- `IMetadataResolver`: Metadata fetching abstraction
- `IRPCProvider`: RPC endpoint abstraction

## Repository Patterns

### Core Repositories
- `IAssetRepository`: Asset data persistence
- `IBalanceRepository`: Balance caching and retrieval
- `INFTRepository`: NFT data management
- `IMetadataRepository`: Metadata caching

## Domain Services

### Core Services
1. **SolanaBalanceService**: Orchestrates balance fetching
2. **TokenDiscoveryService**: Discovers SPL tokens in wallet
3. **NFTInventoryService**: Manages NFT collections
4. **MetadataEnrichmentService**: Enriches assets with metadata

## Ubiquitous Language

- **Lamport**: Smallest unit of SOL (1 SOL = 1,000,000,000 lamports)
- **SPL Token**: Solana Program Library token standard
- **Mint**: Token creation contract address
- **Token Account**: Account holding SPL tokens
- **Associated Token Account (ATA)**: Deterministic token account
- **Metaplex**: NFT metadata standard on Solana
- **Program**: Smart contract on Solana
- **PDA**: Program Derived Address
- **Commitment**: Transaction confirmation level