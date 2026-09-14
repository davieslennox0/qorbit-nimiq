// Builds src/config/catalog.json: every Ondo tokenized stock/ETF deployed on BNB Chain,
// sourced only from Ondo's published token list, verified on-chain, with a liquidity probe.
// Usage: node scripts/build-catalog.mjs            (full rebuild)
//        node scripts/build-catalog.mjs --logos-only (refresh logos, keep liquidity flags)
//        node scripts/build-catalog.mjs --bitget-only (re-check non-tradeable tokens on Bitget via LI.FI)
import fs from 'node:fs';
import { createPublicClient, getAddress, http, parseAbi } from 'viem';
import { bsc } from 'viem/chains';

const ONDO_CSV = 'https://www.dropbox.com/scl/fi/qjfxyg748mx0dwi6up86d/EXTERNAL-Ondo-GM-Tokens-Ondo-GM-Tokens.csv?rlkey=n3no1w78wrah3umsl0nr9s77i&dl=1';
const KYBER = 'https://aggregator-api.kyberswap.com/bsc/api/v1/routes';
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const PROBE_USD = 50;
/** Max loss vs. the reference price for a $50 buy to count as tradeable. */
const MAX_PROBE_LOSS = 0.03;
const OUT = new URL('../src/config/catalog.json', import.meta.url);

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com', { timeout: 60_000 }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function fetchJson(url, init, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { ...init, headers: { 'user-agent': 'qorbit-catalog', ...init?.headers } });
    if (res.status === 429 || res.status >= 500) { await sleep(2000 * (i + 1)); continue; }
    return res.json();
  }
  throw new Error(`Failed after retries: ${url}`);
}

/**
 * Ondo's CDN names logos after the ticker. Their CSV occasionally links the wrong file
 * (AALon pointed at Abbott's `abton_160x160.png`), so trust the ticker-named file in that case.
 */
function ondoLogo(symbol, csvUrl) {
  const byTicker = `https://cdn.ondo.finance/tokens/logos/${symbol.toLowerCase()}_160x160.png`;
  if (!csvUrl) return byTicker;
  return csvUrl.split('/').pop() === `${symbol.toLowerCase()}_160x160.png` ? csvUrl : byTicker;
}

async function ondoTokens() {
  const text = await (await fetch(ONDO_CSV)).text();
  const [header, ...rows] = parseCsv(text);
  const col = (name) => header.indexOf(name);
  return rows
    .filter((r) => r[col('Type')] !== 'Currency' && /^0x[0-9a-fA-F]{40}$/.test((r[col('BSC Deployed Address')] ?? '').trim()))
    .map((r) => ({
      symbol: r[col('Symbol')],
      name: r[col('Stock Name')] || r[col('Name')],
      address: getAddress(r[col('BSC Deployed Address')].trim()),
      kind: r[col('Type')] === 'ETF' ? 'etf' : 'stock',
      coingeckoId: r[col('CoinGecko API ID')] || undefined,
      logo: ondoLogo(r[col('Symbol')], r[col('Link to image (png)')]),
    }));
}

async function verifyOnChain(tokens) {
  const abi = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)']);
  const out = [];
  for (let i = 0; i < tokens.length; i += 200) {
    const chunk = tokens.slice(i, i + 200);
    const res = await client.multicall({
      allowFailure: true,
      contracts: chunk.flatMap((t) => ['symbol', 'decimals', 'totalSupply'].map((functionName) => ({ address: t.address, abi, functionName }))),
    });
    chunk.forEach((t, j) => {
      const [sym, dec, supply] = res.slice(j * 3, j * 3 + 3);
      if (sym.status !== 'success' || dec.status !== 'success' || supply.status !== 'success') return;
      if (sym.result !== t.symbol || supply.result === 0n) return;
      out.push({ ...t, decimals: dec.result });
    });
  }
  return out;
}

async function referencePrices(ids) {
  const prices = {};
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const json = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${chunk.join(',')}&vs_currencies=usd`);
    for (const id of chunk) if (typeof json[id]?.usd === 'number') prices[id] = json[id].usd;
    await sleep(2500);
  }
  return prices;
}

/**
 * A token is tradeable only if a $50 USDT buy returns at least 97% of $50 when the output
 * is valued at CoinGecko's reference price. The aggregator's own USD estimates are never
 * used: for thin pools they can be wildly wrong (a Coca-Cola token once quoted at $2.7B).
 */
async function probeLiquidity(tokens) {
  const prices = await referencePrices(tokens.map((t) => t.coingeckoId).filter(Boolean));
  const amountIn = (BigInt(PROBE_USD) * 10n ** 18n).toString();
  let done = 0;
  const results = new Array(tokens.length);
  const worker = async (queue) => {
    for (const i of queue) {
      const t = tokens[i];
      const ref = t.coingeckoId ? prices[t.coingeckoId] : undefined;
      let tradeable = false;
      if (ref) {
        try {
          const j = await fetchJson(`${KYBER}?tokenIn=${USDT}&tokenOut=${t.address}&amountIn=${amountIn}`, { headers: { 'x-client-id': 'qorbit' } });
          const r = j.data?.routeSummary;
          if (r) {
            const valueOut = (Number(r.amountOut) / 10 ** t.decimals) * ref;
            tradeable = 1 - valueOut / PROBE_USD < MAX_PROBE_LOSS;
          }
        } catch {}
      }
      results[i] = { ...t, tradeable };
      if (++done % 100 === 0) console.log(`  probed ${done}/${tokens.length}`);
      await sleep(150);
    }
  };
  const idx = tokens.map((_, i) => i);
  const lanes = 4;
  await Promise.all(Array.from({ length: lanes }, (_, l) => worker(idx.filter((i) => i % lanes === l))));
  return results;
}

/** Keeps a logo only if the URL actually serves an image, so the app never shows a broken icon. */
async function verifyLogos(tokens) {
  const checked = new Array(tokens.length);
  let next = 0;
  const lane = async () => {
    while (next < tokens.length) {
      const i = next++;
      const t = tokens[i];
      let ok = false;
      if (t.logo) {
        try {
          const res = await fetch(t.logo, { method: 'HEAD' });
          ok = res.ok && (res.headers.get('content-type') ?? '').startsWith('image/');
        } catch {}
      }
      checked[i] = ok ? t : { ...t, logo: undefined };
    }
  };
  await Promise.all(Array.from({ length: 16 }, lane));
  return checked;
}

/**
 * Re-checks tokens that failed on KyberSwap against Bitget liquidity via LI.FI, largest companies
 * first. LI.FI allows ~75 keyless requests per ~2h per IP, so this stops cleanly when rate-limited.
 */
async function probeBitget(tokens) {
  const candidates = tokens.filter((t) => !t.tradeable && t.coingeckoId);
  const ids = candidates.map((t) => t.coingeckoId);
  const caps = {}, prices = {};
  for (let i = 0; i < ids.length; i += 250) {
    const rows = await fetchJson(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&ids=${ids.slice(i, i + 250).join(',')}`);
    for (const r of Array.isArray(rows) ? rows : []) { caps[r.id] = r.market_cap || 0; prices[r.id] = r.current_price; }
    await sleep(2500);
  }
  const ordered = candidates.filter((t) => prices[t.coingeckoId]).sort((a, b) => (caps[b.coingeckoId] || 0) - (caps[a.coingeckoId] || 0));
  const passed = new Set();
  let checked = 0;
  for (const t of ordered) {
    const qs = new URLSearchParams({ fromChain: '56', toChain: '56', fromToken: USDT, toToken: t.address, fromAmount: (BigInt(PROBE_USD) * 10n ** 18n).toString(), fromAddress: '0x0000000000000000000000000000000000000001', slippage: '0.01', allowExchanges: 'bitget' });
    const res = await fetch(`https://li.quest/v1/quote?${qs}`);
    if (res.status === 429) { console.log(`  LI.FI rate limit reached after ${checked} checks; remaining tokens keep their KyberSwap result`); break; }
    checked++;
    const d = await res.json().catch(() => null);
    const swaps = (d?.includedSteps ?? []).filter((x) => x.type === 'swap').map((x) => x.tool);
    if (d?.estimate?.toAmount && swaps.length && swaps.every((x) => x === 'bitget')) {
      const valueOut = (Number(d.estimate.toAmount) / 10 ** t.decimals) * prices[t.coingeckoId];
      if (1 - valueOut / PROBE_USD < MAX_PROBE_LOSS) passed.add(t.address);
    }
    await sleep(400);
  }
  console.log(`  Bitget checked ${checked} tokens, ${passed.size} passed`);
  return tokens.map((t) => (passed.has(t.address) ? { ...t, tradeable: true } : t));
}

if (process.argv.includes('--bitget-only')) {
  const existing = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const tokens = await probeBitget(existing.tokens);
  fs.writeFileSync(OUT, JSON.stringify({ ...existing, generatedAt: new Date().toISOString(), tokens }, null, 0) + '\n');
  console.log(`Tradeable after Bitget check: ${tokens.filter((t) => t.tradeable).length}/${tokens.length}`);
  process.exit(0);
}

if (process.argv.includes('--logos-only')) {
  const existing = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const sources = new Map((await ondoTokens()).map((t) => [t.address.toLowerCase(), t.logo]));
  const tokens = await verifyLogos(existing.tokens.map((t) => ({ ...t, logo: sources.get(t.address.toLowerCase()) })));
  fs.writeFileSync(OUT, JSON.stringify({ ...existing, tokens }, null, 0) + '\n');
  console.log(`Logos attached: ${tokens.filter((t) => t.logo).length}/${tokens.length}`);
  process.exit(0);
}

const ondo = await ondoTokens();
console.log(`Ondo list: ${ondo.length} BNB Chain tokens`);
const verified = await verifyOnChain(ondo);
console.log(`Verified on-chain (symbol match, non-zero supply): ${verified.length}`);
const withLogos = await verifyLogos(verified);
console.log(`With logo: ${withLogos.filter((t) => t.logo).length}`);
const probed = await probeBitget(await probeLiquidity(withLogos));
const catalog = probed.sort((a, b) => Number(b.tradeable) - Number(a.tradeable) || a.symbol.localeCompare(b.symbol));
console.log(`Tradeable ($${PROBE_USD} buy within ${MAX_PROBE_LOSS * 100}% of reference price): ${catalog.filter((t) => t.tradeable).length}`);

fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), chainId: 56, tokens: catalog }, null, 0) + '\n');
console.log(`Wrote ${catalog.length} tokens to src/config/catalog.json`);
