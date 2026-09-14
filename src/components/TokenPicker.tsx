import { useEffect, useMemo, useRef, useState } from 'react';
import type { Asset } from '../config/tokens';
import { IssuerTag, TokenGlyph } from './Chrome';

const PAGE = 60;

export function matchesQuery(a: Asset, q: string) {
  const s = q.trim().toLowerCase();
  return !s || a.symbol.toLowerCase().includes(s) || a.name.toLowerCase().includes(s);
}

/** Searchable bottom sheet for choosing one of ~1,300 assets. */
export function TokenPicker({ title, assets, onPick, onClose, exclude }: {
  title: string; assets: Asset[]; onPick: (a: Asset) => void; onClose: () => void; exclude?: string;
}) {
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const filtered = useMemo(
    () => assets.filter((a) => a.address !== exclude && matchesQuery(a, q)),
    [assets, q, exclude],
  );

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="wordmark" style={{ fontSize: 20 }}>{title}</span>
          <button className="link-btn" onClick={onClose}>Close</button>
        </div>
        <input ref={inputRef} placeholder="Search ticker or company" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} aria-label="Search assets" />
        <div className="sheet-list">
          {filtered.slice(0, limit).map((a) => (
            <button key={a.address} className="token-row" onClick={() => onPick(a)}>
              <TokenGlyph symbol={a.symbol} logo={a.logo} size={34} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{a.symbol} <IssuerTag issuer={a.issuer} /></div>
                <div className="sub ellipsis">{a.name}</div>
              </div>
              {a.tradeable === false && <span className="label">Low liquidity</span>}
            </button>
          ))}
          {filtered.length === 0 && <p className="label" style={{ padding: 12 }}>No matches.</p>}
          {filtered.length > limit && <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={() => setLimit((l) => l + PAGE)}>Show more ({filtered.length - limit} left)</button>}
        </div>
      </div>
    </div>
  );
}
