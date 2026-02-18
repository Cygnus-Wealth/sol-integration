import { Connection, PublicKey } from '@solana/web3.js';
import {
  StakedPosition,
  LendingPosition,
  LiquidityPosition,
  Chain,
  AssetType,
} from '@cygnus-wealth/data-models';
import { ISolanaDeFiProtocol } from '../types';

/** Jupiter program IDs */
export const JUPITER_DCA_PROGRAM_ID = new PublicKey(
  'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M',
);
export const JUPITER_LIMIT_ORDER_PROGRAM_ID = new PublicKey(
  'jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu',
);
export const JUPITER_PERPS_PROGRAM_ID = new PublicKey(
  'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu',
);

/** DCA account data size */
const DCA_ACCOUNT_SIZE = 296;
/** Limit order account data size */
const LIMIT_ORDER_ACCOUNT_SIZE = 372;
/** Perps position account data size */
const PERPS_POSITION_SIZE = 400;

export interface JupiterAdapterOptions {
  connection: Connection;
}

export class JupiterAdapter implements ISolanaDeFiProtocol {
  readonly protocolName = 'Jupiter';
  private connection: Connection;

  constructor(options: JupiterAdapterOptions) {
    this.connection = options.connection;
  }

  async getLendingPositions(_address: string): Promise<LendingPosition[]> {
    return [];
  }

  async getStakedPositions(address: string): Promise<StakedPosition[]> {
    try {
      const owner = new PublicKey(address);
      const positions: StakedPosition[] = [];

      // Fetch DCA positions - these are recurring buy orders
      const dcaAccounts = await this.connection.getProgramAccounts(
        JUPITER_DCA_PROGRAM_ID,
        {
          filters: [
            { dataSize: DCA_ACCOUNT_SIZE },
            { memcmp: { offset: 8, bytes: owner.toBase58() } },
          ],
        },
      );

      for (const account of dcaAccounts) {
        const data = account.account.data;
        // DCA account layout offsets
        const inputMint = new PublicKey(data.subarray(40, 72)).toBase58();
        const outputMint = new PublicKey(data.subarray(72, 104)).toBase58();
        const inDeposited = Number(data.readBigUInt64LE(104));
        const inWithdrawn = Number(data.readBigUInt64LE(112));
        const inAmountPerCycle = Number(data.readBigUInt64LE(136));
        const cycleFrequency = Number(data.readBigInt64LE(144));

        const remainingAmount = inDeposited - inWithdrawn;
        if (remainingAmount <= 0) continue;

        positions.push({
          id: `jupiter-dca-${account.pubkey.toBase58()}`,
          protocol: this.protocolName,
          chain: Chain.SOLANA,
          asset: {
            id: `solana-${inputMint}`,
            symbol: inputMint.slice(0, 6),
            name: `Jupiter DCA (${inputMint.slice(0, 4)}...)`,
            type: AssetType.CRYPTOCURRENCY,
            contractAddress: inputMint,
            chain: Chain.SOLANA,
          },
          stakedAmount: remainingAmount.toString(),
          rewards: [],
          metadata: {
            'jupiter:positionType': 'DCA',
            'jupiter:dcaAccount': account.pubkey.toBase58(),
            'jupiter:inputMint': inputMint,
            'jupiter:outputMint': outputMint,
            'jupiter:inAmountPerCycle': inAmountPerCycle.toString(),
            'jupiter:cycleFrequency': cycleFrequency,
            'jupiter:inDeposited': inDeposited.toString(),
            'jupiter:inWithdrawn': inWithdrawn.toString(),
          },
        });
      }

      // Fetch limit order positions
      const limitOrders = await this.fetchLimitOrders(owner);
      positions.push(...limitOrders);

      return positions;
    } catch (error) {
      console.error('JupiterAdapter: Failed to fetch positions:', error);
      return [];
    }
  }

  async getLiquidityPositions(_address: string): Promise<LiquidityPosition[]> {
    return [];
  }

  private async fetchLimitOrders(owner: PublicKey): Promise<StakedPosition[]> {
    try {
      const limitOrderAccounts = await this.connection.getProgramAccounts(
        JUPITER_LIMIT_ORDER_PROGRAM_ID,
        {
          filters: [
            { dataSize: LIMIT_ORDER_ACCOUNT_SIZE },
            { memcmp: { offset: 8, bytes: owner.toBase58() } },
          ],
        },
      );

      const positions: StakedPosition[] = [];

      for (const account of limitOrderAccounts) {
        const data = account.account.data;
        const inputMint = new PublicKey(data.subarray(40, 72)).toBase58();
        const outputMint = new PublicKey(data.subarray(72, 104)).toBase58();
        const makingAmount = Number(data.readBigUInt64LE(104));
        const takingAmount = Number(data.readBigUInt64LE(112));

        if (makingAmount <= 0) continue;

        positions.push({
          id: `jupiter-limit-${account.pubkey.toBase58()}`,
          protocol: this.protocolName,
          chain: Chain.SOLANA,
          asset: {
            id: `solana-${inputMint}`,
            symbol: inputMint.slice(0, 6),
            name: `Jupiter Limit Order (${inputMint.slice(0, 4)}...)`,
            type: AssetType.CRYPTOCURRENCY,
            contractAddress: inputMint,
            chain: Chain.SOLANA,
          },
          stakedAmount: makingAmount.toString(),
          rewards: [],
          metadata: {
            'jupiter:positionType': 'LIMIT_ORDER',
            'jupiter:orderAccount': account.pubkey.toBase58(),
            'jupiter:inputMint': inputMint,
            'jupiter:outputMint': outputMint,
            'jupiter:makingAmount': makingAmount.toString(),
            'jupiter:takingAmount': takingAmount.toString(),
          },
        });
      }

      return positions;
    } catch (error) {
      console.error('JupiterAdapter: Failed to fetch limit orders:', error);
      return [];
    }
  }
}
