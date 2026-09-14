import { buildKyberTx, getKyberQuote } from './kyberswap';
import { getLifiQuote, verifyLifiTx } from './lifi';
import { headroomSlippageBps, isFairQuote, NoRouteError, QUOTE_MAX_AGE_MS, type QuoteRequest, type SwapQuote, type SwapTx } from './swapTypes';

/**
 * Bitget (via LI.FI) first; KyberSwap only as a fallback when Bitget has no route, errors,
 * or fails the fair-price check. If neither route is fair, the least-bad quote is returned
 * so the review screen can show exactly why the swap is blocked.
 */
export async function getBestQuote(req: QuoteRequest): Promise<SwapQuote> {
  const tried: SwapQuote[] = [];
  const errors: unknown[] = [];
  let bitgetIssue: string | undefined;

  for (const quoteWith of [getLifiQuote, getKyberQuote]) {
    try {
      const q = await quoteWith(req);
      if (isFairQuote(q)) return quoteWith === getKyberQuote && bitgetIssue ? { ...q, fallbackNote: bitgetIssue } : q;
      tried.push(q);
    } catch (e) {
      errors.push(e);
      if (quoteWith === getLifiQuote) bitgetIssue = e instanceof NoRouteError ? 'Bitget has no route for this pair.' : 'The Bitget route is temporarily unavailable, so KyberSwap was used.';
    }
  }

  if (tried.length) {
    const best = tried.sort((a, b) => (a.valueLoss ?? 1) - (b.valueLoss ?? 1))[0];
    return best.provider === 'kyber' && bitgetIssue ? { ...best, fallbackNote: bitgetIssue } : best;
  }
  if (errors.every((e) => e instanceof NoRouteError)) throw new NoRouteError('No liquidity route exists for this pair right now.');
  const firstReal = errors.find((e) => !(e instanceof NoRouteError));
  throw firstReal instanceof Error ? firstReal : new Error('Could not get a quote.');
}

/**
 * Re-quotes on the same route right before signing when the reviewed quote is stale (Bitget
 * market-maker quotes always), tightening slippage so the on-chain minimum never drops below
 * what the user reviewed.
 */
export async function freshQuoteForExecution(reviewed: SwapQuote): Promise<SwapQuote> {
  const isStale = Date.now() - reviewed.fetchedAt > QUOTE_MAX_AGE_MS;
  if (reviewed.provider === 'kyber' && !isStale) return reviewed;

  const requote = reviewed.provider === 'lifi' ? getLifiQuote : getKyberQuote;
  const req: QuoteRequest = { ...reviewed };
  const first = await requote(req);
  const bps = headroomSlippageBps(first.amountOutNet, reviewed.minOutNet, reviewed.slippageBps);
  if (bps < 0) throw new Error('The price moved past your minimum. Get a new quote to continue.');
  if (bps === reviewed.slippageBps) return first;
  if (reviewed.provider === 'kyber') return { ...first, slippageBps: bps };
  // LI.FI bakes slippage into its transaction, so ask again with the tighter tolerance.
  return requote({ ...req, slippageBps: bps });
}

export async function buildSwapTx(q: SwapQuote, reviewedMinOut: bigint): Promise<SwapTx> {
  return q.provider === 'lifi' ? verifyLifiTx(q, reviewedMinOut) : buildKyberTx(q, reviewedMinOut);
}
