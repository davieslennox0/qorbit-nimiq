import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TOKENS, type Issuer } from '../config/tokens';
import { useQuotes } from '../hooks/useQuotes';
import { ChangePill, IssuerTag, Notice, TokenGlyph } from '../components/Chrome';
import { matchesQuery } from '../components/TokenPicker';
import { formatUsd } from '../lib/format';

const PAGE = 40;
type Scope = 'tradeable' | 'all';
type IssuerFilter = 'any' | Issuer;

export default function Market() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<Scope>('tradeable');
  const [issuer, setIssuer] = useState<IssuerFilter>('any');
  const [limit, setLimit] = useState(PAGE);

  const filtered = useMemo(
    () => TOKENS.filter((t) => (scope === 'all' || t.tradeable) && (issuer === 'any' || t.issuer === issuer) && matchesQuery(t, q)),
    [q, scope, issuer],
  );
  const visible = filtered.slice(0, limit);
  const { quotes, loading, error } = useQuotes(visible.map((t) => t.coingeckoId));

  const reset = () => setLimit(PAGE);

  return (
    <div className="screen stack">
      <h2 className="wordmark page-title">The Market</h2>
      <input placeholder={`Search ${TOKENS.length.toLocaleString()} stocks & ETFs`} value={q} onChange={(e) => { setQ(e.target.value); reset(); }} aria-label="Search stock tokens" />

      <div className="segmented" role="group" aria-label="Liquidity">
        <button className={scope === 'tradeable' ? 'on' : ''} onClick={() => { setScope('tradeable'); reset(); }}>Tradeable now</button>
        <button className={scope === 'all' ? 'on' : ''} onClick={() => { setScope('all'); reset(); }}>All listings</button>
      </div>
      <div className="segmented" role="group" aria-label="Issuer">
        {(['any', 'ondo', 'xstocks'] as IssuerFilter[]).map((i) => (
          <button key={i} className={issuer === i ? 'on' : ''} onClick={() => { setIssuer(i); reset(); }}>
            {i === 'any' ? 'All issuers' : i === 'ondo' ? 'Ondo' : 'xStocks'}
          </button>
        ))}
      </div>

      {error && <Notice>{error}</Notice>}

      <div className="card" style={{ padding: '4px 14px' }}>
        <div className="row label" style={{ padding: '10px 4px 2px' }}>
          <span>{filtered.length.toLocaleString()} listings</span>
          {loading && <span>Updating prices…</span>}
        </div>
        {visible.map((t) => {
          const quote = t.coingeckoId ? quotes[t.coingeckoId] : null;
          return (
            <button key={t.address} className="token-row" onClick={() => navigate(`/asset/${t.address}`)}>
              <TokenGlyph symbol={t.symbol} logo={t.logo} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{t.symbol} <IssuerTag issuer={t.issuer} /></div>
                <div className="sub ellipsis">{t.name}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="value-serif">{quote ? formatUsd(quote.usd) : '—'}</div>
                <ChangePill change={quote?.change24h} />
              </div>
            </button>
          );
        })}
        {filtered.length === 0 && <p className="label" style={{ padding: 8 }}>No matches.</p>}
      </div>
      {filtered.length > limit && (
        <button className="btn btn-secondary" onClick={() => setLimit((l) => l + PAGE)}>Show more ({(filtered.length - limit).toLocaleString()} left)</button>
      )}
      {scope === 'all' && <p className="disclosure">"All listings" includes tokens with little or no DEX liquidity on BNB Chain today. You can still hold and send them; swaps may not find a route.</p>}
    </div>
  );
}
