/**
 * SPL Token Adapter
 * 
 * Integrates @solana/spl-token for comprehensive token account management.
 * Handles token account discovery, associated token accounts, and token operations.
 */

import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getMint,
  getOrCreateAssociatedTokenAccount,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
  TokenInvalidMintError,
  TokenInvalidOwnerError,
  AccountLayout,
  MintLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { Connection, PublicKey, AccountInfo } from '@solana/web3.js';
import { PublicKeyVO } from '../../domain/asset/valueObjects/PublicKeyVO';
import { TokenAmount } from '../../domain/asset/valueObjects/TokenAmount';
import { Result } from '../../domain/shared/Result';
import { DomainError, TokenAccountError, ValidationError, NetworkError } from '../../domain/shared/DomainError';

export interface TokenAccountData {
  address: PublicKeyVO;
  mint: PublicKeyVO;
  owner: PublicKeyVO;
  amount: TokenAmount;
  delegate?: PublicKeyVO;
  state: 'initialized' | 'uninitialized' | 'frozen';
  isNative: boolean;
  delegatedAmount: TokenAmount;
  closeAuthority?: PublicKeyVO;
  programId: PublicKeyVO;
}

export interface MintData {
  address: PublicKeyVO;
  mintAuthority?: PublicKeyVO;
  supply: TokenAmount;
  decimals: number;
  isInitialized: boolean;
  freezeAuthority?: PublicKeyVO;
  programId: PublicKeyVO;
}

export interface AssociatedTokenAccountInfo {
  address: PublicKeyVO;
  exists: boolean;
  needsCreation: boolean;
}

export class SPLTokenAdapter {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Find associated token account address for owner and mint
   */
  async findAssociatedTokenAccount(
    owner: PublicKeyVO,
    mint: PublicKeyVO,
    allowOwnerOffCurve: boolean = false,
    programId: PublicKeyVO = PublicKeyVO.fromPublicKey(TOKEN_PROGRAM_ID)
  ): Promise<Result<AssociatedTokenAccountInfo, DomainError>> {
    try {
      const associatedTokenAddress = await getAssociatedTokenAddress(
        mint.toPublicKey(),
        owner.toPublicKey(),
        allowOwnerOffCurve,
        programId.toPublicKey(),
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      const ataAddress = PublicKeyVO.fromPublicKey(associatedTokenAddress);

      // Check if account exists
      const accountInfo = await this.connection.getAccountInfo(associatedTokenAddress);
      const exists = accountInfo !== null;

      return Result.ok({
        address: ataAddress,
        exists,
        needsCreation: !exists
      });
    } catch (error) {
      return Result.fail(
        new TokenAccountError(
          'unknown',
          `Failed to find associated token account: ${error instanceof Error ? error.message : String(error)}`,
          mint.toBase58(),
          owner.toBase58()
        )
      );
    }
  }

  /**
   * Get token account data
   */
  async getTokenAccount(
    tokenAccount: PublicKeyVO,
    programId: PublicKeyVO = PublicKeyVO.fromPublicKey(TOKEN_PROGRAM_ID)
  ): Promise<Result<TokenAccountData, DomainError>> {
    try {
      const account = await getAccount(
        this.connection,
        tokenAccount.toPublicKey(),
        undefined, // commitment
        programId.toPublicKey()
      );

      const tokenAccountData: TokenAccountData = {
        address: tokenAccount,
        mint: PublicKeyVO.fromPublicKey(account.mint),
        owner: PublicKeyVO.fromPublicKey(account.owner),
        amount: TokenAmount.fromLamports(account.amount.toString(), await this.getMintDecimals(PublicKeyVO.fromPublicKey(account.mint))),
        delegate: account.delegate ? PublicKeyVO.fromPublicKey(account.delegate) : undefined,
        state: account.isFrozen ? 'frozen' : 'initialized',
        isNative: account.isNative,
        delegatedAmount: TokenAmount.fromLamports(account.delegatedAmount.toString(), await this.getMintDecimals(PublicKeyVO.fromPublicKey(account.mint))),
        closeAuthority: account.closeAuthority ? PublicKeyVO.fromPublicKey(account.closeAuthority) : undefined,
        programId
      };

      return Result.ok(tokenAccountData);
    } catch (error) {
      if (error instanceof TokenAccountNotFoundError) {
        return Result.fail(
          new TokenAccountError(
            tokenAccount.toBase58(),
            'Token account not found',
            undefined,
            undefined
          )
        );
      }

      if (error instanceof TokenInvalidAccountOwnerError) {
        return Result.fail(
          new TokenAccountError(
            tokenAccount.toBase58(),
            'Invalid account owner for token account',
            undefined,
            undefined
          )
        );
      }

      return Result.fail(
        new TokenAccountError(
          tokenAccount.toBase58(),
          `Failed to get token account: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          undefined
        )
      );
    }
  }

  /**
   * Get mint data
   */
  async getMint(
    mint: PublicKeyVO,
    programId: PublicKeyVO = PublicKeyVO.fromPublicKey(TOKEN_PROGRAM_ID)
  ): Promise<Result<MintData, DomainError>> {
    try {
      const mintInfo = await getMint(
        this.connection,
        mint.toPublicKey(),
        undefined, // commitment
        programId.toPublicKey()
      );

      const mintData: MintData = {
        address: mint,
        mintAuthority: mintInfo.mintAuthority ? PublicKeyVO.fromPublicKey(mintInfo.mintAuthority) : undefined,
        supply: TokenAmount.fromTokenUnits(mintInfo.supply.toString(), mintInfo.decimals),
        decimals: mintInfo.decimals,
        isInitialized: mintInfo.isInitialized,
        freezeAuthority: mintInfo.freezeAuthority ? PublicKeyVO.fromPublicKey(mintInfo.freezeAuthority) : undefined,
        programId
      };

      return Result.ok(mintData);
    } catch (error) {
      if (error instanceof TokenInvalidMintError) {
        return Result.fail(
          new ValidationError('Invalid mint address', 'mint', mint.toBase58())
        );
      }

      return Result.fail(
        new DomainError(
          'MINT_FETCH_ERROR',
          `Failed to get mint data: ${error instanceof Error ? error.message : String(error)}`,
          { mint: mint.toBase58() }
        )
      );
    }
  }

  /**
   * Get all token accounts for an owner
   */
  async getTokenAccountsByOwner(
    owner: PublicKeyVO,
    mint?: PublicKeyVO,
    programId: PublicKeyVO = PublicKeyVO.fromPublicKey(TOKEN_PROGRAM_ID)
  ): Promise<Result<TokenAccountData[], DomainError>> {
    try {
      const filters = mint 
        ? [{ mint: mint.toPublicKey() }]
        : [{ programId: programId.toPublicKey() }];

      const response = await this.connection.getTokenAccountsByOwner(
        owner.toPublicKey(),
        ...filters
      );

      const tokenAccounts: TokenAccountData[] = [];

      for (const accountInfo of response.value) {
        try {
          const tokenAccountResult = await this.getTokenAccount(
            PublicKeyVO.fromPublicKey(accountInfo.pubkey),
            programId
          );

          if (tokenAccountResult.isSuccess()) {
            tokenAccounts.push(tokenAccountResult.getValue());
          }
        } catch (error) {
          // Skip invalid accounts and continue
          console.warn(`Skipping invalid token account ${accountInfo.pubkey.toBase58()}: ${error}`);
          continue;
        }
      }

      return Result.ok(tokenAccounts);
    } catch (error) {
      return Result.fail(
        new NetworkError(
          `Failed to get token accounts for owner: ${error instanceof Error ? error.message : String(error)}`,
          this.connection.rpcEndpoint
        )
      );
    }
  }

  /**
   * Get all token accounts for multiple owners (batch operation)
   */
  async getTokenAccountsByOwners(
    owners: PublicKeyVO[],
    mint?: PublicKeyVO,
    programId: PublicKeyVO = PublicKeyVO.fromPublicKey(TOKEN_PROGRAM_ID)
  ): Promise<Result<Map<string, TokenAccountData[]>, DomainError>> {
    try {
      const results = new Map<string, TokenAccountData[]>();

      // Process in batches to avoid overwhelming the RPC
      const batchSize = 10;
      for (let i = 0; i < owners.length; i += batchSize) {
        const batch = owners.slice(i, i + batchSize);
        
        const batchPromises = batch.map(async owner => {
          const accountsResult = await this.getTokenAccountsByOwner(owner, mint, programId);
          return {
            owner: owner.toBase58(),
            accounts: accountsResult.isSuccess() ? accountsResult.getValue() : []
          };
        });

        const batchResults = await Promise.allSettled(batchPromises);
        
        for (const result of batchResults) {
          if (result.status === 'fulfilled') {
            results.set(result.value.owner, result.value.accounts);
          }
        }
      }

      return Result.ok(results);
    } catch (error) {
      return Result.fail(
        new NetworkError(
          `Failed to get token accounts for owners: ${error instanceof Error ? error.message : String(error)}`,
          this.connection.rpcEndpoint
        )
      );
    }
  }

  /**
   * Discover all token accounts across both TOKEN_PROGRAM_ID and TOKEN_2022_PROGRAM_ID
   */
  async discoverAllTokenAccounts(owner: PublicKeyVO): Promise<Result<{
    legacyTokens: TokenAccountData[];
    token2022: TokenAccountData[];
    total: number;
  }, DomainError>> {
    try {
      const [legacyResult, token2022Result] = await Promise.allSettled([
        this.getTokenAccountsByOwner(owner, undefined, PublicKeyVO.fromPublicKey(TOKEN_PROGRAM_ID)),
        this.getTokenAccountsByOwner(owner, undefined, PublicKeyVO.fromPublicKey(TOKEN_2022_PROGRAM_ID))
      ]);

      const legacyTokens = legacyResult.status === 'fulfilled' && legacyResult.value.isSuccess()
        ? legacyResult.value.getValue()
        : [];

      const token2022 = token2022Result.status === 'fulfilled' && token2022Result.value.isSuccess()
        ? token2022Result.value.getValue()
        : [];

      return Result.ok({
        legacyTokens,
        token2022,
        total: legacyTokens.length + token2022.length
      });
    } catch (error) {
      return Result.fail(
        new NetworkError(
          `Failed to discover token accounts: ${error instanceof Error ? error.message : String(error)}`,
          this.connection.rpcEndpoint
        )
      );
    }
  }

  /**
   * Check if an associated token account exists and get its balance
   */
  async getAssociatedTokenAccountBalance(
    owner: PublicKeyVO,
    mint: PublicKeyVO,
    programId: PublicKeyVO = PublicKeyVO.fromPublicKey(TOKEN_PROGRAM_ID)
  ): Promise<Result<{
    exists: boolean;
    balance?: TokenAmount;
    address: PublicKeyVO;
  }, DomainError>> {
    try {
      const ataResult = await this.findAssociatedTokenAccount(owner, mint, false, programId);
      if (ataResult.isFailure()) {
        return Result.fail(ataResult.getError());
      }

      const ataInfo = ataResult.getValue();
      
      if (!ataInfo.exists) {
        return Result.ok({
          exists: false,
          address: ataInfo.address
        });
      }

      const accountResult = await this.getTokenAccount(ataInfo.address, programId);
      if (accountResult.isFailure()) {
        return Result.fail(accountResult.getError());
      }

      const accountData = accountResult.getValue();

      return Result.ok({
        exists: true,
        balance: accountData.amount,
        address: ataInfo.address
      });
    } catch (error) {
      return Result.fail(
        new TokenAccountError(
          'unknown',
          `Failed to get associated token account balance: ${error instanceof Error ? error.message : String(error)}`,
          mint.toBase58(),
          owner.toBase58()
        )
      );
    }
  }

  /**
   * Get multiple token account balances efficiently
   */
  async getMultipleTokenAccountBalances(
    accounts: PublicKeyVO[]
  ): Promise<Result<Map<string, TokenAmount>, DomainError>> {
    try {
      const balances = new Map<string, TokenAmount>();

      // Process in batches to respect RPC limits
      const batchSize = 100;
      for (let i = 0; i < accounts.length; i += batchSize) {
        const batch = accounts.slice(i, i + batchSize);
        const publicKeys = batch.map(account => account.toPublicKey());

        const accountInfos = await this.connection.getMultipleAccountsInfo(publicKeys);

        for (let j = 0; j < accountInfos.length; j++) {
          const accountInfo = accountInfos[j];
          const accountAddress = batch[j];

          if (accountInfo && accountInfo.data.length === AccountLayout.span) {
            try {
              const accountData = AccountLayout.decode(accountInfo.data);
              const mintResult = await this.getMintDecimals(PublicKeyVO.fromPublicKey(accountData.mint));
              const amount = TokenAmount.fromLamports(accountData.amount.toString(), mintResult);
              balances.set(accountAddress.toBase58(), amount);
            } catch (error) {
              // Skip invalid accounts
              console.warn(`Skipping invalid token account ${accountAddress.toBase58()}: ${error}`);
            }
          }
        }
      }

      return Result.ok(balances);
    } catch (error) {
      return Result.fail(
        new NetworkError(
          `Failed to get multiple token account balances: ${error instanceof Error ? error.message : String(error)}`,
          this.connection.rpcEndpoint
        )
      );
    }
  }

  /**
   * Validate token account ownership
   */
  async validateTokenAccountOwnership(
    tokenAccount: PublicKeyVO,
    expectedOwner: PublicKeyVO,
    expectedMint?: PublicKeyVO
  ): Promise<Result<boolean, DomainError>> {
    try {
      const accountResult = await this.getTokenAccount(tokenAccount);
      if (accountResult.isFailure()) {
        return Result.fail(accountResult.getError());
      }

      const accountData = accountResult.getValue();

      // Check owner
      if (!accountData.owner.equals(expectedOwner)) {
        return Result.ok(false);
      }

      // Check mint if provided
      if (expectedMint && !accountData.mint.equals(expectedMint)) {
        return Result.ok(false);
      }

      return Result.ok(true);
    } catch (error) {
      return Result.fail(
        new TokenAccountError(
          tokenAccount.toBase58(),
          `Failed to validate token account ownership: ${error instanceof Error ? error.message : String(error)}`,
          expectedMint?.toBase58(),
          expectedOwner.toBase58()
        )
      );
    }
  }

  /**
   * Get token account state (frozen, initialized, etc.)
   */
  async getTokenAccountState(
    tokenAccount: PublicKeyVO
  ): Promise<Result<{
    state: 'initialized' | 'uninitialized' | 'frozen';
    isFrozen: boolean;
    isInitialized: boolean;
  }, DomainError>> {
    try {
      const accountResult = await this.getTokenAccount(tokenAccount);
      if (accountResult.isFailure()) {
        return Result.fail(accountResult.getError());
      }

      const accountData = accountResult.getValue();

      return Result.ok({
        state: accountData.state,
        isFrozen: accountData.state === 'frozen',
        isInitialized: accountData.state !== 'uninitialized'
      });
    } catch (error) {
      return Result.fail(
        new TokenAccountError(
          tokenAccount.toBase58(),
          `Failed to get token account state: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Check if token mint is valid and get basic info
   */
  async validateMint(
    mint: PublicKeyVO,
    programId: PublicKeyVO = PublicKeyVO.fromPublicKey(TOKEN_PROGRAM_ID)
  ): Promise<Result<{
    isValid: boolean;
    decimals?: number;
    supply?: TokenAmount;
    hasAuthority: boolean;
  }, DomainError>> {
    try {
      const mintResult = await this.getMint(mint, programId);
      if (mintResult.isFailure()) {
        return Result.ok({
          isValid: false,
          hasAuthority: false
        });
      }

      const mintData = mintResult.getValue();

      return Result.ok({
        isValid: true,
        decimals: mintData.decimals,
        supply: mintData.supply,
        hasAuthority: mintData.mintAuthority !== undefined || mintData.freezeAuthority !== undefined
      });
    } catch (error) {
      return Result.fail(
        new ValidationError(
          `Failed to validate mint: ${error instanceof Error ? error.message : String(error)}`,
          'mint',
          mint.toBase58()
        )
      );
    }
  }

  /**
   * Helper method to get mint decimals with caching
   */
  private mintDecimalsCache = new Map<string, number>();

  private async getMintDecimals(mint: PublicKeyVO): Promise<number> {
    const mintAddress = mint.toBase58();
    
    if (this.mintDecimalsCache.has(mintAddress)) {
      return this.mintDecimalsCache.get(mintAddress)!;
    }

    try {
      const mintResult = await this.getMint(mint);
      if (mintResult.isSuccess()) {
        const decimals = mintResult.getValue().decimals;
        this.mintDecimalsCache.set(mintAddress, decimals);
        return decimals;
      }
    } catch (error) {
      console.warn(`Failed to get decimals for mint ${mintAddress}, using default: ${error}`);
    }

    // Default to 9 decimals if we can't fetch
    return 9;
  }

  /**
   * Clear internal caches
   */
  clearCaches(): void {
    this.mintDecimalsCache.clear();
  }

  /**
   * Get adapter statistics
   */
  getStats(): {
    cachedMints: number;
    connection: string;
  } {
    return {
      cachedMints: this.mintDecimalsCache.size,
      connection: this.connection.rpcEndpoint
    };
  }
}