/**
 * Prices from CoinGecko's public API by coin id (ids come from the catalog build).
 * Batched and cached briefly so paging through the market doesn't re-request.
 */
export type Quote = { usd: number; change24h: number | null };
export type PricePoint = { t: number; usd: number };

const BASE = 'https://api.coingecko.com/api/v3';
const TTL_MS = 60_000;
const BATCH = 100;
const cache = new Map<string, { quote: Quote | null; at: number }>();

export async function fetchQuotes(ids: string[]): Promise<Record<string, Quote | null>> {
  const now = Date.now();
  const unique = [...new Set(ids)];
  const stale = unique.filter((id) => (cache.get(id)?.at ?? 0) < now - TTL_MS);

  for (let i = 0; i < stale.length; i += BATCH) {
    const chunk = stale.slice(i, i + BATCH);
    const res = await fetch(`${BASE}/simple/price?ids=${chunk.join(',')}&vs_currencies=usd&include_24hr_change=true`);
    if (!res.ok) throw new Error(res.status === 429 ? 'Price feed is rate limited — retrying shortly.' : `Price feed error (${res.status})`);
    const json = (await res.json()) as Record<string, { usd?: number; usd_24h_change?: number }>;
    for (const id of chunk) {
      const v = json[id];
      cache.set(id, { quote: typeof v?.usd === 'number' ? { usd: v.usd, change24h: v.usd_24h_change ?? null } : null, at: now });
    }
  }
  return Object.fromEntries(unique.map((id) => [id, cache.get(id)?.quote ?? null]));
}

export async function fetchPriceHistory(id: string, days = 7): Promise<PricePoint[]> {
  const res = await fetch(`${BASE}/coins/${id}/market_chart?vs_currency=usd&days=${days}`);
  if (!res.ok) throw new Error(`Price history unavailable (${res.status})`);
  const json = (await res.json()) as { prices: [number, number][] };
  return json.prices.map(([t, usd]) => ({ t, usd }));
}
