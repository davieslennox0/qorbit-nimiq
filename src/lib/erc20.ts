import { createPublicClient, fallback, http, type Address } from 'viem';
import { CHAIN, RPC_URLS } from '../config/chain';

export const publicClient = createPublicClient({
  chain: CHAIN,
  transport: fallback(RPC_URLS.map((url) => http(url, { timeout: 20_000 }))),
});

export const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

export function readBalance(token: Address, owner: Address): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });
}

export function readAllowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] });
}

/** Reads many balances in chunked multicalls; failed reads come back as 0. */
export async function readBalances(tokens: Address[], owner: Address, chunk = 400): Promise<bigint[]> {
  const out: bigint[] = [];
  for (let i = 0; i < tokens.length; i += chunk) {
    const res = await publicClient.multicall({
      allowFailure: true,
      contracts: tokens.slice(i, i + chunk).map((address) => ({ address, abi: ERC20_ABI, functionName: 'balanceOf' as const, args: [owner] as const })),
    });
    out.push(...res.map((r) => (r.status === 'success' ? (r.result as bigint) : 0n)));
  }
  return out;
}
