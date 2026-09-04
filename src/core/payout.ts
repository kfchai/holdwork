import { bps, maxMicro, minMicro, scale, type Micro } from './money.js';
import type { Params } from './params.js';

export interface Payout {
  ratio: number;
  toSeller: Micro;
  fee: Micro;
  sellerNet: Micro;
  refund: Micro;
}

/** Quality → release ratio, linear between zero-pay and full-pay thresholds (SPEC §5). */
export function releaseRatio(quality: number, fullPay: number, zeroPay: number): number {
  if (quality >= fullPay) return 1;
  if (quality < zeroPay) return 0;
  return (quality - zeroPay) / (fullPay - zeroPay);
}

export function computePayout(
  price: Micro,
  quality: number,
  fullPay: number,
  zeroPay: number,
  p: Params,
): Payout {
  const ratio = releaseRatio(quality, fullPay, zeroPay);
  const toSeller = scale(price, ratio);
  const fee = toSeller === 0n ? 0n : minMicro(toSeller, maxMicro(bps(toSeller, p.feeBps), p.minFee));
  return { ratio, toSeller, fee, sellerNet: toSeller - fee, refund: price - toSeller };
}
