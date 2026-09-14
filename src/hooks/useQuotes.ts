import { useEffect, useState } from 'react';
import { fetchQuotes, type Quote } from '../lib/prices';

/** Live quotes for the given CoinGecko ids, refreshed every minute. */
export function useQuotes(ids: (string | undefined)[]) {
  const key = [...new Set(ids.filter((x): x is string => !!x))].sort().join(',');
  const [quotes, setQuotes] = useState<Record<string, Quote | null>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const q = await fetchQuotes(key.split(','));
        if (!cancelled) {
          setQuotes((prev) => ({ ...prev, ...q }));
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load prices.');
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
  }, [key]);

  return { quotes, loading, error };
}
