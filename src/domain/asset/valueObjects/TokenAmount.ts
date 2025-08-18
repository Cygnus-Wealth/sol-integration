/**
 * TokenAmount Value Object
 * 
 * Represents token amounts with proper decimal handling.
 * Prevents precision loss and provides arithmetic operations.
 */

import { ValueObject } from '../../shared/ValueObject';
import { ValidationError } from '../../shared/DomainError';

export interface TokenAmountData {
  amount: string; // String to avoid precision issues
  decimals: number;
  uiAmount?: number; // Human-readable amount
}

export class TokenAmount extends ValueObject<TokenAmountData> {
  private constructor(data: TokenAmountData) {
    super(data);
  }

  protected validate(): void {
    const { amount, decimals } = this._value;

    if (!this.isValidAmount(amount)) {
      throw new ValidationError('Invalid token amount', 'amount', amount);
    }

    if (decimals < 0 || decimals > 30 || !Number.isInteger(decimals)) {
      throw new ValidationError('Invalid decimals (must be 0-30)', 'decimals', decimals);
    }
  }

  private isValidAmount(amount: string): boolean {
    if (!amount || amount.trim().length === 0) return false;
    const regex = /^(?:0|[1-9]\d*)$/; // Only positive integers
    return regex.test(amount.trim());
  }

  static fromLamports(lamports: string | number | bigint): TokenAmount {
    return new TokenAmount({
      amount: String(lamports),
      decimals: 9,
      uiAmount: Number(lamports) / 1e9
    });
  }

  static fromTokenUnits(
    units: string | number | bigint,
    decimals: number
  ): TokenAmount {
    const amount = String(units);
    const divisor = Math.pow(10, decimals);
    const uiAmount = Number(units) / divisor;

    return new TokenAmount({
      amount,
      decimals,
      uiAmount
    });
  }

  static fromUIAmount(uiAmount: number, decimals: number): TokenAmount {
    const multiplier = Math.pow(10, decimals);
    const amount = Math.floor(uiAmount * multiplier).toString();

    return new TokenAmount({
      amount,
      decimals,
      uiAmount
    });
  }

  static zero(decimals: number): TokenAmount {
    return new TokenAmount({
      amount: '0',
      decimals,
      uiAmount: 0
    });
  }

  getAmount(): string {
    return this._value.amount;
  }

  getDecimals(): number {
    return this._value.decimals;
  }

  getUIAmount(): number {
    if (this._value.uiAmount !== undefined) {
      return this._value.uiAmount;
    }
    const divisor = Math.pow(10, this._value.decimals);
    return Number(this._value.amount) / divisor;
  }

  toBigInt(): bigint {
    return BigInt(this._value.amount);
  }

  add(other: TokenAmount): TokenAmount {
    this.ensureCompatible(other);
    const sum = this.toBigInt() + other.toBigInt();
    return TokenAmount.fromTokenUnits(sum.toString(), this._value.decimals);
  }

  subtract(other: TokenAmount): TokenAmount {
    this.ensureCompatible(other);
    const thisAmount = this.toBigInt();
    const otherAmount = other.toBigInt();
    
    if (thisAmount < otherAmount) {
      throw new ValidationError(
        'Cannot subtract larger amount from smaller',
        'subtraction',
        { this: this._value.amount, other: other.getAmount() }
      );
    }
    
    const difference = thisAmount - otherAmount;
    return TokenAmount.fromTokenUnits(difference.toString(), this._value.decimals);
  }

  isZero(): boolean {
    return this._value.amount === '0' || this.toBigInt() === 0n;
  }

  isPositive(): boolean {
    return this.toBigInt() > 0n;
  }

  compareTo(other: TokenAmount): -1 | 0 | 1 {
    this.ensureCompatible(other);
    const thisAmount = this.toBigInt();
    const otherAmount = other.toBigInt();
    
    if (thisAmount < otherAmount) return -1;
    if (thisAmount > otherAmount) return 1;
    return 0;
  }

  private ensureCompatible(other: TokenAmount): void {
    if (this._value.decimals !== other.getDecimals()) {
      throw new ValidationError(
        'Decimal mismatch in token amounts',
        'decimals',
        { this: this._value.decimals, other: other.getDecimals() }
      );
    }
  }

  format(displayDecimals?: number): string {
    const uiAmount = this.getUIAmount();
    const decimals = displayDecimals ?? Math.min(this._value.decimals, 6);
    
    return uiAmount.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals
    });
  }
}