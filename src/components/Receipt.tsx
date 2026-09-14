import type { ReactNode } from 'react';
import { EXPLORER_TX } from '../config/chain';

export function LineItem({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="line-item" style={strong ? { fontWeight: 700 } : undefined}>
      <span style={{ color: strong ? 'var(--ink)' : 'var(--ink-soft)' }}>{label}</span>
      <span className="value-serif" style={{ textAlign: 'right' }}>{value}</span>
    </div>
  );
}

export function StepList({ steps }: { steps: { label: string; state: 'pending' | 'active' | 'done' | 'skipped' }[] }) {
  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {steps.map((s, i) => (
        <li key={s.label} className="card" style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 14px', color: s.state === 'pending' ? 'var(--ink-faint)' : undefined }}>
          <span className="token-glyph" style={{ width: 30, height: 30, fontSize: 14, color: s.state === 'done' ? 'var(--up)' : 'var(--gold)' }}>
            {s.state === 'done' ? '✓' : i + 1}
          </span>
          <span style={{ flex: 1 }}>{s.label}</span>
          <span className="label">
            {s.state === 'active' ? 'Confirm in Nimiq Pay' : s.state === 'done' ? 'Done' : s.state === 'skipped' ? 'Not needed' : 'Waiting'}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function TxLink({ hash }: { hash: string }) {
  return (
    <a href={EXPLORER_TX(hash)} target="_blank" rel="noreferrer" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>
      {hash.slice(0, 10)}…{hash.slice(-8)} ↗
    </a>
  );
}
