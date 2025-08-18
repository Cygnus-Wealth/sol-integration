/**
 * PublicKey Value Object
 * 
 * Encapsulates Solana public key with validation and formatting.
 * Ensures type safety and prevents invalid public keys in the domain.
 */

import { PublicKey } from '@solana/web3.js';
import { ValueObject } from '../../shared/ValueObject';
import { InvalidPublicKeyError } from '../../shared/DomainError';

export class PublicKeyVO extends ValueObject<string> {
  private _publicKey?: PublicKey;

  private constructor(value: string) {
    super(value);
  }

  protected validate(): void {
    try {
      this._publicKey = new PublicKey(this._value);
      if (!PublicKey.isOnCurve(this._publicKey)) {
        throw new InvalidPublicKeyError(this._value);
      }
    } catch (error) {
      if (error instanceof InvalidPublicKeyError) {
        throw error;
      }
      throw new InvalidPublicKeyError(this._value);
    }
  }

  static create(value: string): PublicKeyVO {
    return new PublicKeyVO(value);
  }

  static fromPublicKey(publicKey: PublicKey): PublicKeyVO {
    return new PublicKeyVO(publicKey.toBase58());
  }

  toPublicKey(): PublicKey {
    if (!this._publicKey) {
      this._publicKey = new PublicKey(this._value);
    }
    return this._publicKey;
  }

  toBase58(): string {
    return this._value;
  }

  toBuffer(): Buffer {
    return this.toPublicKey().toBuffer();
  }

  equals(other: PublicKeyVO): boolean {
    if (!other) return false;
    return this._value === other._value;
  }

  isSystemProgram(): boolean {
    return this._value === '11111111111111111111111111111111';
  }

  isTokenProgram(): boolean {
    return this._value === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  }

  isToken2022Program(): boolean {
    return this._value === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  }

  isAssociatedTokenProgram(): boolean {
    return this._value === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
  }
}