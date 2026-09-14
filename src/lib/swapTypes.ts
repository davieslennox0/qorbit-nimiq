import { getAddress, isAddress, zeroAddress, type Address, type Hex } from 'viem';

export type SwapProvider = 'lifi' | 'kyber';

export type QuoteRequest = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps: number;
  user: Address;
  feeRecipient: Address;
  decimalsIn: number;
  decimalsOut: number;
  /** Independent market prices (CoinGecko). The routers' own USD estimates are never trusted. */
  refUsdIn: number | null;
  refUsdOut: number | null;
};

export type SwapQuote = QuoteRequest & {
  provider: SwapProvider;
  /** Human-readable route, e.g. "Bitget via LI.FI" */
  routeLabel: string;
  /** Contract the user approves and sends the swap to */
  spender: Address;
  /** What the user receives */
  amountOutNet: bigint;
  /** On-chain floor the user reviewed, in tokenOut units */
  minOutNet: bigint;
  /** Qorbit's 0.5% fee, taken from the input or output token, or not charged on this route */
  platformFee: bigint;
  platformFeeSide: 'in' | 'out' | 'none';
  /** Route provider's own fee in USD, if any (LI.FI charges a fixed 0.25%) */
  routeFeeUsd: number | null;
  /** Total fraction of value lost vs. market prices, all fees included. Null if a price is missing. */
  valueLoss: number | null;
  inUsd: number | null;
  outUsd: number | null;
  gasUsd: number | null;
  fetchedAt: number;
  /** Set when this quote is a fallback because the preferred route was unavailable */
  fallbackNote?: string;
  raw: unknown;
};

export type SwapTx = { to: Address; data: Hex };

export const PLATFORM_FEE_BPS = 50n;
/** Extra 1 bp below the requested slippage: routers round their built minimum down by a few wei. */
export const MIN_OUT_BUFFER_BPS = 1;
/** Swaps losing more than this vs. market prices (fees included) are refused outright. */
export const MAX_VALUE_LOSS = 0.05;
/** Above this the review screen shows a prominent warning. */
export const WARN_VALUE_LOSS = 0.02;
/** Routers' quotes (especially RFQ market makers) go stale quickly; refresh before signing past this age. */
export const QUOTE_MAX_AGE_MS = 30_000;

export class NoRouteError extends Error {}

export function getFeeRecipient(): Address | null {
  const v = import.meta.env.VITE_FEE_RECIPIENT;
  return v && isAddress(v) && v !== zeroAddress ? getAddress(v) : null;
}

export function minOutFor(amountOutNet: bigint, slippageBps: number) {
  return (amountOutNet * BigInt(10_000 - slippageBps - MIN_OUT_BUFFER_BPS)) / 10_000n;
}

export function valuation(req: QuoteRequest, amountOutNet: bigint) {
  if (!req.refUsdIn || !req.refUsdOut) return { inUsd: null, outUsd: null, valueLoss: null };
  const inUsd = (Number(req.amountIn) / 10 ** req.decimalsIn) * req.refUsdIn;
  const outUsd = (Number(amountOutNet) / 10 ** req.decimalsOut) * req.refUsdOut;
  return { inUsd, outUsd, valueLoss: inUsd > 0 ? 1 - outUsd / inUsd : null };
}

export const isFairQuote = (q: SwapQuote) => q.valueLoss !== null && q.valueLoss <= MAX_VALUE_LOSS;

/**
 * Independent fair-price check against market prices. Router USD estimates are never used:
 * for thin pools they have been absurd (0.001 of a Coca-Cola token valued at $2.7B), which
 * once let a 90%-loss swap show "0.00% price impact".
 */
export function assertFairPrice(q: SwapQuote, symbolOut: string) {
  if (q.valueLoss === null) throw new Error(`Qorbit can't verify a fair market price for ${symbolOut} right now, so this swap is disabled to protect your funds.`);
  if (q.valueLoss > MAX_VALUE_LOSS) {
    throw new Error(`This swap would lose about ${(q.valueLoss * 100).toFixed(1)}% of its value versus the market price (liquidity for ${symbolOut} is too thin). Qorbit blocked it to protect your funds.`);
  }
}

/** Slippage (bps) that keeps a fresh quote's on-chain minimum at or above what the user reviewed. */
export function headroomSlippageBps(freshAmountOut: bigint, reviewedMin: bigint, maxBps: number) {
  if (freshAmountOut <= reviewedMin) return -1;
  const headroom = Number(((freshAmountOut - reviewedMin) * 10_000n) / freshAmountOut) - MIN_OUT_BUFFER_BPS;
  return Math.min(maxBps, headroom);
}
