import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../hooks/WalletContext';
import { isNimiqPayEvmAvailable } from '../lib/wallet';

export default function Connect() {
  const { evmAddress, connect, connecting, error } = useWallet();
  const navigate = useNavigate();
  const inHost = isNimiqPayEvmAvailable();

  useEffect(() => {
    if (evmAddress) navigate('/portfolio', { replace: true });
  }, [evmAddress, navigate]);

  useEffect(() => {
    if (inHost && !evmAddress) connect();
  }, [inHost, evmAddress, connect]);

  return (
    <div className="screen" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 24, textAlign: 'center' }}>
      <div className="card certificate-border" style={{ padding: '36px 20px' }}>
        <div className="label">Certificate of Holding</div>
        <h1 className="wordmark" style={{ fontSize: 48, margin: '10px 0 6px' }}>Qorbitpay</h1>
        <p className="value-serif" style={{ fontStyle: 'italic', color: 'var(--ink-soft)', margin: 0 }}>
          Tokenized equities, held in your Nimiq Pay wallet.
        </p>
      </div>

      {inHost ? (
        <button className="btn btn-primary" onClick={connect} disabled={connecting}>
          {connecting ? 'Awaiting confirmation in Nimiq Pay…' : 'Connect wallet'}
        </button>
      ) : (
        <div className="warn-banner">Open Qorbitpay from inside Nimiq Pay to connect your wallet.</div>
      )}

      {error && <div className="warn-banner" role="alert">{error}</div>}

      <p className="label" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
        BNB Chain · No account, no sign-up. Your wallet is your identity.
      </p>
    </div>
  );
}
