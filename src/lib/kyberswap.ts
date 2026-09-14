import { decodeFunctionData, isAddressEqual, type Address, type Hex } from 'viem';
import { CHAIN } from '../config/chain';
import { minOutFor, NoRouteError, PLATFORM_FEE_BPS, valuation, type QuoteRequest, type SwapQuote, type SwapTx } from './swapTypes';

const API = `https://aggregator-api.kyberswap.com/${CHAIN.id === 56 ? 'bsc' : 'unsupported'}/api/v1`;
const CLIENT_ID = 'qorbit';

/** KyberSwap MetaAggregationRouterV2 on BNB Chain — ABI verified via Sourcify. */
export const KYBER_ROUTER: Address = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';

const SWAP_DESC = {
  type: 'tuple', name: 'desc', components: [
    { name: 'srcToken', type: 'address' }, { name: 'dstToken', type: 'address' },
    { name: 'srcReceivers', type: 'address[]' }, { name: 'srcAmounts', type: 'uint256[]' },
    { name: 'feeReceivers', type: 'address[]' }, { name: 'feeAmounts', type: 'uint256[]' },
    { name: 'dstReceiver', type: 'address' }, { name: 'amount', type: 'uint256' },
    { name: 'minReturnAmount', type: 'uint256' }, { name: 'flags', type: 'uint256' }, { name: 'permit', type: 'bytes' },
  ],
} as const;

const EXECUTION = {
  type: 'tuple', name: 'execution', components: [
    { name: 'callTarget', type: 'address' }, { name: 'approveTarget', type: 'address' }, { name: 'targetData', type: 'bytes' },
    SWAP_DESC, { name: 'clientData', type: 'bytes' },
  ],
} as const;

const ROUTER_ABI = [
  { type: 'function', name: 'swap', stateMutability: 'payable', inputs: [EXECUTION], outputs: [{ name: 'returnAmount', type: 'uint256' }, { name: 'gasUsed', type: 'uint256' }] },
  { type: 'function', name: 'swapGeneric', stateMutability: 'payable', inputs: [EXECUTION], outputs: [{ name: 'returnAmount', type: 'uint256' }, { name: 'gasUsed', type: 'uint256' }] },
  {
    type: 'function', name: 'swapSimpleMode', stateMutability: 'nonpayable',
    inputs: [{ name: 'caller', type: 'address' }, SWAP_DESC, { name: 'executorData', type: 'bytes' }, { name: 'clientData', type: 'bytes' }],
    outputs: [{ name: 'returnAmount', type: 'uint256' }, { name: 'gasUsed', type: 'uint256' }],
  },
] as const;

type RouteSummary = { amountOut: string; gasUsd: string; route: { exchange: string }[][]; [k: string]: unknown };

async function kyber<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { 'x-client-id': CLIENT_ID, ...(init?.body ? { 'content-type': 'application/json' } : {}) } });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.data) {
    const msg = json?.message as string | undefined;
    if (res.status === 429) throw new Error('The swap router is busy. Try again in a few seconds.');
    if (msg && /route not found|no route/i.test(msg)) throw new NoRouteError('No liquidity route exists for this pair right now.');
    throw new Error(msg ? `Quote failed: ${msg}` : `Quote failed (${res.status}).`);
  }
  return json.data as T;
}

export async function getKyberQuote(req: QuoteRequest): Promise<SwapQuote> {
  const qs = new URLSearchParams({
    tokenIn: req.tokenIn, tokenOut: req.tokenOut, amountIn: req.amountIn.toString(),
    feeAmount: PLATFORM_FEE_BPS.toString(), chargeFeeBy: 'currency_out', isInBps: 'true', feeReceiver: req.feeRecipient, origin: req.user,
  });
  const data = await kyber<{ routeSummary: RouteSummary; routerAddress: string }>(`/routes?${qs}`);
  if (!isAddressEqual(data.routerAddress as Address, KYBER_ROUTER)) throw new Error('Unexpected router address from quote API — refusing to continue.');

  const s = data.routeSummary;
  const amountOutNet = BigInt(s.amountOut);
  if (amountOutNet === 0n) throw new NoRouteError('No liquidity route exists for this pair right now.');
  const gross = (amountOutNet * 10_000n) / (10_000n - PLATFORM_FEE_BPS);

  return {
    ...req,
    provider: 'kyber',
    routeLabel: `KyberSwap · ${[...new Set(s.route.flat().map((h) => h.exchange))].slice(0, 3).join(', ')}`,
    spender: KYBER_ROUTER,
    amountOutNet,
    minOutNet: minOutFor(amountOutNet, req.slippageBps),
    platformFee: gross - amountOutNet,
    platformFeeSide: 'out',
    routeFeeUsd: null,
    ...valuation(req, amountOutNet),
    gasUsd: Number(s.gasUsd) || null,
    fetchedAt: Date.now(),
    raw: s,
  };
}

/**
 * Builds router calldata and checks it against what the user reviewed before
 * anything is signed: router, tokens, input amount, recipient, fee, and the
 * on-chain minimum output. The API is never trusted blindly with user funds.
 */
export async function buildKyberTx(q: SwapQuote, reviewedMinOut: bigint): Promise<SwapTx> {
  const built = await kyber<{ routerAddress: string; data: Hex; transactionValue: string }>('/route/build', {
    method: 'POST',
    body: JSON.stringify({
      routeSummary: q.raw, sender: q.user, recipient: q.user, origin: q.user,
      slippageTolerance: q.slippageBps, deadline: Math.floor(Date.now() / 1000) + 20 * 60, source: CLIENT_ID,
    }),
  });

  if (!isAddressEqual(built.routerAddress as Address, KYBER_ROUTER)) throw new Error('Unexpected router address — refusing to sign.');
  if (BigInt(built.transactionValue || '0') !== 0n) throw new Error('Unexpected native value in swap — refusing to sign.');

  const decoded = decodeFunctionData({ abi: ROUTER_ABI, data: built.data });
  const desc = decoded.functionName === 'swapSimpleMode' ? decoded.args[1] : decoded.args[0].desc;
  const checks: [boolean, string][] = [
    [isAddressEqual(desc.srcToken, q.tokenIn), 'input token'],
    [isAddressEqual(desc.dstToken, q.tokenOut), 'output token'],
    [desc.amount === q.amountIn, 'input amount'],
    [isAddressEqual(desc.dstReceiver, q.user), 'recipient'],
    [desc.feeReceivers.length === 1 && isAddressEqual(desc.feeReceivers[0], q.feeRecipient), 'fee recipient'],
    [desc.feeAmounts.length === 1 && desc.feeAmounts[0] === PLATFORM_FEE_BPS, 'fee amount'],
    [desc.minReturnAmount >= reviewedMinOut, 'minimum received'],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, what]) => what);
  if (failed.includes('minimum received') && failed.length === 1) throw new Error('The price moved since you reviewed. Get a new quote to continue.');
  if (failed.length) throw new Error(`Swap safety check failed (${failed.join(', ')}) — nothing was signed.`);

  return { to: KYBER_ROUTER, data: built.data };
}
