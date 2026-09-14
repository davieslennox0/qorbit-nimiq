import { decodeFunctionData, isAddressEqual, type Address, type Hex } from 'viem';
import { CHAIN } from '../config/chain';
import { minOutFor, NoRouteError, valuation, type QuoteRequest, type SwapQuote, type SwapTx } from './swapTypes';

const API = 'https://li.quest/v1';

/** LI.FI Diamond on BNB Chain; swaps are dispatched to its GenericSwapFacetV3 (ABI verified via Sourcify). */
export const LIFI_DIAMOND: Address = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
/** Only Bitget liquidity: it's the route that fills Ondo stocks at market prices on BNB Chain. */
const ALLOWED_EXCHANGE = 'bitget';

/**
 * Qorbit's 0.5% fee on this route needs an integrator registered at portal.li.fi with a fee wallet.
 * Until that is configured the route charges no Qorbit fee (LI.FI's own 0.25% still applies).
 */
const FEE_INTEGRATOR = import.meta.env.VITE_LIFI_FEE_INTEGRATOR as string | undefined;
const INTEGRATOR = FEE_INTEGRATOR || 'qorbit';
const PLATFORM_FEE = '0.005';

const SWAP_DATA = {
  type: 'tuple', components: [
    { name: 'callTo', type: 'address' }, { name: 'approveTo', type: 'address' },
    { name: 'sendingAssetId', type: 'address' }, { name: 'receivingAssetId', type: 'address' },
    { name: 'fromAmount', type: 'uint256' }, { name: 'callData', type: 'bytes' }, { name: 'requiresDeposit', type: 'bool' },
  ],
} as const;
const COMMON_INPUTS = [
  { name: '_transactionId', type: 'bytes32' }, { name: '_integrator', type: 'string' }, { name: '_referrer', type: 'string' },
  { name: '_receiver', type: 'address' }, { name: '_minAmountOut', type: 'uint256' },
] as const;
const FACET_ABI = [
  { type: 'function', name: 'swapTokensMultipleV3ERC20ToERC20', stateMutability: 'nonpayable', inputs: [...COMMON_INPUTS, { ...SWAP_DATA, name: '_swapData', type: 'tuple[]' }], outputs: [] },
  { type: 'function', name: 'swapTokensSingleV3ERC20ToERC20', stateMutability: 'nonpayable', inputs: [...COMMON_INPUTS, { ...SWAP_DATA, name: '_swapData' }], outputs: [] },
] as const;

type LifiStep = { type: string; tool: string };
type LifiCost = { name: string; amount: string; amountUSD: string; token?: { address: string } };
type LifiQuote = {
  tool: string;
  includedSteps: LifiStep[];
  estimate: { toAmount: string; approvalAddress: string; feeCosts?: LifiCost[]; gasCosts?: { amountUSD: string }[] };
  transactionRequest: { to: string; data: Hex; value: string; chainId: number };
};

export async function getLifiQuote(req: QuoteRequest): Promise<SwapQuote> {
  const qs = new URLSearchParams({
    fromChain: String(CHAIN.id), toChain: String(CHAIN.id),
    fromToken: req.tokenIn, toToken: req.tokenOut, fromAmount: req.amountIn.toString(),
    fromAddress: req.user, toAddress: req.user,
    slippage: String(req.slippageBps / 10_000),
    allowExchanges: ALLOWED_EXCHANGE,
    integrator: INTEGRATOR,
    ...(FEE_INTEGRATOR ? { fee: PLATFORM_FEE } : {}),
  });
  const res = await fetch(`${API}/quote?${qs}`);
  const d = (await res.json().catch(() => null)) as (LifiQuote & { message?: string }) | null;
  if (res.status === 429) throw new Error('Bitget route is rate-limited right now.');
  if (!res.ok || !d?.transactionRequest) {
    if (res.status === 404 || /no available quotes|no route/i.test(d?.message ?? '')) throw new NoRouteError('No Bitget route for this pair right now.');
    throw new Error(d?.message ? `Bitget quote failed: ${d.message}` : `Bitget quote failed (${res.status}).`);
  }

  const swapTools = d.includedSteps.filter((s) => s.type === 'swap').map((s) => s.tool);
  if (!swapTools.length || swapTools.some((t) => t !== ALLOWED_EXCHANGE)) throw new NoRouteError('No Bitget route for this pair right now.');
  if (d.transactionRequest.chainId !== CHAIN.id || !isAddressEqual(d.transactionRequest.to as Address, LIFI_DIAMOND) || !isAddressEqual(d.estimate.approvalAddress as Address, LIFI_DIAMOND)) {
    throw new Error('Unexpected contract in Bitget route — refusing to continue.');
  }
  if (BigInt(d.transactionRequest.value || '0') !== 0n) throw new Error('Unexpected native value in Bitget route — refusing to continue.');

  const amountOutNet = BigInt(d.estimate.toAmount);
  if (amountOutNet === 0n) throw new NoRouteError('No Bitget route for this pair right now.');
  const costs = d.estimate.feeCosts ?? [];
  const integratorFee = costs.find((c) => /integrator/i.test(c.name));
  const routeFeeUsd = costs.filter((c) => /lifi/i.test(c.name)).reduce((sum, c) => sum + Number(c.amountUSD || 0), 0);

  return {
    ...req,
    provider: 'lifi',
    routeLabel: 'Bitget via LI.FI',
    spender: LIFI_DIAMOND,
    amountOutNet,
    minOutNet: minOutFor(amountOutNet, req.slippageBps),
    platformFee: FEE_INTEGRATOR && integratorFee ? BigInt(integratorFee.amount) : 0n,
    platformFeeSide: FEE_INTEGRATOR && integratorFee ? 'in' : 'none',
    routeFeeUsd: routeFeeUsd || null,
    ...valuation(req, amountOutNet),
    gasUsd: (d.estimate.gasCosts ?? []).reduce((sum, g) => sum + Number(g.amountUSD || 0), 0) || null,
    fetchedAt: Date.now(),
    raw: d,
  };
}

/**
 * Decodes the LI.FI transaction and checks it against what the user reviewed before anything
 * is signed: contract, receiver, input token and amount, output token and on-chain minimum.
 * The Diamond itself only calls DEX contracts on LI.FI's on-chain allowlist.
 */
export function verifyLifiTx(q: SwapQuote, reviewedMinOut: bigint): SwapTx {
  const tx = (q.raw as LifiQuote).transactionRequest;
  if (!isAddressEqual(tx.to as Address, LIFI_DIAMOND)) throw new Error('Unexpected contract — refusing to sign.');

  let decoded;
  try {
    decoded = decodeFunctionData({ abi: FACET_ABI, data: tx.data });
  } catch {
    throw new Error('Unrecognised Bitget route transaction — nothing was signed.');
  }
  const [, integrator, , receiver, minAmountOut, swapData] = decoded.args;
  const steps = Array.isArray(swapData) ? swapData : [swapData];
  const first = steps[0];
  const last = steps[steps.length - 1];

  const checks: [boolean, string][] = [
    [isAddressEqual(receiver, q.user), 'recipient'],
    [integrator === INTEGRATOR, 'integrator'],
    [!!first && isAddressEqual(first.sendingAssetId, q.tokenIn), 'input token'],
    [!!first && first.fromAmount === q.amountIn, 'input amount'],
    [!!last && isAddressEqual(last.receivingAssetId, q.tokenOut), 'output token'],
    [minAmountOut >= reviewedMinOut, 'minimum received'],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, what]) => what);
  if (failed.includes('minimum received') && failed.length === 1) throw new Error('The price moved since you reviewed. Get a new quote to continue.');
  if (failed.length) throw new Error(`Swap safety check failed (${failed.join(', ')}) — nothing was signed.`);

  return { to: LIFI_DIAMOND, data: tx.data };
}
