import { decodeFunctionData, getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type Hex } from 'viem';
import { CHAIN } from '../config/chain';

const API = `https://aggregator-api.kyberswap.com/${CHAIN.id === 56 ? 'bsc' : 'unsupported'}/api/v1`;
const CLIENT_ID = 'qorbitpay';

/** KyberSwap MetaAggregationRouterV2 on BNB Chain — ABI verified via Sourcify. */
export const KYBER_ROUTER: Address = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
export const PLATFORM_FEE_BPS = 50n;

export function getFeeRecipient(): Address | null {
  const v = import.meta.env.VITE_FEE_RECIPIENT;
  return v && isAddress(v) && v !== zeroAddress ? getAddress(v) : null;
}

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

type RouteSummary = {
  tokenIn: string; amountIn: string; amountInUsd: string;
  tokenOut: string; amountOut: string; amountOutUsd: string;
  gasUsd: string; route: { exchange: string }[][];
  [k: string]: unknown;
};

export type SwapQuote = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** What the user receives, after the platform fee */
  amountOutNet: bigint;
  platformFee: bigint;
  minOutNet: bigint;
  slippageBps: number;
  /** Estimated fraction lost to price impact and pool fees, excluding the platform fee */
  priceImpact: number | null;
  gasUsd: number | null;
  sources: string[];
  summary: RouteSummary;
  fetchedAt: number;
};

async function kyber<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { 'x-client-id': CLIENT_ID, ...(init?.body ? { 'content-type': 'application/json' } : {}) } });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.data) {
    const msg = json?.message as string | undefined;
    if (res.status === 429) throw new Error('The swap router is busy. Try again in a few seconds.');
    if (msg && /route not found|no route/i.test(msg)) throw new Error('No liquidity route exists for this pair right now.');
    throw new Error(msg ? `Quote failed: ${msg}` : `Quote failed (${res.status}).`);
  }
  return json.data as T;
}

export async function getQuote(p: { tokenIn: Address; tokenOut: Address; amountIn: bigint; slippageBps: number; user: Address; feeRecipient: Address }): Promise<SwapQuote> {
  const qs = new URLSearchParams({
    tokenIn: p.tokenIn, tokenOut: p.tokenOut, amountIn: p.amountIn.toString(),
    feeAmount: PLATFORM_FEE_BPS.toString(), chargeFeeBy: 'currency_out', isInBps: 'true', feeReceiver: p.feeRecipient, origin: p.user,
  });
  const data = await kyber<{ routeSummary: RouteSummary; routerAddress: string }>(`/routes?${qs}`);
  if (!isAddressEqual(data.routerAddress as Address, KYBER_ROUTER)) throw new Error('Unexpected router address from quote API — refusing to continue.');

  const s = data.routeSummary;
  const amountOutNet = BigInt(s.amountOut);
  if (amountOutNet === 0n) throw new Error('No liquidity route exists for this pair right now.');
  const gross = (amountOutNet * 10_000n) / (10_000n - PLATFORM_FEE_BPS);
  const inUsd = Number(s.amountInUsd), outUsd = Number(s.amountOutUsd);
  const priceImpact = inUsd > 0 && outUsd > 0 ? Math.max(0, 1 - outUsd / (1 - Number(PLATFORM_FEE_BPS) / 10_000) / inUsd) : null;

  return {
    tokenIn: p.tokenIn, tokenOut: p.tokenOut, amountIn: p.amountIn,
    amountOutNet, platformFee: gross - amountOutNet,
    minOutNet: (amountOutNet * BigInt(10_000 - p.slippageBps)) / 10_000n,
    slippageBps: p.slippageBps, priceImpact,
    gasUsd: Number(s.gasUsd) || null,
    sources: [...new Set(s.route.flat().map((h) => h.exchange))],
    summary: s, fetchedAt: Date.now(),
  };
}

/**
 * Builds router calldata and checks it against what the user reviewed before
 * anything is signed: router, tokens, input amount, recipient, fee, and the
 * on-chain minimum output. The API is never trusted blindly with user funds.
 */
export async function buildSwapTx(q: SwapQuote, user: Address, feeRecipient: Address, reviewedMinOut: bigint): Promise<{ to: Address; data: Hex }> {
  const built = await kyber<{ routerAddress: string; data: Hex; transactionValue: string; amountOut: string }>('/route/build', {
    method: 'POST',
    body: JSON.stringify({
      routeSummary: q.summary, sender: user, recipient: user, origin: user,
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
    [isAddressEqual(desc.dstReceiver, user), 'recipient'],
    [desc.feeReceivers.length === 1 && isAddressEqual(desc.feeReceivers[0], feeRecipient), 'fee recipient'],
    [desc.feeAmounts.length === 1 && desc.feeAmounts[0] === PLATFORM_FEE_BPS, 'fee amount'],
    [desc.minReturnAmount >= reviewedMinOut, 'minimum received'],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, what]) => what);
  if (failed.includes('minimum received') && failed.length === 1) throw new Error('The price moved since you reviewed. Get a new quote to continue.');
  if (failed.length) throw new Error(`Swap safety check failed (${failed.join(', ')}) — nothing was signed.`);

  return { to: KYBER_ROUTER, data: built.data };
}
