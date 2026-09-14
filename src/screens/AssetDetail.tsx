import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { formatUnits } from 'viem';
import { findToken, ISSUER_DISCLOSURE, ISSUER_LABEL } from '../config/tokens';
import { EXPLORER_ADDRESS } from '../config/chain';
import { useWallet } from '../hooks/WalletContext';
import { useQuotes } from '../hooks/useQuotes';
import { fetchPriceHistory, type PricePoint } from '../lib/prices';
import { readBalance } from '../lib/erc20';
import { ChangePill, IssuerTag, Notice, TokenGlyph } from '../components/Chrome';
import { formatQty, formatUsd, shortAddress } from '../lib/format';

function Sparkline({ points }: { points: PricePoint[] }) {
  const path = useMemo(() => {
    if (points.length < 2) return '';
    const w = 320, h = 90;
    const vals = points.map((p) => p.usd);
    const min = Math.min(...vals), span = Math.max(...vals) - min || 1;
    return points.map((p, i) => `${i ? 'L' : 'M'}${((i / (points.length - 1)) * w).toFixed(1)},${(h - ((p.usd - min) / span) * h).toFixed(1)}`).join(' ');
  }, [points]);
  if (!path) return null;
  const up = points[points.length - 1].usd >= points[0].usd;
  return (
    <svg viewBox="0 0 320 90" width="100%" height="90" preserveAspectRatio="none" role="img" aria-label="7-day price movement">
      <path d={path} fill="none" stroke={up ? 'var(--up)' : 'var(--down)'} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function AssetDetail() {
  const { address } = useParams<{ address: string }>();
  const token = findToken(address);
  const { evmAddress } = useWallet();
  const navigate = useNavigate();

  const { quotes, error } = useQuotes([token?.coingeckoId]);
  const quote = token?.coingeckoId ? quotes[token.coingeckoId] ?? null : null;
  const [history, setHistory] = useState<PricePoint[] | null>(null);
  const [held, setHeld] = useState<number | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    if (token.coingeckoId) {
      fetchPriceHistory(token.coingeckoId, 7).then((h) => !cancelled && setHistory(h)).catch(() => !cancelled && setHistory([]));
    } else {
      setHistory([]);
    }
    if (evmAddress) {
      readBalance(token.address, evmAddress).then((b) => !cancelled && setHeld(Number(formatUnits(b, token.decimals)))).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [token, evmAddress]);

  if (!token) return <div className="screen"><Notice>This token isn't in the Qorbit catalog.</Notice></div>;

  const weekChange = history && history.length > 1 ? ((history[history.length - 1].usd - history[0].usd) / history[0].usd) * 100 : null;
  const holds = held !== null && held > 0;

  return (
    <div className="screen stack" style={{ gap: 16 }}>
      <div className="row" style={{ gap: 12, justifyContent: 'flex-start' }}>
        <TokenGlyph symbol={token.symbol} logo={token.logo} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 18 }}>{token.symbol} <IssuerTag issuer={token.issuer} /></div>
          <div className="sub ellipsis">{token.name} · {token.kind === 'etf' ? 'ETF' : 'Stock'}</div>
        </div>
      </div>

      <div className="card certificate-border">
        <div className="label">Live price</div>
        <div className="row" style={{ alignItems: 'baseline', marginTop: 4 }}>
          <span className="value-serif" style={{ fontSize: 36 }}>{quote ? formatUsd(quote.usd) : '—'}</span>
          <ChangePill change={quote?.change24h} />
        </div>
        <div style={{ marginTop: 14 }}>
          {history === null && <p className="sub">Loading price action…</p>}
          {history && history.length > 1 && <Sparkline points={history} />}
          {history && history.length <= 1 && <p className="sub">No recent price history available.</p>}
          <div className="row label" style={{ marginTop: 6 }}>
            <span>7 days</span>
            {weekChange !== null && <span style={{ color: weekChange >= 0 ? 'var(--up)' : 'var(--down)' }}>{weekChange >= 0 ? '+' : ''}{weekChange.toFixed(2)}%</span>}
          </div>
        </div>
      </div>

      {error && <Notice>{error}</Notice>}
      {!token.tradeable && <Notice>This listing had no meaningful DEX liquidity on BNB Chain when the catalog was built. A swap may not find a route.</Notice>}

      {holds && (
        <div className="card line-item" style={{ padding: '12px 16px' }}>
          <span>You hold</span>
          <span className="value-serif">{formatQty(held)} {token.symbol}{quote ? ` · ${formatUsd(held * quote.usd)}` : ''}</span>
        </div>
      )}

      <div className="btn-row">
        <button className="btn btn-primary" onClick={() => navigate(`/swap?to=${token.address}`)}>Buy</button>
        {holds && <button className="btn btn-secondary" onClick={() => navigate(`/swap?from=${token.address}`)}>Sell</button>}
      </div>
      {holds && <button className="btn btn-secondary" onClick={() => navigate(`/send?token=${token.address}`)}>Send as gift</button>}

      <p className="disclosure">
        {ISSUER_DISCLOSURE[token.issuer]} {ISSUER_LABEL[token.issuer]} contract:{' '}
        <a href={EXPLORER_ADDRESS(token.address)} target="_blank" rel="noreferrer" className="mono">{shortAddress(token.address)}</a>
      </p>
    </div>
  );
}
