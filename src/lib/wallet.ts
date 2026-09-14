import { createWalletClient, custom, type Address, type EIP1193Provider } from 'viem';
import { CHAIN, RPC_URLS } from '../config/chain';

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
    const chainId = `0x${CHAIN.id.toString(16)}`;
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code === 4001) throw new Error(`Qorbit runs on ${CHAIN.name}. Approve the network switch in Nimiq Pay to continue.`);
      // 4902 = chain not configured in the wallet yet; Nimiq Pay supports adding it.
      if (code !== 4902) throw new Error(`Please switch Nimiq Pay to ${CHAIN.name} to continue.`);
      try {
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId,
            chainName: CHAIN.name,
            rpcUrls: RPC_URLS,
            nativeCurrency: CHAIN.nativeCurrency,
            blockExplorerUrls: [CHAIN.blockExplorers.default.url],
          }],
        });
      } catch {
        throw new Error(`Couldn't add ${CHAIN.name} to Nimiq Pay. Add it in Nimiq Pay's network settings and try again.`);
      }
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
