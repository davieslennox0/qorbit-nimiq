/**
 * Prices from CoinGecko's public API by coin id (ids come from the catalog build).
 * Batched and cached so browsing doesn't re-request, with resilience against CoinGecko's
 * short per-IP rate limits: honour retry-after, then fall back to recent cached prices.
 */
export type Quote = { usd: number; change24h: number | null };
export type PricePoint = { t: number; usd: number };

const BASE = 'https://api.coingecko.com/api/v3';
const TTL_MS = 60_000;
/** A price older than this is never used, not even as a fallback (it also feeds the swap fair-price guard). */
const STALE_MAX_MS = 10 * 60_000;
const BATCH = 100;
const STORAGE_KEY = 'qorbit.prices.v1';

type Entry = { quote: Quote | null; at: number };
const cache = new Map<string, Entry>(loadStored());

function loadStored(): [string, Entry][] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const now = Date.now();
    return (Object.entries(JSON.parse(raw)) as [string, Entry][]).filter(([, e]) => e.quote && now - e.at < STALE_MAX_MS);
  } catch {
    return [];
  }
}

function persist() {
  try {
    const now = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries([...cache].filter(([, e]) => e.quote && now - e.at < STALE_MAX_MS))));
  } catch {
    // Storage can be unavailable in some WebViews; the in-memory cache still works.
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchChunk(chunk: string[]) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE}/simple/price?ids=${chunk.join(',')}&vs_currencies=usd&include_24hr_change=true`);
    if (res.status === 429 && attempt < 2) {
      const wait = Math.min(Number(res.headers.get('retry-after')) || 2, 5);
      await sleep(wait * 1000 + 250);
      continue;
    }
    if (!res.ok) throw new Error(res.status === 429 ? 'Price feed is rate limited — retrying shortly.' : `Price feed error (${res.status})`);
    return (await res.json()) as Record<string, { usd?: number; usd_24h_change?: number }>;
  }
  throw new Error('Price feed is rate limited — retrying shortly.');
}

export async function fetchQuotes(ids: string[]): Promise<Record<string, Quote | null>> {
  const now = Date.now();
  const unique = [...new Set(ids)];
  const due = unique.filter((id) => (cache.get(id)?.at ?? 0) < now - TTL_MS);
  let failure: unknown = null;

  for (let i = 0; i < due.length; i += BATCH) {
    const chunk = due.slice(i, i + BATCH);
    try {
      const json = await fetchChunk(chunk);
      for (const id of chunk) {
        const v = json[id];
        cache.set(id, { quote: typeof v?.usd === 'number' ? { usd: v.usd, change24h: v.usd_24h_change ?? null } : null, at: Date.now() });
      }
    } catch (e) {
      failure = e;
    }
  }
  persist();

  const result = Object.fromEntries(
    unique.map((id) => {
      const e = cache.get(id);
      return [id, e && Date.now() - e.at < STALE_MAX_MS ? e.quote : null];
    }),
  );
  // Only surface the error if it left us with no usable price for something we were asked about.
  if (failure && unique.some((id) => result[id] === null && due.includes(id))) throw failure;
  return result;
}

/** Recent cached prices only (no network), for when a live refresh fails. */
export function cachedQuotes(ids: string[]): Record<string, Quote | null> {
  const now = Date.now();
  return Object.fromEntries(ids.map((id) => {
    const e = cache.get(id);
    return [id, e && now - e.at < STALE_MAX_MS ? e.quote : null];
  }));
}

export async function fetchPriceHistory(id: string, days = 7): Promise<PricePoint[]> {
  const res = await fetch(`${BASE}/coins/${id}/market_chart?vs_currency=usd&days=${days}`);
  if (!res.ok) throw new Error(`Price history unavailable (${res.status})`);
  const json = (await res.json()) as { prices: [number, number][] };
  return json.prices.map(([t, usd]) => ({ t, usd }));
}
