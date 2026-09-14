import { bsc } from 'viem/chains';

export const CHAIN = bsc;

// Ordered by what works from a browser: receipts + large multicalls + CORS. PublicNode is last because it refuses receipt lookups without a token.
export const RPC_URLS = ['https://bsc-dataseed2.defibit.io', 'https://bsc-dataseed1.binance.org', 'https://1rpc.io/bnb', 'https://bsc-rpc.publicnode.com'];

export const EXPLORER_TX = (hash: string) => `${CHAIN.blockExplorers.default.url}/tx/${hash}`;
export const EXPLORER_ADDRESS = (address: string) => `${CHAIN.blockExplorers.default.url}/address/${address}`;
