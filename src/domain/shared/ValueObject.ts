/**
 * Value Object Base Class
 * 
 * Foundation for all value objects in the domain.
 * Ensures immutability and structural equality.
 */

export abstract class ValueObject<T> {
  protected readonly _value: T;

  protected constructor(value: T) {
    this._value = Object.freeze(value);
    this.validate();
  }

  protected abstract validate(): void;

  equals(other: ValueObject<T>): boolean {
    if (!other || !(other instanceof ValueObject)) {
      return false;
    }
    return JSON.stringify(this._value) === JSON.stringify(other._value);
  }

  getValue(): T {
    return this._value;
  }

  toString(): string {
    if (typeof this._value === 'object' && this._value !== null) {
      return JSON.stringify(this._value);
    }
    return String(this._value);
  }
}