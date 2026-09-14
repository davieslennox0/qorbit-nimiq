import { createWalletClient, custom, type Address, type EIP1193Provider } from 'viem';
import { CHAIN } from '../config/chain';

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export function getInjectedProvider(): EIP1193Provider | undefined {
  return window.ethereum;
}

export function isNimiqPayEvmAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.ethereum;
}

/**
 * Requests EVM account access from Nimiq Pay's injected provider and makes
 * sure we're talking to BNB Chain before any read/write happens.
 */
export async function connectEvmWallet(): Promise<Address> {
  const provider = getInjectedProvider();
  if (!provider) {
    throw new Error('No EVM provider injected — this app must run inside Nimiq Pay.');
  }

  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as Address[];
  if (!accounts?.[0]) throw new Error('Wallet connection was rejected.');

  const chainIdHex = (await provider.request({ method: 'eth_chainId' })) as string;
  if (parseInt(chainIdHex, 16) !== CHAIN.id) {
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${CHAIN.id.toString(16)}` }],
      });
    } catch {
      throw new Error(`Please switch Nimiq Pay to ${CHAIN.name} to continue.`);
    }
  }

  return accounts[0];
}

export function getWalletClient(account: Address) {
  const provider = getInjectedProvider();
  if (!provider) throw new Error('No EVM provider injected.');
  return createWalletClient({
    account,
    chain: CHAIN,
    transport: custom(provider),
  });
}
