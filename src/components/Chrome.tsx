import { useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useWallet } from '../hooks/WalletContext';
import { shortAddress } from '../lib/format';

export function TopBar({ back }: { back?: boolean }) {
  const navigate = useNavigate();
  const { evmAddress } = useWallet();
  return (
    <header className="topbar">
      {back ? (
        <button className="link-btn" onClick={() => navigate(-1)} aria-label="Back">← Back</button>
      ) : (
        <span className="wordmark">Qorbit</span>
      )}
      <span className="label mono">{evmAddress ? shortAddress(evmAddress) : ''}</span>
    </header>
  );
}

export function TabBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const tabs = [
    { path: '/portfolio', label: 'Portfolio' },
    { path: '/market', label: 'Market' },
    { path: '/swap', label: 'Swap' },
    { path: '/send', label: 'Send' },
  ];
  return (
    <nav className="tabbar">
      {tabs.map((t) => (
        <button key={t.path} className={`tab ${pathname.startsWith(t.path) ? 'active' : ''}`} onClick={() => navigate(t.path)}>
          <span className="dot" />
          {t.label}
        </button>
      ))}
    </nav>
  );
}

export function TokenGlyph({ symbol, logo, size = 40 }: { symbol: string; logo?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const base = symbol.replace(/on$/, '');
  if (logo && !failed) {
    return (
      <img
        className="token-logo"
        src={logo}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="token-glyph" style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden>
      {base.slice(0, base.length > 3 ? 2 : 3)}
    </span>
  );
}

export function ChangePill({ change }: { change: number | null | undefined }) {
  if (change === null || change === undefined) return null;
  const up = change >= 0;
  return <span className={`pill ${up ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {Math.abs(change).toFixed(2)}%</span>;
}

export function Notice({ children, tone }: { children: ReactNode; tone?: 'error' }) {
  return <div className={`warn-banner ${tone === 'error' ? 'error' : ''}`} role={tone === 'error' ? 'alert' : undefined}>{children}</div>;
}
