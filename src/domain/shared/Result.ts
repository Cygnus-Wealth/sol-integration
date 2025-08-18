/**
 * Result Monad for Domain Operations
 * 
 * Provides functional error handling without exceptions,
 * enabling composable operations and explicit error paths.
 */

export class Result<T, E = Error> {
  private constructor(
    private readonly success: boolean,
    private readonly _value?: T,
    private readonly _error?: E
  ) {}

  static ok<T, E = Error>(value: T): Result<T, E> {
    return new Result<T, E>(true, value, undefined);
  }

  static fail<T, E = Error>(error: E): Result<T, E> {
    return new Result<T, E>(false, undefined, error);
  }

  isSuccess(): boolean {
    return this.success;
  }

  isFailure(): boolean {
    return !this.success;
  }

  // Getter properties for convenience
  get isSuccess(): boolean {
    return this.success;
  }

  get isFailure(): boolean {
    return !this.success;
  }

  get error(): E | undefined {
    return this._error;
  }

  getValue(): T {
    if (!this.success) {
      throw new Error('Cannot get value from failed result');
    }
    return this._value as T;
  }

  getError(): E {
    if (this.success) {
      throw new Error('Cannot get error from successful result');
    }
    return this._error as E;
  }

  map<U>(fn: (value: T) => U): Result<U, E> {
    if (!this.success) {
      return Result.fail<U, E>(this._error as E);
    }
    return Result.ok<U, E>(fn(this._value as T));
  }

  flatMap<U>(fn: (value: T) => Result<U, E>): Result<U, E> {
    if (!this.success) {
      return Result.fail<U, E>(this._error as E);
    }
    return fn(this._value as T);
  }

  mapError<F>(fn: (error: E) => F): Result<T, F> {
    if (this.success) {
      return Result.ok<T, F>(this._value as T);
    }
    return Result.fail<T, F>(fn(this._error as E));
  }

  getOrElse(defaultValue: T): T {
    return this.success ? (this._value as T) : defaultValue;
  }

  getOrThrow(): T {
    if (!this.success) {
      throw this._error;
    }
    return this._value as T;
  }
}