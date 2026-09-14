import { useEffect, useState } from 'react';
import { formatUnits, type Address } from 'viem';
import { BNB, TOKENS, USDT, type StockToken } from '../config/tokens';
import { publicClient, readBalance, readBalances } from '../lib/erc20';
import type { Quote } from '../lib/prices';
import { useQuotes } from './useQuotes';

export type Holding = StockToken & { raw: bigint; quantity: number };
export type CashBalance = { symbol: string; name: string; logo: string; quantity: number; quote: Quote | null; valueUsd: number | null };

/** Stock holdings plus the wallet's BNB (gas) and USDT balances on BNB Chain. */
export function usePortfolio(owner: Address | null) {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [bnb, setBnb] = useState<number | null>(null);
  const [usdt, setUsdt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!owner) return;
    let cancelled = false;
    const load = async () => {
      try {
        const [balances, bnbRaw, usdtRaw] = await Promise.all([
          readBalances(TOKENS.map((t) => t.address), owner),
          publicClient.getBalance({ address: owner }),
          readBalance(USDT.address, owner),
        ]);
        if (cancelled) return;
        setHoldings(
          TOKENS.flatMap((t, i) => (balances[i] > 0n ? [{ ...t, raw: balances[i], quantity: Number(formatUnits(balances[i], t.decimals)) }] : [])),
        );
        setBnb(Number(formatUnits(bnbRaw, BNB.decimals)));
        setUsdt(Number(formatUnits(usdtRaw, USDT.decimals)));
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

  const { quotes, error: priceError } = useQuotes([...holdings.map((h) => h.coingeckoId), BNB.coingeckoId, USDT.coingeckoId]);
  const quoteFor = (id?: string) => (id ? quotes[id] ?? null : null);

  const priced = holdings
    .map((h) => {
      const quote = quoteFor(h.coingeckoId);
      return { ...h, quote, valueUsd: quote ? h.quantity * quote.usd : null };
    })
    .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));

  const cash: CashBalance[] = [
    { symbol: BNB.symbol, name: 'Network fees', logo: BNB.logo, quantity: bnb ?? 0, quote: quoteFor(BNB.coingeckoId) },
    { symbol: USDT.symbol, name: 'Tether USD', logo: USDT.logo!, quantity: usdt ?? 0, quote: quoteFor(USDT.coingeckoId) },
  ].map((c) => ({ ...c, valueUsd: c.quote ? c.quantity * c.quote.usd : null }));

  return { holdings: priced, cash, bnb, loading, error: error ?? priceError };
}
