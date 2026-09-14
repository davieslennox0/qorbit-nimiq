import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { formatUnits, parseEventLogs, parseUnits, type Address } from 'viem';
import { findToken, STABLES, TOKENS, USDT, type Asset } from '../../config/tokens';
import { useWallet } from '../../hooks/WalletContext';
import { ERC20_ABI, publicClient, readAllowance, readBalance } from '../../lib/erc20';
import { buildSwapTx, getFeeRecipient, getQuote, KYBER_ROUTER, type SwapQuote } from '../../lib/kyberswap';
import { getWalletClient } from '../../lib/wallet';
import { formatQty, formatUsd } from '../../lib/format';
import { LineItem, StepList, TxLink } from '../../components/Receipt';
import { IssuerTag, Notice, TokenGlyph } from '../../components/Chrome';
import { TokenPicker } from '../../components/TokenPicker';

type Step = 'enter' | 'review' | 'confirm' | 'success';
type StepState = 'pending' | 'active' | 'done' | 'skipped';

const ASSETS: Asset[] = [...STABLES, ...TOKENS];
const SLIPPAGE_OPTIONS = [50, 100, 300];
const QUOTE_MAX_AGE_MS = 30_000;
const TRANSFER_EVENT = [{ type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] }] as const;

const assetFor = (addr: string | null): Asset | undefined =>
  addr ? STABLES.find((s) => s.address.toLowerCase() === addr.toLowerCase()) ?? findToken(addr) : undefined;

/** Dry-runs the swap so a revert surfaces before the wallet prompt; retries once in case an RPC node lags behind a just-mined approval. */
async function simulateWithRetry(account: Address, to: Address, data: `0x${string}`) {
  try {
    await publicClient.call({ account, to, data });
  } catch {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      await publicClient.call({ account, to, data });
    } catch {
      throw new Error('This swap would fail on-chain right now (price moved or liquidity changed). Nothing was signed — get a new quote.');
    }
  }
}

function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : 'Transaction failed.';
  if (/user rejected|denied|rejected the request/i.test(msg)) return 'You declined the request in Nimiq Pay.';
  if (/insufficient funds/i.test(msg)) return 'Not enough BNB to pay the network fee.';
  return msg.split('\n')[0];
}

export default function Swap() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { evmAddress } = useWallet();
  const feeRecipient = getFeeRecipient();

  const initialTo = assetFor(params.get('to'));
  const [from, setFrom] = useState<Asset>(assetFor(params.get('from')) ?? USDT);
  const [to, setTo] = useState<Asset>(initialTo ?? findToken('0x6a708EAD771238919D85930b5a0f10454E1C331a') ?? TOKENS[0]);
  const [picking, setPicking] = useState<'from' | 'to' | null>(null);
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState(100);
  const [balance, setBalance] = useState<bigint | null>(null);

  const [step, setStep] = useState<Step>('enter');
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approveState, setApproveState] = useState<StepState>('pending');
  const [swapState, setSwapState] = useState<StepState>('pending');
  const [approveHash, setApproveHash] = useState<string | null>(null);
  const [swapHash, setSwapHash] = useState<string | null>(null);
  const [received, setReceived] = useState<bigint | null>(null);

  useEffect(() => {
    if (!evmAddress) return;
    let cancelled = false;
    setBalance(null);
    readBalance(from.address, evmAddress).then((b) => !cancelled && setBalance(b)).catch(() => {});
    return () => { cancelled = true; };
  }, [from, evmAddress, step]);

  const amountIn = useMemo(() => {
    try { return amount ? parseUnits(amount, from.decimals) : 0n; } catch { return 0n; }
  }, [amount, from]);

  const insufficient = balance !== null && amountIn > balance;
  const canReview = !!evmAddress && !!feeRecipient && from.address !== to.address && amountIn > 0n && !insufficient;

  async function review() {
    if (!evmAddress || !feeRecipient) return;
    setError(null);
    setQuoting(true);
    try {
      setQuote(await getQuote({ tokenIn: from.address, tokenOut: to.address, amountIn, slippageBps, user: evmAddress, feeRecipient }));
      setStep('review');
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setQuoting(false);
    }
  }

  async function execute() {
    if (!quote || !evmAddress || !feeRecipient) return;
    setStep('confirm');
    setError(null);
    const wallet = getWalletClient(evmAddress);
    const reviewedMin = quote.minOutNet;
    try {
      if (approveState !== 'done' && approveState !== 'skipped') {
        const allowance = await readAllowance(quote.tokenIn, evmAddress, KYBER_ROUTER);
        if (allowance >= quote.amountIn) {
          setApproveState('skipped');
        } else {
          setApproveState('active');
          // Exact-amount approval, so no open-ended allowance is left on the router.
          const hash = await wallet.writeContract({ address: quote.tokenIn, abi: ERC20_ABI, functionName: 'approve', args: [KYBER_ROUTER, quote.amountIn] });
          setApproveHash(hash);
          const r = await publicClient.waitForTransactionReceipt({ hash });
          if (r.status !== 'success') throw new Error('Approval reverted. Nothing was swapped.');
          setApproveState('done');
        }
      }

      setSwapState('active');
      // Refresh a stale route, but never let the on-chain minimum drop below what the user reviewed.
      let exec = quote;
      if (Date.now() - quote.fetchedAt > QUOTE_MAX_AGE_MS) {
        const fresh = await getQuote({ tokenIn: quote.tokenIn, tokenOut: quote.tokenOut, amountIn: quote.amountIn, slippageBps: quote.slippageBps, user: evmAddress, feeRecipient });
        if (fresh.amountOutNet <= reviewedMin) throw new Error('The price moved past your minimum. Get a new quote to continue.');
        const headroomBps = Number(((fresh.amountOutNet - reviewedMin) * 10_000n) / fresh.amountOutNet);
        exec = { ...fresh, slippageBps: Math.min(quote.slippageBps, headroomBps) };
      }
      const tx = await buildSwapTx(exec, evmAddress, feeRecipient, reviewedMin);
      await simulateWithRetry(evmAddress, tx.to, tx.data);
      const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data });
      setSwapHash(hash);
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error('Swap reverted. No funds were exchanged.');
      const got = parseEventLogs({ abi: TRANSFER_EVENT, logs: r.logs, eventName: 'Transfer' })
        .filter((l) => l.address.toLowerCase() === quote.tokenOut.toLowerCase() && l.args.to.toLowerCase() === evmAddress.toLowerCase())
        .reduce((sum, l) => sum + l.args.value, 0n);
      setReceived(got);
      setSwapState('done');
      setStep('success');
    } catch (e) {
      setError(friendlyError(e));
      setApproveState((s) => (s === 'active' ? 'pending' : s));
      setSwapState((s) => (s === 'active' ? 'pending' : s));
    }
  }

  const fmt = (v: bigint, a: Asset) => `${formatQty(Number(formatUnits(v, a.decimals)))} ${a.symbol}`;

  const AssetButton = ({ asset, onClick, label }: { asset: Asset; onClick: () => void; label: string }) => (
    <button className="asset-button" onClick={onClick} aria-label={label}>
      <TokenGlyph symbol={asset.symbol} size={26} />
      <span style={{ fontWeight: 600 }} className="ellipsis">{asset.symbol}</span>
      <span className="caret">▼</span>
    </button>
  );

  if (step === 'enter') {
    return (
      <div className="screen stack">
        <h2 className="wordmark page-title">Swap</h2>
        {!feeRecipient && <Notice tone="error">Swaps are disabled: this build has no fee recipient configured.</Notice>}

        <div className="card stack" style={{ gap: 10 }}>
          <div className="row">
            <span className="label">You pay</span>
            <span className="sub">
              Balance: {balance === null ? '—' : formatQty(Number(formatUnits(balance, from.decimals)))}
              {balance !== null && balance > 0n && <button className="link-btn gold" style={{ marginLeft: 6 }} onClick={() => setAmount(formatUnits(balance, from.decimals))}>Max</button>}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.'))} aria-label="Amount to pay" />
            <AssetButton asset={from} onClick={() => setPicking('from')} label="Choose token to pay" />
          </div>
          {insufficient && <span className="sub" style={{ color: 'var(--down)' }}>Insufficient balance</span>}

          <button className="link-btn" style={{ alignSelf: 'center', fontSize: 20 }} aria-label="Swap direction" onClick={() => { setFrom(to); setTo(from); setAmount(''); }}>⇅</button>

          <div className="row">
            <span className="label">You receive</span>
            <IssuerTag issuer={to.issuer} />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="sub ellipsis" style={{ flex: 1 }}>{to.name}</div>
            <AssetButton asset={to} onClick={() => setPicking('to')} label="Choose token to receive" />
          </div>
        </div>

        <div className="card">
          <span className="label">Slippage tolerance</span>
          <div className="segmented" style={{ marginTop: 8 }}>
            {SLIPPAGE_OPTIONS.map((b) => <button key={b} className={slippageBps === b ? 'on' : ''} onClick={() => setSlippageBps(b)}>{b / 100}%</button>)}
          </div>
        </div>

        {to.tradeable === false && <Notice>{to.symbol} has little DEX liquidity on BNB Chain. A route may not be found.</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        <button className="btn btn-primary" disabled={!canReview || quoting} onClick={review}>{quoting ? 'Finding best route…' : 'Review swap'}</button>
        <p className="disclosure">Routed through the KyberSwap aggregator across BNB Chain liquidity. You need a little BNB for network fees.</p>

        {picking && (
          <TokenPicker
            title={picking === 'from' ? 'You pay' : 'You receive'}
            assets={ASSETS}
            exclude={picking === 'from' ? to.address : from.address}
            onClose={() => setPicking(null)}
            onPick={(a) => { if (picking === 'from') { setFrom(a); setAmount(''); } else setTo(a); setPicking(null); }}
          />
        )}
      </div>
    );
  }

  if (step === 'review' && quote) {
    const highImpact = quote.priceImpact !== null && quote.priceImpact > 0.03;
    return (
      <div className="screen stack">
        <h2 className="wordmark page-title">Review</h2>
        <div className="card certificate-border">
          <LineItem label="You pay" value={fmt(quote.amountIn, from)} />
          <LineItem label="Platform fee (0.5%)" value={fmt(quote.platformFee, to)} />
          <LineItem label="You receive (est.)" value={fmt(quote.amountOutNet, to)} strong />
          <LineItem label={`Minimum received (${slippageBps / 100}% slippage)`} value={fmt(quote.minOutNet, to)} />
          <LineItem label="Price impact (est.)" value={quote.priceImpact === null ? '—' : <span style={{ color: highImpact ? 'var(--down)' : undefined }}>{(quote.priceImpact * 100).toFixed(2)}%</span>} />
          <LineItem label="Network fee (est.)" value={quote.gasUsd ? formatUsd(quote.gasUsd) : 'Shown in Nimiq Pay'} />
          <LineItem label="Route" value={<span className="sub">KyberSwap · {quote.sources.slice(0, 3).join(', ')}</span>} />
        </div>
        {highImpact && <Notice tone="error">High price impact: liquidity is thin for this trade size. Consider a smaller amount.</Notice>}
        <Notice>Two confirmations in Nimiq Pay: approve exactly {fmt(quote.amountIn, from)}, then swap. If you've already approved enough, the first step is skipped.</Notice>
        <div className="btn-row">
          <button className="btn btn-secondary" onClick={() => setStep('enter')}>Edit</button>
          <button className="btn btn-primary" onClick={execute}>Confirm</button>
        </div>
      </div>
    );
  }

  if (step === 'confirm' && quote) {
    return (
      <div className="screen stack">
        <h2 className="wordmark page-title">Confirm</h2>
        <StepList steps={[
          { label: `Approve ${from.symbol}`, state: approveState },
          { label: `Swap to ${to.symbol}`, state: swapState },
        ]} />
        {approveHash && <LineItem label="Approval" value={<TxLink hash={approveHash} />} />}
        {swapHash && <LineItem label="Swap" value={<TxLink hash={swapHash} />} />}
        {error && (
          <>
            <Notice tone="error">{error}</Notice>
            <div className="btn-row">
              <button className="btn btn-secondary" onClick={() => { setStep('enter'); setError(null); setApproveState('pending'); setSwapState('pending'); }}>Start over</button>
              <button className="btn btn-primary" onClick={() => { setQuote(null); setStep('enter'); review(); }}>New quote</button>
            </div>
          </>
        )}
      </div>
    );
  }

  if (step === 'success' && quote && swapHash) {
    return (
      <div className="screen stack" style={{ gap: 16, textAlign: 'center' }}>
        <div className="card certificate-border" style={{ padding: '26px 18px' }}>
          <span className="stamp">Settled</span>
          <div className="label" style={{ marginTop: 18 }}>You received</div>
          <div className="value-serif" style={{ fontSize: 30, margin: '6px 0 16px' }}>{fmt(received ?? quote.amountOutNet, to)}</div>
          <div style={{ textAlign: 'left' }}>
            <LineItem label="You paid" value={fmt(quote.amountIn, from)} />
            <LineItem label="Platform fee" value={fmt(quote.platformFee, to)} />
            <LineItem label="Network" value="BNB Chain" />
            <LineItem label="Transaction" value={<TxLink hash={swapHash} />} />
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/portfolio')}>View portfolio</button>
        <button className="btn btn-secondary" onClick={() => navigate(`/asset/${to.address}`)}>View {to.symbol}</button>
      </div>
    );
  }

  return null;
}
