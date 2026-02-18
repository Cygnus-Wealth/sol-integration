import { Connection, PublicKey } from '@solana/web3.js';
import {
  StakedPosition,
  LendingPosition,
  LiquidityPosition,
  Chain,
  AssetType,
} from '@cygnus-wealth/data-models';
import { ISolanaDeFiProtocol } from '../types';

/** Orca Whirlpool program ID */
export const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey(
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
);

/** Whirlpool position account data size */
const WHIRLPOOL_POSITION_SIZE = 216;

export interface OrcaAdapterOptions {
  connection: Connection;
}

export class OrcaAdapter implements ISolanaDeFiProtocol {
  readonly protocolName = 'Orca';
  private connection: Connection;

  constructor(options: OrcaAdapterOptions) {
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

      // Orca Whirlpool positions are represented as position NFTs
      // Fetch all position accounts owned by this wallet
      const positionAccounts = await this.connection.getProgramAccounts(
        ORCA_WHIRLPOOL_PROGRAM_ID,
        {
          filters: [
            { dataSize: WHIRLPOOL_POSITION_SIZE },
            // Position accounts store the owner at offset 8
            { memcmp: { offset: 8, bytes: owner.toBase58() } },
          ],
        },
      );

      for (const account of positionAccounts) {
        const data = account.account.data;
        const position = this.parseWhirlpoolPosition(data, account.pubkey);
        if (position) {
          positions.push(position);
        }
      }

      return positions;
    } catch (error) {
      console.error('OrcaAdapter: Failed to fetch liquidity positions:', error);
      return [];
    }
  }

  private parseWhirlpoolPosition(
    data: Buffer,
    positionPubkey: PublicKey,
  ): LiquidityPosition | null {
    try {
      // Whirlpool position layout:
      // 8: discriminator
      // 8+32: whirlpool pubkey
      // 40+32: position mint (NFT)
      // 72+16: liquidity (u128)
      // 88+4: tick_lower_index (i32)
      // 92+4: tick_upper_index (i32)
      const whirlpool = new PublicKey(data.subarray(8, 40)).toBase58();
      const positionMint = new PublicKey(data.subarray(40, 72)).toBase58();

      // Read liquidity as two 64-bit values (u128)
      const liquidityLow = Number(data.readBigUInt64LE(72));
      const liquidityHigh = Number(data.readBigUInt64LE(80));
      const liquidity = liquidityLow + liquidityHigh * 2 ** 64;

      const tickLowerIndex = data.readInt32LE(88);
      const tickUpperIndex = data.readInt32LE(92);

      if (liquidity === 0) return null;

      return {
        id: `orca-whirlpool-${positionPubkey.toBase58()}`,
        protocol: this.protocolName,
        poolAddress: whirlpool,
        poolName: `Whirlpool Position`,
        chain: Chain.SOLANA,
        tokens: [],
        lpTokenBalance: liquidity.toString(),
        metadata: {
          'orca:positionType': 'CONCENTRATED_LIQUIDITY',
          'orca:positionMint': positionMint,
          'orca:whirlpool': whirlpool,
          'orca:tickLowerIndex': tickLowerIndex,
          'orca:tickUpperIndex': tickUpperIndex,
          'orca:liquidity': liquidity.toString(),
          'orca:positionAccount': positionPubkey.toBase58(),
        },
      };
    } catch (error) {
      console.error('OrcaAdapter: Failed to parse position:', error);
      return null;
    }
  }
}
