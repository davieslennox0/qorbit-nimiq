import { useEffect, useState } from 'react';
import { formatUnits, type Address } from 'viem';
import { TOKENS, type StockToken } from '../config/tokens';
import { readBalances } from '../lib/erc20';
import { useQuotes } from './useQuotes';

export type Holding = StockToken & { raw: bigint; quantity: number };

/** Scans every catalog token's balance for the owner (chunked multicall on BNB Chain). */
export function usePortfolio(owner: Address | null) {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!owner) return;
    let cancelled = false;
    const load = async () => {
      try {
        const balances = await readBalances(TOKENS.map((t) => t.address), owner);
        if (cancelled) return;
        setHoldings(
          TOKENS.flatMap((t, i) => (balances[i] > 0n ? [{ ...t, raw: balances[i], quantity: Number(formatUnits(balances[i], t.decimals)) }] : [])),
        );
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not read balances.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [owner]);

  const { quotes, error: priceError } = useQuotes(holdings.map((h) => h.coingeckoId));
  const priced = holdings
    .map((h) => {
      const quote = h.coingeckoId ? quotes[h.coingeckoId] ?? null : null;
      return { ...h, quote, valueUsd: quote ? h.quantity * quote.usd : null };
    })
    .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));

  return { holdings: priced, loading, error: error ?? priceError };
}
