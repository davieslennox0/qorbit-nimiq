import { bsc } from 'viem/chains';

export const CHAIN = bsc;

export const RPC_URLS = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed1.binance.org', 'https://bsc.drpc.org'];

export const EXPLORER_TX = (hash: string) => `${CHAIN.blockExplorers.default.url}/tx/${hash}`;
export const EXPLORER_ADDRESS = (address: string) => `${CHAIN.blockExplorers.default.url}/address/${address}`;
