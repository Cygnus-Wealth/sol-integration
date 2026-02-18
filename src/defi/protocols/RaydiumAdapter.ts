import { Connection, PublicKey } from '@solana/web3.js';
import {
  StakedPosition,
  LendingPosition,
  LiquidityPosition,
  Chain,
  AssetType,
} from '@cygnus-wealth/data-models';
import { ISolanaDeFiProtocol } from '../types';

/** Raydium AMM program IDs */
export const RAYDIUM_AMM_PROGRAM_ID = new PublicKey(
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
);
export const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey(
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
);

export interface RaydiumAdapterOptions {
  connection: Connection;
}

export class RaydiumAdapter implements ISolanaDeFiProtocol {
  readonly protocolName = 'Raydium';
  private connection: Connection;

  constructor(options: RaydiumAdapterOptions) {
    this.connection = options.connection;
  }

  async getLendingPositions(_address: string): Promise<LendingPosition[]> {
    return [];
  }

  async getStakedPositions(_address: string): Promise<StakedPosition[]> {
    return [];
  }

  async getLiquidityPositions(address: string): Promise<LiquidityPosition[]> {
    try {
      const owner = new PublicKey(address);
      const positions: LiquidityPosition[] = [];

      // Fetch LP token accounts - Raydium LP tokens are SPL tokens
      // owned by the user with the Raydium AMM pool as the mint authority
      const lpAccounts = await this.connection.getProgramAccounts(
        RAYDIUM_AMM_PROGRAM_ID,
        {
          filters: [
            { dataSize: 752 }, // Raydium AMM pool state size
          ],
        },
      );

      // For each pool, check if the user holds LP tokens
      const userTokenAccounts = await this.connection.getTokenAccountsByOwner(owner, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      });

      // Build a map of user token balances by mint
      const userBalances = new Map<string, { amount: bigint; pubkey: string }>();
      for (const account of userTokenAccounts.value) {
        const data = account.account.data;
        const mint = new PublicKey(data.subarray(0, 32)).toBase58();
        const amount = data.readBigUInt64LE(64);
        if (amount > 0n) {
          userBalances.set(mint, { amount, pubkey: account.pubkey.toBase58() });
        }
      }

      // Match user LP token holdings against known Raydium pools
      for (const pool of lpAccounts) {
        const poolData = pool.account.data;
        // Raydium AMM pool layout: LP mint is at offset 128
        const lpMint = new PublicKey(poolData.subarray(128, 160)).toBase58();
        const coinMint = new PublicKey(poolData.subarray(400, 432)).toBase58();
        const pcMint = new PublicKey(poolData.subarray(432, 464)).toBase58();

        const userLpBalance = userBalances.get(lpMint);
        if (!userLpBalance || userLpBalance.amount === 0n) continue;

        // Read pool reserves to calculate user's share
        const coinReserve = Number(poolData.readBigUInt64LE(224));
        const pcReserve = Number(poolData.readBigUInt64LE(232));
        const lpSupply = Number(poolData.readBigUInt64LE(240));

        const userLpAmount = Number(userLpBalance.amount);
        const share = lpSupply > 0 ? userLpAmount / lpSupply : 0;

        positions.push({
          id: `raydium-lp-${pool.pubkey.toBase58()}`,
          protocol: this.protocolName,
          poolAddress: pool.pubkey.toBase58(),
          poolName: `${coinMint.slice(0, 4)}.../${pcMint.slice(0, 4)}...`,
          chain: Chain.SOLANA,
          tokens: [
            {
              assetId: `solana-${coinMint}`,
              asset: {
                id: `solana-${coinMint}`,
                symbol: coinMint.slice(0, 6),
                name: coinMint.slice(0, 6),
                type: AssetType.CRYPTOCURRENCY,
                contractAddress: coinMint,
                chain: Chain.SOLANA,
              },
              amount: (coinReserve * share).toString(),
            },
            {
              assetId: `solana-${pcMint}`,
              asset: {
                id: `solana-${pcMint}`,
                symbol: pcMint.slice(0, 6),
                name: pcMint.slice(0, 6),
                type: AssetType.CRYPTOCURRENCY,
                contractAddress: pcMint,
                chain: Chain.SOLANA,
              },
              amount: (pcReserve * share).toString(),
            },
          ],
          lpTokenBalance: userLpAmount.toString(),
          share,
          metadata: {
            'raydium:poolAddress': pool.pubkey.toBase58(),
            'raydium:lpMint': lpMint,
            'raydium:coinMint': coinMint,
            'raydium:pcMint': pcMint,
            'raydium:tokenAccount': userLpBalance.pubkey,
          },
        });
      }

      return positions;
    } catch (error) {
      console.error('RaydiumAdapter: Failed to fetch liquidity positions:', error);
      return [];
    }
  }
}
