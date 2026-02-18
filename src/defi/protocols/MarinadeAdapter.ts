import { Connection, PublicKey } from '@solana/web3.js';
import {
  StakedPosition,
  LendingPosition,
  LiquidityPosition,
  Chain,
  AssetType,
} from '@cygnus-wealth/data-models';
import { ISolanaDeFiProtocol } from '../types';

/** Marinade Finance program IDs */
export const MARINADE_FINANCE_PROGRAM_ID = new PublicKey(
  'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD',
);
export const MSOL_MINT = new PublicKey(
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
);
export const MARINADE_STATE_ADDRESS = new PublicKey(
  '8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC',
);

/** Marinade stake pool state layout offsets */
const STAKE_POOL_STATE_OFFSET = {
  msolMint: 0,
  msolSupply: 64,
  totalLamportsUnderControl: 72,
};

export interface MarinadeAdapterOptions {
  connection: Connection;
}

export class MarinadeAdapter implements ISolanaDeFiProtocol {
  readonly protocolName = 'Marinade Finance';
  private connection: Connection;

  constructor(options: MarinadeAdapterOptions) {
    this.connection = options.connection;
  }

  async getLendingPositions(_address: string): Promise<LendingPosition[]> {
    return [];
  }

  async getStakedPositions(address: string): Promise<StakedPosition[]> {
    try {
      const owner = new PublicKey(address);
      const positions: StakedPosition[] = [];

      // Fetch mSOL token accounts owned by this address
      const msolAccounts = await this.connection.getTokenAccountsByOwner(owner, {
        mint: MSOL_MINT,
      });

      if (msolAccounts.value.length === 0) {
        return [];
      }

      // Get mSOL/SOL exchange rate from the Marinade state account
      const exchangeRate = await this.getMsolExchangeRate();

      for (const account of msolAccounts.value) {
        const data = account.account.data;
        // SPL token account: amount is at offset 64, 8 bytes LE
        const amountRaw = data.readBigUInt64LE(64);
        const msolAmount = Number(amountRaw) / 1e9;

        if (msolAmount === 0) continue;

        const solEquivalent = msolAmount * exchangeRate;

        positions.push({
          id: `marinade-msol-${account.pubkey.toBase58()}`,
          protocol: this.protocolName,
          chain: Chain.SOLANA,
          asset: {
            id: 'solana-msol',
            symbol: 'mSOL',
            name: 'Marinade Staked SOL',
            type: AssetType.STAKED_POSITION,
            decimals: 9,
            contractAddress: MSOL_MINT.toBase58(),
            chain: Chain.SOLANA,
          },
          stakedAmount: msolAmount.toString(),
          rewards: [],
          metadata: {
            'marinade:exchangeRate': exchangeRate,
            'marinade:solEquivalent': solEquivalent.toString(),
            'marinade:tokenAccount': account.pubkey.toBase58(),
          },
        });
      }

      return positions;
    } catch (error) {
      console.error('MarinadeAdapter: Failed to fetch staked positions:', error);
      return [];
    }
  }

  async getLiquidityPositions(_address: string): Promise<LiquidityPosition[]> {
    return [];
  }

  /**
   * Fetches the current mSOL/SOL exchange rate from the Marinade state account.
   * Rate = total_lamports_under_control / msol_supply
   */
  async getMsolExchangeRate(): Promise<number> {
    try {
      // The Marinade state account stores the global pool state
      const accountInfo = await this.connection.getAccountInfo(MARINADE_STATE_ADDRESS);

      if (!accountInfo || !accountInfo.data) {
        return 1.0; // Fallback to 1:1 if state unavailable
      }

      const data = accountInfo.data;
      // Read total_lamports_under_control and msol_supply from state
      // These offsets are from the Marinade state account layout
      const totalLamports = Number(data.readBigUInt64LE(STAKE_POOL_STATE_OFFSET.totalLamportsUnderControl));
      const msolSupply = Number(data.readBigUInt64LE(STAKE_POOL_STATE_OFFSET.msolSupply));

      if (msolSupply === 0) return 1.0;

      return totalLamports / msolSupply;
    } catch (error) {
      console.error('MarinadeAdapter: Failed to fetch exchange rate:', error);
      return 1.0;
    }
  }

}
