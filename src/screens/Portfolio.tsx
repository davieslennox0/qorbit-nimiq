import { useNavigate } from 'react-router-dom';
import { useWallet } from '../hooks/WalletContext';
import { usePortfolio } from '../hooks/usePortfolio';
import { ChangePill, IssuerTag, Notice, TokenGlyph } from '../components/Chrome';
import { formatQty, formatUsd } from '../lib/format';

export default function Portfolio() {
  const { evmAddress } = useWallet();
  const { holdings, loading, error } = usePortfolio(evmAddress);
  const navigate = useNavigate();

  const total = holdings.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0);
  const unpriced = holdings.some((h) => h.valueUsd === null);

  return (
    <div className="screen stack" style={{ gap: 16 }}>
      <div className="card certificate-border" style={{ textAlign: 'center', padding: '22px 16px' }}>
        <div className="label">Portfolio value</div>
        <div className="value-serif" style={{ fontSize: 38, marginTop: 6 }}>{loading ? '—' : formatUsd(total)}</div>
        <div className="sub" style={{ marginTop: 4 }}>
          {loading ? 'Reading balances on BNB Chain…' : `${holdings.length} ${holdings.length === 1 ? 'holding' : 'holdings'}${unpriced ? ' · some without a live price' : ''}`}
        </div>
      </div>

      <div className="btn-row">
        <button className="btn btn-primary" onClick={() => navigate('/swap')}>Swap</button>
        <button className="btn btn-secondary" onClick={() => navigate('/send')}>Send</button>
      </div>

      {error && <Notice>{error}</Notice>}

      <div className="card" style={{ padding: '4px 14px' }}>
        <div className="label" style={{ padding: '12px 4px 4px' }}>Holdings</div>
        {!loading && holdings.length === 0 && (
          <div style={{ padding: '16px 4px 20px' }}>
            <p className="value-serif" style={{ fontStyle: 'italic', margin: '0 0 12px' }}>No stock tokens held yet.</p>
            <button className="btn btn-gold" onClick={() => navigate('/market')}>Browse the market</button>
          </div>
        )}
        {holdings.map((h) => (
          <button key={h.address} className="token-row" onClick={() => navigate(`/asset/${h.address}`)}>
            <TokenGlyph symbol={h.symbol} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{h.symbol} <IssuerTag issuer={h.issuer} /></div>
              <div className="sub">{formatQty(h.quantity)} {h.kind === 'etf' ? 'units' : 'shares'}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="value-serif">{h.valueUsd === null ? '—' : formatUsd(h.valueUsd)}</div>
              <ChangePill change={h.quote?.change24h} />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
