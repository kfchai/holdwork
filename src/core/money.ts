/** All money is integer micro-USDC (6 decimals). */
export type Micro = bigint;

export const ONE_USDC: Micro = 1_000_000n;

/** Parse a decimal USDC string or number into micro-USDC. Rejects more than 6 decimals. */
export function usdc(value: string | number): Micro {
  const s = typeof value === 'number' ? value.toString() : value.trim();
  if (!/^-?\d+(\.\d{1,6})?$/.test(s)) throw new Error(`Invalid USDC amount: ${value}`);
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const micro = BigInt(whole) * ONE_USDC + BigInt(frac.padEnd(6, '0'));
  return neg ? -micro : micro;
}

/** Format micro-USDC as a decimal string. */
export function fmt(m: Micro): string {
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const whole = abs / ONE_USDC;
  const frac = (abs % ONE_USDC).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Basis points of an amount, floor. */
export function bps(amount: Micro, basisPoints: number): Micro {
  return (amount * BigInt(Math.round(basisPoints))) / 10_000n;
}

export const maxMicro = (a: Micro, b: Micro): Micro => (a > b ? a : b);
export const minMicro = (a: Micro, b: Micro): Micro => (a < b ? a : b);

/** Multiply an amount by a ratio in [0,1] using fixed-point arithmetic, floor. */
export function scale(amount: Micro, ratio: number): Micro {
  if (ratio <= 0) return 0n;
  if (ratio >= 1) return amount;
  const fixed = BigInt(Math.round(ratio * 1_000_000));
  return (amount * fixed) / 1_000_000n;
}
