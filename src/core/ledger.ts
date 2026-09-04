import { HoldworkError } from './types.js';
import type { Micro } from './money.js';

export const FEE_ACCOUNT = 'holdwork:fees';
export const escrowAccount = (contractId: string) => `escrow:${contractId}`;
export const stakeAccount = (contractId: string) => `stake:${contractId}`;
export const bondAccount = (contractId: string) => `bond:${contractId}`;

/**
 * Internal double-entry style ledger in micro-USDC.
 * This is the LedgerEscrow backend: every move is a transfer between named accounts,
 * so the sum of all balances is constant except for explicit deposits.
 */
export class Ledger {
  private balances = new Map<string, Micro>();
  readonly journal: Array<{ at: number; from: string; to: string; amount: Micro; memo: string }> = [];

  balance(account: string): Micro {
    return this.balances.get(account) ?? 0n;
  }

  /** External deposit (faucet in ledger mode, on-chain deposit later). */
  deposit(account: string, amount: Micro, at: number, memo = 'deposit'): void {
    if (amount <= 0n) throw new HoldworkError('INVALID_AMOUNT', 'Deposit must be positive');
    this.balances.set(account, this.balance(account) + amount);
    this.journal.push({ at, from: 'external', to: account, amount, memo });
  }

  transfer(from: string, to: string, amount: Micro, at: number, memo: string): void {
    if (amount < 0n) throw new HoldworkError('INVALID_AMOUNT', 'Transfer must be non-negative');
    if (amount === 0n) return;
    const available = this.balance(from);
    if (available < amount) {
      throw new HoldworkError(
        'INSUFFICIENT_FUNDS',
        `${from} has ${available} micro-USDC, needs ${amount}`,
      );
    }
    this.balances.set(from, available - amount);
    this.balances.set(to, this.balance(to) + amount);
    this.journal.push({ at, from, to, amount, memo });
  }

  total(): Micro {
    let t = 0n;
    for (const v of this.balances.values()) t += v;
    return t;
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.balances].map(([k, v]) => [k, v.toString()]));
  }

  static fromSnapshot(s: Record<string, string>): Ledger {
    const l = new Ledger();
    for (const [k, v] of Object.entries(s)) l.balances.set(k, BigInt(v));
    return l;
  }
}
