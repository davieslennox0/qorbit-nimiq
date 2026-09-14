import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { formatUnits, getAddress, isAddress, parseUnits, type Address } from 'viem';
import { findToken, TOKENS, USDT, type StockToken } from '../../config/tokens';
import { useWallet } from '../../hooks/WalletContext';
import { usePortfolio } from '../../hooks/usePortfolio';
import { ERC20_ABI, publicClient, readBalance } from '../../lib/erc20';
import { getWalletClient } from '../../lib/wallet';
import { isValidNimAddress, sendNimTip } from '../../lib/nimiqSdk';
import { formatQty, shortAddress } from '../../lib/format';
import { LineItem, StepList, TxLink } from '../../components/Receipt';
import { IssuerTag, Notice, TokenGlyph } from '../../components/Chrome';
import { TokenPicker } from '../../components/TokenPicker';

type Step = 'enter' | 'review' | 'sending' | 'success';
type TipKind = 'USDT' | 'NIM';
type StepState = 'pending' | 'active' | 'done' | 'skipped';

function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : 'Transaction failed.';
  if (/user rejected|denied|rejected the request/i.test(msg)) return 'You declined the request in Nimiq Pay.';
  if (/insufficient funds/i.test(msg)) return 'Not enough BNB to pay the network fee.';
  return msg.split('\n')[0];
}

export default function Send() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { evmAddress } = useWallet();
  const { holdings } = usePortfolio(evmAddress);

  const [token, setToken] = useState<StockToken | undefined>(findToken(params.get('token')));
  const [picking, setPicking] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [balance, setBalance] = useState<bigint | null>(null);

  const [tipOn, setTipOn] = useState(false);
  const [tipKind, setTipKind] = useState<TipKind>('USDT');
  const [tipAmount, setTipAmount] = useState('');
  const [tipNimRecipient, setTipNimRecipient] = useState('');

  const [step, setStep] = useState<Step>('enter');
  const [giftState, setGiftState] = useState<StepState>('pending');
  const [tipState, setTipState] = useState<StepState>('pending');
  const [giftHash, setGiftHash] = useState<string | null>(null);
  const [tipRef, setTipRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Default to the user's largest holding once balances load.
  useEffect(() => {
    if (!token && holdings.length) setToken(holdings[0]);
  }, [holdings, token]);

  useEffect(() => {
    if (!evmAddress || !token) return;
    let cancelled = false;
    readBalance(token.address, evmAddress).then((b) => !cancelled && setBalance(b)).catch(() => {});
    return () => { cancelled = true; };
  }, [token, evmAddress, step]);

  const amountRaw = useMemo(() => {
    try { return token && amount ? parseUnits(amount, token.decimals) : 0n; } catch { return 0n; }
  }, [amount, token]);
  const tipRaw = useMemo(() => {
    try { return tipAmount ? parseUnits(tipAmount, tipKind === 'USDT' ? USDT.decimals : 5) : 0n; } catch { return 0n; }
  }, [tipAmount, tipKind]);

  const trimmed = recipient.trim();
  const recipientValid = isAddress(trimmed);
  const selfSend = recipientValid && !!evmAddress && getAddress(trimmed) === evmAddress;
  const insufficient = balance !== null && amountRaw > balance;
  const tipValid = !tipOn || (tipRaw > 0n && (tipKind === 'USDT' || isValidNimAddress(tipNimRecipient)));
  const canReview = !!token && recipientValid && !selfSend && amountRaw > 0n && !insufficient && tipValid;

  async function send() {
    if (!token || !evmAddress) return;
    setStep('sending');
    setError(null);
    const to = getAddress(trimmed) as Address;
    const wallet = getWalletClient(evmAddress);
    try {
      if (giftState !== 'done') {
        setGiftState('active');
        const hash = await wallet.writeContract({ address: token.address, abi: ERC20_ABI, functionName: 'transfer', args: [to, amountRaw] });
        setGiftHash(hash);
        const r = await publicClient.waitForTransactionReceipt({ hash });
        if (r.status !== 'success') throw new Error('Gift transfer reverted. Nothing was sent.');
        setGiftState('done');
      }

      if (!tipOn) {
        setTipState('skipped');
      } else if (tipState !== 'done') {
        setTipState('active');
        if (tipKind === 'USDT') {
          const hash = await wallet.writeContract({ address: USDT.address, abi: ERC20_ABI, functionName: 'transfer', args: [to, tipRaw] });
          setTipRef(hash);
          const r = await publicClient.waitForTransactionReceipt({ hash });
          if (r.status !== 'success') throw new Error('The USDT tip reverted. Your gift was delivered; the tip was not.');
        } else {
          setTipRef(await sendNimTip(tipNimRecipient, Number(tipAmount)));
        }
        setTipState('done');
      }
      setStep('success');
    } catch (e) {
      setError(friendlyError(e));
      setGiftState((s) => (s === 'active' ? 'pending' : s));
      setTipState((s) => (s === 'active' ? 'pending' : s));
    }
  }

  const giftLabel = token ? `${formatQty(Number(amount || 0))} ${token.symbol}` : '';
  const tipLabel = tipOn ? `${formatQty(Number(tipAmount || 0))} ${tipKind}` : null;

  if (step === 'enter') {
    return (
      <div className="screen stack">
        <h2 className="wordmark page-title">Send a gift</h2>

        <div className="card stack" style={{ gap: 10 }}>
          <label className="label" htmlFor="recipient">Recipient wallet address (BNB Chain)</label>
          <input id="recipient" placeholder="0x…" value={recipient} onChange={(e) => setRecipient(e.target.value)} autoComplete="off" spellCheck={false} />
          {recipient && !recipientValid && <span className="sub" style={{ color: 'var(--down)' }}>Not a valid address</span>}
          {selfSend && <span className="sub" style={{ color: 'var(--down)' }}>That's your own address</span>}

          <div className="row">
            <span className="label">Stock token</span>
            <span className="sub">Balance: {balance === null || !token ? '—' : formatQty(Number(formatUnits(balance, token.decimals)))}</span>
          </div>
          <button className="asset-button" style={{ maxWidth: '100%' }} onClick={() => setPicking(true)} aria-label="Choose stock token">
            {token ? (
              <>
                <TokenGlyph symbol={token.symbol} logo={token.logo} size={26} />
                <span style={{ fontWeight: 600 }}>{token.symbol}</span>
                <IssuerTag issuer={token.issuer} />
                <span className="sub ellipsis" style={{ flex: 1, textAlign: 'left' }}>{token.name}</span>
              </>
            ) : <span className="sub" style={{ flex: 1, textAlign: 'left' }}>Choose a stock token</span>}
            <span className="caret">▼</span>
          </button>
          <input inputMode="decimal" placeholder="Amount (fractions allowed)" value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.'))} aria-label="Amount to send" />
          {insufficient && <span className="sub" style={{ color: 'var(--down)' }}>Insufficient balance</span>}
        </div>

        <div className="card stack" style={{ gap: 10 }}>
          <label className="row" style={{ cursor: 'pointer' }}>
            <span><strong>Add a tip</strong> <span className="sub">optional</span></span>
            <input type="checkbox" checked={tipOn} onChange={(e) => setTipOn(e.target.checked)} style={{ width: 22, height: 22, accentColor: 'var(--gold)' }} />
          </label>
          {tipOn && (
            <>
              <div className="segmented">
                {(['USDT', 'NIM'] as TipKind[]).map((k) => <button key={k} className={tipKind === k ? 'on' : ''} onClick={() => { setTipKind(k); setTipAmount(''); }}>{k}</button>)}
              </div>
              <input inputMode="decimal" placeholder={`Tip in ${tipKind}`} value={tipAmount} onChange={(e) => setTipAmount(e.target.value.replace(',', '.'))} aria-label="Tip amount" />
              {tipKind === 'NIM' ? (
                <>
                  <input placeholder="Recipient's NIM address (NQ…)" value={tipNimRecipient} onChange={(e) => setTipNimRecipient(e.target.value)} spellCheck={false} aria-label="Recipient NIM address" />
                  {tipNimRecipient && !isValidNimAddress(tipNimRecipient) && <span className="sub" style={{ color: 'var(--down)' }}>Not a valid NIM address</span>}
                  <span className="sub">Sent from your Nimiq account through Nimiq Pay.</span>
                </>
              ) : (
                <span className="sub">Sent on BNB Chain to the same recipient address.</span>
              )}
            </>
          )}
        </div>

        <button className="btn btn-primary" disabled={!canReview} onClick={() => setStep('review')}>Review gift</button>

        {picking && (
          <TokenPicker
            title="Gift which stock?"
            assets={holdings.length ? holdings : TOKENS}
            onClose={() => setPicking(false)}
            onPick={(a) => { setToken(findToken(a.address)); setAmount(''); setPicking(false); }}
          />
        )}
      </div>
    );
  }

  if (!token) return null;

  if (step === 'review') {
    return (
      <div className="screen stack">
        <h2 className="wordmark page-title">Review gift</h2>
        <div className="card certificate-border">
          <LineItem label="To" value={<span className="mono">{shortAddress(trimmed)}</span>} />
          <LineItem label="Gift" value={giftLabel} strong />
          {tipLabel && <LineItem label="Tip" value={tipLabel} />}
          {tipOn && tipKind === 'NIM' && <LineItem label="Tip to" value={<span className="mono">{tipNimRecipient.replace(/\s/g, '').toUpperCase().replace(/(.{4})/g, '$1 ').trim()}</span>} />}
          <LineItem label="Platform fee" value="None" />
          <LineItem label="Network" value={tipOn && tipKind === 'NIM' ? 'BNB Chain + Nimiq' : 'BNB Chain'} />
        </div>
        <Notice>Transfers are final. Tokens sent to a wrong address can't be recovered.{tipOn ? ' The gift and the tip are confirmed separately in Nimiq Pay.' : ''}</Notice>
        <div className="btn-row">
          <button className="btn btn-secondary" onClick={() => setStep('enter')}>Edit</button>
          <button className="btn btn-primary" onClick={send}>Send</button>
        </div>
      </div>
    );
  }

  if (step === 'sending') {
    return (
      <div className="screen stack">
        <h2 className="wordmark page-title">Sending</h2>
        <StepList steps={[
          { label: `Send ${giftLabel}`, state: giftState },
          ...(tipOn ? [{ label: `Tip ${tipLabel}`, state: tipState }] : []),
        ]} />
        {giftHash && <LineItem label="Gift" value={<TxLink hash={giftHash} />} />}
        {error && (
          <>
            <Notice tone="error">{error}</Notice>
            <div className="btn-row">
              {giftState !== 'done' && <button className="btn btn-secondary" onClick={() => setStep('review')}>Back</button>}
              {giftState === 'done' && <button className="btn btn-secondary" onClick={() => { setTipOn(false); setStep('success'); }}>Skip tip</button>}
              <button className="btn btn-primary" onClick={send}>Retry</button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="screen stack" style={{ gap: 16, textAlign: 'center' }}>
      <div className="card certificate-border" style={{ padding: '26px 18px' }}>
        <span className="stamp">Delivered</span>
        <div className="label" style={{ marginTop: 18 }}>You gifted</div>
        <div className="value-serif" style={{ fontSize: 30, margin: '6px 0 16px' }}>{giftLabel}</div>
        <div style={{ textAlign: 'left' }}>
          <LineItem label="To" value={<span className="mono">{shortAddress(trimmed)}</span>} />
          {tipOn && tipState === 'done' && <LineItem label="Tip" value={tipLabel} />}
          {giftHash && <LineItem label="Gift transaction" value={<TxLink hash={giftHash} />} />}
          {tipOn && tipKind === 'USDT' && tipRef && <LineItem label="Tip transaction" value={<TxLink hash={tipRef} />} />}
        </div>
      </div>
      <button className="btn btn-primary" onClick={() => navigate('/portfolio')}>Back to portfolio</button>
    </div>
  );
}
