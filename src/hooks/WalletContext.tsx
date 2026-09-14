import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { Address } from 'viem';
import { connectEvmWallet } from '../lib/wallet';
import { connectNimiqAccount } from '../lib/nimiqSdk';

type WalletState = {
  evmAddress: Address | null;
  nimiqAddress: string | null;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
};

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [evmAddress, setEvmAddress] = useState<Address | null>(null);
  const [nimiqAddress, setNimiqAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const evm = await connectEvmWallet();
      setEvmAddress(evm);
      // NIM account is only needed for the optional tip feature; don't block app load on it.
      connectNimiqAccount()
        .then(setNimiqAddress)
        .catch(() => setNimiqAddress(null));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect wallet.');
    } finally {
      setConnecting(false);
    }
  }, []);

  return (
    <WalletContext.Provider value={{ evmAddress, nimiqAddress, connecting, error, connect }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
