// Builds src/config/catalog.json: every Ondo and xStocks token deployed on BNB Chain,
// sourced only from issuer-published lists, verified on-chain, with a liquidity probe.
// Usage: node scripts/build-catalog.mjs
import fs from 'node:fs';
import { createPublicClient, getAddress, http, parseAbi } from 'viem';
import { bsc } from 'viem/chains';

const ONDO_CSV = 'https://www.dropbox.com/scl/fi/qjfxyg748mx0dwi6up86d/EXTERNAL-Ondo-GM-Tokens-Ondo-GM-Tokens.csv?rlkey=n3no1w78wrah3umsl0nr9s77i&dl=1';
const XSTOCKS_API = 'https://api.xstocks.fi/api/v2/public/assets';
const KYBER = 'https://aggregator-api.kyberswap.com/bsc/api/v1/routes';
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const PROBE_USD = 50n;
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
      issuer: 'ondo',
      kind: r[col('Type')] === 'ETF' ? 'etf' : 'stock',
      coingeckoId: r[col('CoinGecko API ID')] || undefined,
      logo: ondoLogo(r[col('Symbol')], r[col('Link to image (png)')]),
    }));
}

async function xstocksTokens() {
  const all = [];
  for (let page = 0; ; page++) {
    const j = await fetchJson(`${XSTOCKS_API}?limit=100&page=${page}`);
    all.push(...j.nodes);
    if (!j.page.hasNextPage) break;
  }
  return all.flatMap((a) =>
    a.isTradingHalted ? [] : a.deployments
      .filter((d) => d.network === 'BinanceSmartChain')
      .map((d) => ({
        symbol: a.symbol,
        name: a.name.replace(/ xStock$/, ''),
        address: getAddress(d.address),
        issuer: 'xstocks',
        kind: /etf|trust|fund/i.test(a.name) ? 'etf' : 'stock',
        logo: a.logo || undefined,
      })),
  );
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

async function attachCoingeckoIds(tokens) {
  const list = await fetchJson('https://api.coingecko.com/api/v3/coins/list?include_platform=true');
  const byAddress = new Map();
  for (const coin of list) {
    const a = coin.platforms?.['binance-smart-chain'];
    if (a) byAddress.set(a.toLowerCase(), coin.id);
  }
  return tokens.map((t) => ({ ...t, coingeckoId: t.coingeckoId ?? byAddress.get(t.address.toLowerCase()) }));
}

async function probeLiquidity(tokens) {
  const amountIn = (PROBE_USD * 10n ** 18n).toString();
  let done = 0;
  const results = new Array(tokens.length);
  const worker = async (queue) => {
    for (const i of queue) {
      const t = tokens[i];
      try {
        const j = await fetchJson(`${KYBER}?tokenIn=${USDT}&tokenOut=${t.address}&amountIn=${amountIn}`, { headers: { 'x-client-id': 'qorbit' } });
        const r = j.data?.routeSummary;
        const loss = r ? 1 - Number(r.amountOutUsd) / Number(r.amountInUsd) : 1;
        results[i] = { ...t, tradeable: !!r && Number(r.amountOutUsd) > 0 && loss < 0.05 };
      } catch {
        results[i] = { ...t, tradeable: false };
      }
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

if (process.argv.includes('--logos-only')) {
  const existing = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const sources = new Map([...(await ondoTokens()), ...(await xstocksTokens())].map((t) => [t.address.toLowerCase(), t.logo]));
  const tokens = await verifyLogos(existing.tokens.map((t) => ({ ...t, logo: sources.get(t.address.toLowerCase()) })));
  fs.writeFileSync(OUT, JSON.stringify({ ...existing, tokens }, null, 0) + '\n');
  console.log(`Logos attached: ${tokens.filter((t) => t.logo).length}/${tokens.length}`);
  process.exit(0);
}

const ondo = await ondoTokens();
const xstocks = await xstocksTokens();
console.log(`Issuer lists: Ondo ${ondo.length}, xStocks ${xstocks.length}`);
const verified = await verifyOnChain([...ondo, ...xstocks]);
console.log(`Verified on-chain (symbol match, non-zero supply): ${verified.length}`);
const withIds = await attachCoingeckoIds(verified);
console.log(`With CoinGecko id: ${withIds.filter((t) => t.coingeckoId).length}`);
const probed = await probeLiquidity(await verifyLogos(withIds));
const catalog = probed.sort((a, b) => Number(b.tradeable) - Number(a.tradeable) || a.symbol.localeCompare(b.symbol));
console.log(`Tradeable ($${PROBE_USD} route under 5% loss): ${catalog.filter((t) => t.tradeable).length}`);

fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), chainId: 56, tokens: catalog }, null, 0) + '\n');
console.log(`Wrote ${catalog.length} tokens to src/config/catalog.json`);
