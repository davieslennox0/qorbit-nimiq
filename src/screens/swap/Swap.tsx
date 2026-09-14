import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { formatUnits, parseEventLogs, parseUnits, type Address } from 'viem';
import { findToken, STABLES, TOKENS, USDT, type Asset } from '../../config/tokens';
import { useWallet } from '../../hooks/WalletContext';
import { ERC20_ABI, publicClient, readAllowance, readBalance } from '../../lib/erc20';
import { buildSwapTx, freshQuoteForExecution, getBestQuote } from '../../lib/routing';
import { assertFairPrice, getFeeRecipient, MAX_VALUE_LOSS, WARN_VALUE_LOSS, type SwapQuote } from '../../lib/swapTypes';
import { cachedQuotes, fetchQuotes } from '../../lib/prices';
import { getWalletClient } from '../../lib/wallet';
import { formatQty, formatUsd } from '../../lib/format';
import { LineItem, StepList, TxLink } from '../../components/Receipt';
import { Notice, TokenGlyph } from '../../components/Chrome';
import { TokenPicker } from '../../components/TokenPicker';

type Step = 'enter' | 'review' | 'confirm' | 'success';
type StepState = 'pending' | 'active' | 'done' | 'skipped';

const ASSETS: Asset[] = [...STABLES, ...TOKENS];
const SLIPPAGE_OPTIONS = [50, 100, 300];
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
      // Reference market prices come from CoinGecko, independent of the swap router.
      const refIds = [from.coingeckoId, to.coingeckoId].filter((x): x is string => !!x);
      const refs = await fetchQuotes(refIds).catch(() => cachedQuotes(refIds));
      const refUsd = (a: Asset) => (a.coingeckoId ? refs[a.coingeckoId]?.usd ?? null : null);
      setQuote(await getBestQuote({
        tokenIn: from.address, tokenOut: to.address, amountIn, slippageBps, user: evmAddress, feeRecipient,
        decimalsIn: from.decimals, decimalsOut: to.decimals, refUsdIn: refUsd(from), refUsdOut: refUsd(to),
      }));
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
      assertFairPrice(quote, to.symbol);
      // Always check against this route's contract: a new quote may use a different route than a previous attempt.
      const allowance = await readAllowance(quote.tokenIn, evmAddress, quote.spender);
      if (allowance >= quote.amountIn) {
        setApproveState((st) => (st === 'done' ? st : 'skipped'));
      } else {
        setApproveState('active');
        // Exact-amount approval, so no open-ended allowance is left on the router.
        const hash = await wallet.writeContract({ address: quote.tokenIn, abi: ERC20_ABI, functionName: 'approve', args: [quote.spender, quote.amountIn] });
        setApproveHash(hash);
        const r = await publicClient.waitForTransactionReceipt({ hash });
        if (r.status !== 'success') throw new Error('Approval reverted. Nothing was swapped.');
        setApproveState('done');
      }

      setSwapState('active');
      // Re-quote on the same route if needed, never letting the on-chain minimum drop below what the user reviewed.
      const exec = await freshQuoteForExecution(quote);
      assertFairPrice(exec, to.symbol);
      const tx = await buildSwapTx(exec, reviewedMin);
      await simulateWithRetry(evmAddress, tx.to, tx.data);
      const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data });
      setSwapHash(hash);
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error('Swap reverted. No funds were exchanged.');
      const credits = parseEventLogs({ abi: TRANSFER_EVENT, logs: r.logs, eventName: 'Transfer' })
        .filter((l) => l.address.toLowerCase() === quote.tokenOut.toLowerCase() && l.args.to.toLowerCase() === evmAddress.toLowerCase())
        .map((l) => l.args.value)
        .sort((a, b) => (a < b ? -1 : 1));
      // KyberSwap pays the fee in the output token: if this wallet is also the fee recipient, the smaller credit is the fee.
      if (quote.provider === 'kyber' && credits.length > 1 && feeRecipient.toLowerCase() === evmAddress.toLowerCase()) credits.shift();
      setReceived(credits.reduce((sum, v) => sum + v, 0n));
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
      <TokenGlyph symbol={asset.symbol} logo={asset.logo} size={26} />
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
        <p className="disclosure">Routed through Bitget liquidity via LI.FI first, with the KyberSwap aggregator as a fallback. Every quote is checked against market prices. You need a little BNB for network fees.</p>

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
    const unverified = quote.valueLoss === null;
    const blocked = unverified || quote.valueLoss! > MAX_VALUE_LOSS;
    const warn = !blocked && quote.valueLoss! > WARN_VALUE_LOSS;
    const lossColor = blocked ? 'var(--down)' : warn ? 'var(--gold)' : undefined;
    return (
      <div className="screen stack">
        <h2 className="wordmark page-title">Review</h2>
        <div className="card certificate-border">
          <LineItem label="You pay" value={fmt(quote.amountIn, from)} />
          <LineItem label="Platform fee (0.5%)" value={quote.platformFeeSide === 'none' ? 'Not charged on this route' : fmt(quote.platformFee, quote.platformFeeSide === 'in' ? from : to)} />
          {quote.routeFeeUsd !== null && <LineItem label="Route fee (LI.FI)" value={formatUsd(quote.routeFeeUsd)} />}
          <LineItem label="You receive (est.)" value={fmt(quote.amountOutNet, to)} strong />
          <LineItem label={`Minimum received (${slippageBps / 100}% slippage)`} value={fmt(quote.minOutNet, to)} />
          <LineItem label="Market value paid" value={quote.inUsd === null ? '—' : formatUsd(quote.inUsd)} />
          <LineItem label="Market value received" value={quote.outUsd === null ? '—' : <span style={{ color: lossColor }}>{formatUsd(quote.outUsd)}</span>} />
          <LineItem label="Cost vs. market (all fees)" value={quote.valueLoss === null ? 'Unverified' : <span style={{ color: lossColor }}>{(quote.valueLoss * 100).toFixed(2)}%</span>} />
          <LineItem label="Network fee (est.)" value={quote.gasUsd ? formatUsd(quote.gasUsd) : 'Shown in Nimiq Pay'} />
          <LineItem label="Route" value={<span className="sub">{quote.routeLabel}</span>} />
        </div>
        {blocked && (
          <Notice tone="error">
            {unverified
              ? `Qorbit can't verify a fair market price for ${to.symbol} right now, so this swap is blocked to protect your funds.`
              : `Blocked: you'd lose about ${(quote.valueLoss! * 100).toFixed(1)}% versus the market price. Liquidity for ${to.symbol} is too thin for this trade. Try a smaller amount or a different stock.`}
          </Notice>
        )}
        {quote.fallbackNote && <Notice>{quote.fallbackNote}{blocked ? ' Try again in a little while.' : ''}</Notice>}
        {warn && <Notice tone="error">Heads up: this trade costs {(quote.valueLoss! * 100).toFixed(1)}% versus the market price, mostly from thin liquidity. A smaller amount may get a better price.</Notice>}
        {!blocked && <Notice>Two confirmations in Nimiq Pay: approve exactly {fmt(quote.amountIn, from)}, then swap. If you've already approved enough, the first step is skipped.</Notice>}
        <div className="btn-row">
          <button className="btn btn-secondary" onClick={() => setStep('enter')}>Edit</button>
          {!blocked && <button className="btn btn-primary" onClick={execute}>Confirm</button>}
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
            {quote.platformFeeSide !== 'none' && <LineItem label="Platform fee" value={fmt(quote.platformFee, quote.platformFeeSide === 'in' ? from : to)} />}
            <LineItem label="Route" value={quote.routeLabel} />
            <LineItem label="Network" value="BNB Chain" />
            <LineItem label="Transaction" value={<TxLink hash={swapHash} />} />
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/portfolio')}>View portfolio</button>
        {findToken(to.address) && <button className="btn btn-secondary" onClick={() => navigate(`/asset/${to.address}`)}>View {to.symbol}</button>}
      </div>
    );
  }

  return null;
}
