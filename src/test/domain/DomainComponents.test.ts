/**
 * Domain Components Test Suite
 * 
 * Comprehensive tests for all domain layer components.
 * Validates DDD patterns and business rules.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PublicKeyVO } from '../../domain/asset/valueObjects/PublicKeyVO';
import { TokenAmount } from '../../domain/asset/valueObjects/TokenAmount';
import { TokenMetadata } from '../../domain/asset/valueObjects/TokenMetadata';
import { SolanaAsset } from '../../domain/asset/aggregates/SolanaAsset';
import { NFTAsset } from '../../domain/asset/entities/NFTAsset';
import { PortfolioAggregate } from '../../domain/portfolio/aggregates/PortfolioAggregate';
import { 
  BalanceUpdatedEvent,
  AssetDiscoveredEvent,
  ConnectionFailedEvent
} from '../../domain/events/DomainEvents';
import { 
  ValidationError,
  InvalidPublicKeyError,
  TokenNotFoundError,
  InsufficientBalanceError
} from '../../domain/shared/DomainError';
import { Result } from '../../domain/shared/Result';
import { AssetType } from '@cygnus-wealth/data-models';

describe('Domain Value Objects', () => {
  describe('PublicKeyVO', () => {
    it('should create valid public key', () => {
      const validKey = 'So11111111111111111111111111111111111111112';
      const pubkey = PublicKeyVO.create(validKey);
      
      expect(pubkey.toBase58()).toBe(validKey);
      expect(pubkey.isSystemProgram()).toBe(false);
    });

    it('should reject invalid public key', () => {
      const invalidKey = 'invalid-key';
      
      expect(() => PublicKeyVO.create(invalidKey)).toThrow(InvalidPublicKeyError);
    });

    it('should identify system program', () => {
      const systemProgram = PublicKeyVO.create('11111111111111111111111111111111');
      
      expect(systemProgram.isSystemProgram()).toBe(true);
    });
  });

  describe('TokenAmount', () => {
    it('should create token amount from lamports', () => {
      const amount = TokenAmount.fromLamports('1000000000'); // 1 SOL
      
      expect(amount.getAmount()).toBe('1000000000');
      expect(amount.getDecimals()).toBe(9);
      expect(amount.getUIAmount()).toBe(1);
    });

    it('should handle arithmetic operations', () => {
      const amount1 = TokenAmount.fromLamports('1000000000'); // 1 SOL
      const amount2 = TokenAmount.fromLamports('500000000');  // 0.5 SOL
      
      const sum = amount1.add(amount2);
      expect(sum.getUIAmount()).toBe(1.5);
      
      const difference = amount1.subtract(amount2);
      expect(difference.getUIAmount()).toBe(0.5);
    });

    it('should prevent invalid subtraction', () => {
      const smaller = TokenAmount.fromLamports('500000000');
      const larger = TokenAmount.fromLamports('1000000000');
      
      expect(() => smaller.subtract(larger)).toThrow(ValidationError);
    });

    it('should compare amounts correctly', () => {
      const amount1 = TokenAmount.fromLamports('1000000000');
      const amount2 = TokenAmount.fromLamports('500000000');
      const amount3 = TokenAmount.fromLamports('1000000000');
      
      expect(amount1.compareTo(amount2)).toBe(1);
      expect(amount2.compareTo(amount1)).toBe(-1);
      expect(amount1.compareTo(amount3)).toBe(0);
    });
  });

  describe('TokenMetadata', () => {
    it('should create valid token metadata', () => {
      const metadata = TokenMetadata.create({
        name: 'Test Token',
        symbol: 'TEST',
        decimals: 6,
        logoUri: 'https://example.com/logo.png',
        verified: true
      });
      
      expect(metadata.getName()).toBe('Test Token');
      expect(metadata.getSymbol()).toBe('TEST');
      expect(metadata.getDecimals()).toBe(6);
      expect(metadata.isVerified()).toBe(true);
    });

    it('should validate metadata fields', () => {
      expect(() => TokenMetadata.create({
        name: '',
        symbol: 'TEST',
        decimals: 6
      })).toThrow(ValidationError);
      
      expect(() => TokenMetadata.create({
        name: 'Test',
        symbol: '',
        decimals: 6
      })).toThrow(ValidationError);
      
      expect(() => TokenMetadata.create({
        name: 'Test',
        symbol: 'TEST',
        decimals: -1
      })).toThrow(ValidationError);
    });

    it('should support immutable updates', () => {
      const metadata = TokenMetadata.createBasic('Test Token', 'TEST', 6);
      const withLogo = metadata.withLogoUri('https://example.com/logo.png');
      
      expect(metadata.getLogoUri()).toBeUndefined();
      expect(withLogo.getLogoUri()).toBe('https://example.com/logo.png');
    });

    it('should manage tags correctly', () => {
      const metadata = TokenMetadata.createBasic('Test Token', 'TEST', 6);
      const withTag = metadata.withTag('defi');
      const withoutTag = withTag.withoutTag('defi');
      
      expect(metadata.hasTag('defi')).toBe(false);
      expect(withTag.hasTag('defi')).toBe(true);
      expect(withoutTag.hasTag('defi')).toBe(false);
    });
  });
});

describe('Domain Entities and Aggregates', () => {
  describe('SolanaAsset', () => {
    it('should create native SOL asset', () => {
      const sol = SolanaAsset.createNative();
      
      expect(sol.isNative()).toBe(true);
      expect(sol.getSymbol()).toBe('SOL');
      expect(sol.getDecimals()).toBe(9);
      expect(sol.isVerified()).toBe(true);
    });

    it('should create SPL token asset', () => {
      const metadata = {
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        verified: true
      };
      
      const usdc = SolanaAsset.createToken(
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        metadata
      );
      
      expect(usdc.isToken()).toBe(true);
      expect(usdc.getSymbol()).toBe('USDC');
      expect(usdc.getDecimals()).toBe(6);
      expect(usdc.isVerified()).toBe(true);
    });

    it('should create from TokenMetadata', () => {
      const tokenMetadata = TokenMetadata.create({
        name: 'Test Token',
        symbol: 'TEST',
        decimals: 8,
        verified: false
      });
      
      const asset = SolanaAsset.fromTokenMetadata(
        'So11111111111111111111111111111111111111112', // Valid SOL mint
        tokenMetadata
      );
      
      expect(asset.getSymbol()).toBe('TEST');
      expect(asset.getDecimals()).toBe(8);
      expect(asset.isVerified()).toBe(false);
    });

    it('should update metadata and emit domain events', () => {
      const asset = SolanaAsset.createNative();
      asset.updateMetadata({ description: 'Updated description' });
      
      const events = asset.getDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('MetadataUpdated');
    });

    it('should convert to TokenMetadata', () => {
      const asset = SolanaAsset.createNative();
      const tokenMetadata = asset.toTokenMetadata();
      
      expect(tokenMetadata.getName()).toBe('Solana');
      expect(tokenMetadata.getSymbol()).toBe('SOL');
      expect(tokenMetadata.hasTag('native')).toBe(true);
      expect(tokenMetadata.hasTag('verified')).toBe(true);
    });
  });

  describe('NFTAsset', () => {
    const mockMetadata = {
      name: 'Test NFT',
      symbol: 'TNFT',
      description: 'A test NFT',
      image: 'https://example.com/nft.png',
      attributes: [
        { trait_type: 'Color', value: 'Blue' },
        { trait_type: 'Rarity', value: 'Common' }
      ]
    };

    it('should create NFT from Metaplex metadata', () => {
      const nft = NFTAsset.fromMetaplexMetadata(
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // Valid mint
        mockMetadata,
        'So11111111111111111111111111111111111111112' // Valid owner
      );
      
      expect(nft.getName()).toBe('Test NFT');
      expect(nft.getSymbol()).toBe('TNFT');
      expect(nft.getAttributes()).toHaveLength(2);
    });

    it('should handle ownership transfers', () => {
      const nft = NFTAsset.fromMetaplexMetadata(
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        mockMetadata,
        'So11111111111111111111111111111111111111112'
      );
      
      const newOwner = PublicKeyVO.create('11111111111111111111111111111111');
      nft.updateOwnership(newOwner, 'test-signature');
      
      expect(nft.getCurrentOwner().toBase58()).toBe(newOwner.toBase58());
      
      const events = nft.getDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('NFTOwnershipTransferred');
    });

    it('should query attributes correctly', () => {
      const nft = NFTAsset.fromMetaplexMetadata(
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        mockMetadata,
        'So11111111111111111111111111111111111111112'
      );
      
      expect(nft.hasAttribute('Color')).toBe(true);
      expect(nft.hasAttribute('Color', 'Blue')).toBe(true);
      expect(nft.hasAttribute('Color', 'Red')).toBe(false);
      expect(nft.getAttributeValue('Color')).toBe('Blue');
    });

    it('should convert to SolanaAsset', () => {
      const nft = NFTAsset.fromMetaplexMetadata(
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        mockMetadata,
        'So11111111111111111111111111111111111111112'
      );
      
      const asset = nft.toSolanaAsset();
      
      expect(asset.isNFT()).toBe(true);
      expect(asset.getName()).toBe('Test NFT');
      expect(asset.getDecimals()).toBe(0);
    });
  });

  describe('PortfolioAggregate', () => {
    let portfolio: PortfolioAggregate;
    let solAsset: SolanaAsset;
    let usdcAsset: SolanaAsset;

    beforeEach(() => {
      portfolio = PortfolioAggregate.create(
        'So11111111111111111111111111111111111111112', // Valid wallet address
        TokenAmount.fromLamports('1000000000') // 1 SOL
      );
      
      solAsset = SolanaAsset.createNative();
      usdcAsset = SolanaAsset.createToken(
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        {
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6,
          verified: true
        }
      );
    });

    it('should create portfolio with native balance', () => {
      expect(portfolio.getNativeBalance().getUIAmount()).toBe(1);
      expect(portfolio.getTotalAssetCount()).toBe(0);
      expect(portfolio.getTotalNFTCount()).toBe(0);
    });

    it('should add asset holdings', () => {
      const balance = TokenAmount.fromTokenUnits('1000000', 6); // 1 USDC
      portfolio.addAssetHolding(usdcAsset, balance);
      
      expect(portfolio.getTotalAssetCount()).toBe(1);
      expect(portfolio.hasAsset(usdcAsset.getMintAddress())).toBe(true);
      
      const holding = portfolio.getAssetHolding(usdcAsset.getMintAddress());
      expect(holding?.balance.getUIAmount()).toBe(1);
    });

    it('should update asset balances', () => {
      const initialBalance = TokenAmount.fromTokenUnits('1000000', 6); // 1 USDC
      const newBalance = TokenAmount.fromTokenUnits('2000000', 6); // 2 USDC
      
      portfolio.addAssetHolding(usdcAsset, initialBalance);
      portfolio.updateAssetBalance(usdcAsset.getMintAddress(), newBalance);
      
      const holding = portfolio.getAssetHolding(usdcAsset.getMintAddress());
      expect(holding?.balance.getUIAmount()).toBe(2);
    });

    it('should remove assets with zero balance', () => {
      const balance = TokenAmount.fromTokenUnits('1000000', 6);
      const zeroBalance = TokenAmount.zero(6);
      
      portfolio.addAssetHolding(usdcAsset, balance);
      expect(portfolio.hasAsset(usdcAsset.getMintAddress())).toBe(true);
      
      portfolio.updateAssetBalance(usdcAsset.getMintAddress(), zeroBalance);
      expect(portfolio.hasAsset(usdcAsset.getMintAddress())).toBe(false);
    });

    it('should calculate diversification score', () => {
      expect(portfolio.calculateDiversificationScore()).toBe(0); // No assets
      
      portfolio.addAssetHolding(usdcAsset, TokenAmount.fromTokenUnits('1000000', 6));
      expect(portfolio.calculateDiversificationScore()).toBe(10); // 1 asset
    });

    it('should validate spending capacity', () => {
      const balance = TokenAmount.fromTokenUnits('1000000', 6); // 1 USDC
      const spendAmount = TokenAmount.fromTokenUnits('500000', 6); // 0.5 USDC
      const excessiveAmount = TokenAmount.fromTokenUnits('2000000', 6); // 2 USDC
      
      portfolio.addAssetHolding(usdcAsset, balance);
      
      expect(portfolio.canSpend(usdcAsset.getMintAddress(), spendAmount)).toBe(true);
      expect(portfolio.canSpend(usdcAsset.getMintAddress(), excessiveAmount)).toBe(false);
      
      expect(() => 
        portfolio.simulateSpend(usdcAsset.getMintAddress(), excessiveAmount)
      ).toThrow(InsufficientBalanceError);
    });

    it('should emit domain events for portfolio changes', () => {
      const balance = TokenAmount.fromTokenUnits('1000000', 6);
      portfolio.addAssetHolding(usdcAsset, balance);
      
      const events = portfolio.getDomainEvents();
      expect(events.length).toBeGreaterThan(0);
      
      const creationEvent = events.find(e => e.type === 'PortfolioCreated');
      const holdingEvent = events.find(e => e.type === 'AssetHoldingUpdated');
      
      expect(creationEvent).toBeDefined();
      expect(holdingEvent).toBeDefined();
    });
  });
});

describe('Domain Events', () => {
  describe('BalanceUpdatedEvent', () => {
    it('should create balance updated event', () => {
      const wallet = PublicKeyVO.create('So11111111111111111111111111111111111111112');
      const mint = PublicKeyVO.create('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      const oldBalance = TokenAmount.fromLamports('1000000000');
      const newBalance = TokenAmount.fromLamports('2000000000');
      
      const event = new BalanceUpdatedEvent(wallet, mint, oldBalance, newBalance);
      
      expect(event.eventType).toBe('BalanceUpdated');
      expect(event.isIncrease()).toBe(true);
      expect(event.isSignificantChange(50)).toBe(true);
      
      const payload = event.getPayload();
      expect(payload.balanceChange.percentage).toBe(100);
    });
  });

  describe('AssetDiscoveredEvent', () => {
    it('should create asset discovered event', () => {
      const wallet = PublicKeyVO.create('So11111111111111111111111111111111111111112');
      const mint = PublicKeyVO.create('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      const balance = TokenAmount.fromTokenUnits('1000000', 6);
      
      const event = new AssetDiscoveredEvent(
        wallet,
        mint,
        'token',
        'USDC',
        'USD Coin',
        balance,
        undefined,
        true,
        'token_account_scan'
      );
      
      expect(event.eventType).toBe('AssetDiscovered');
      expect(event.isFirstDiscovery()).toBe(true);
      expect(event.hasBalance()).toBe(true);
      
      const payload = event.getPayload();
      expect(payload.assetType).toBe('token');
      expect(payload.isVerified).toBe(true);
    });
  });

  describe('ConnectionFailedEvent', () => {
    it('should create connection failed event', () => {
      const error = new TokenNotFoundError('TestMint', 'test context');
      
      const event = new ConnectionFailedEvent(
        'endpoint-1',
        'https://api.mainnet-beta.solana.com',
        error,
        'getBalance',
        2,
        true,
        1500
      );
      
      expect(event.eventType).toBe('ConnectionFailed');
      expect(event.isCriticalFailure()).toBe(true); // 2nd attempt is critical
      
      const payload = event.getPayload();
      expect(payload.willRetry).toBe(true);
      expect(payload.latency).toBe(1500);
      expect(payload.failureCategory).toBe('unknown'); // TokenNotFoundError
    });
  });
});

describe('Error Handling', () => {
  it('should handle domain validation errors', () => {
    expect(() => {
      TokenMetadata.create({
        name: '',
        symbol: 'TEST',
        decimals: 6
      });
    }).toThrow(ValidationError);
  });

  it('should handle insufficient balance errors', () => {
    const error = new InsufficientBalanceError('1000000', '500000', 'USDC');
    
    expect(error.code).toBe('INSUFFICIENT_BALANCE');
    expect(error.context?.required).toBe('1000000');
    expect(error.context?.available).toBe('500000');
    expect(error.context?.token).toBe('USDC');
  });

  it('should handle token not found errors', () => {
    const error = new TokenNotFoundError(
      'InvalidMint111111111111111111111111111111',
      'token registry'
    );
    
    expect(error.code).toBe('TOKEN_NOT_FOUND');
    expect(error.mintAddress).toBe('InvalidMint111111111111111111111111111111');
    expect(error.searchContext).toBe('token registry');
  });
});

describe('Result Pattern', () => {
  it('should handle successful results', () => {
    const value = 'test-value';
    const result = Result.ok(value);
    
    expect(result.isSuccess).toBe(true);
    expect(result.isFailure).toBe(false);
    expect(result.getValue()).toBe(value);
  });

  it('should handle failed results', () => {
    const error = new ValidationError('Test error');
    const result = Result.fail(error);
    
    expect(result.isSuccess).toBe(false);
    expect(result.isFailure).toBe(true);
    expect(result.getError()).toBe(error);
    expect(() => result.getValue()).toThrow();
  });

  it('should support functional operations', () => {
    const result = Result.ok(5);
    
    const doubled = result.map(x => x * 2);
    expect(doubled.getValue()).toBe(10);
    
    const chained = result.flatMap(x => Result.ok(x.toString()));
    expect(chained.getValue()).toBe('5');
    
    const defaulted = Result.fail(new Error('test')).getOrElse(42);
    expect(defaulted).toBe(42);
  });
});