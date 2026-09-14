import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useWallet } from '../hooks/WalletContext';
import { shortAddress } from '../lib/format';
import { ISSUER_LABEL, type Issuer } from '../config/tokens';

export function TopBar({ back }: { back?: boolean }) {
  const navigate = useNavigate();
  const { evmAddress } = useWallet();
  return (
    <header className="topbar">
      {back ? (
        <button className="link-btn" onClick={() => navigate(-1)} aria-label="Back">← Back</button>
      ) : (
        <span className="wordmark">Qorbitpay</span>
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

export function TokenGlyph({ symbol, size = 40 }: { symbol: string; size?: number }) {
  const base = symbol.replace(/(on|x)$/, '');
  return (
    <span className="token-glyph" style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden>
      {base.slice(0, base.length > 3 ? 2 : 3)}
    </span>
  );
}

export function IssuerTag({ issuer }: { issuer?: Issuer }) {
  if (!issuer) return null;
  return <span className="issuer-tag">{ISSUER_LABEL[issuer]}</span>;
}

export function ChangePill({ change }: { change: number | null | undefined }) {
  if (change === null || change === undefined) return null;
  const up = change >= 0;
  return <span className={`pill ${up ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {Math.abs(change).toFixed(2)}%</span>;
}

export function Notice({ children, tone }: { children: ReactNode; tone?: 'error' }) {
  return <div className={`warn-banner ${tone === 'error' ? 'error' : ''}`} role={tone === 'error' ? 'alert' : undefined}>{children}</div>;
}
