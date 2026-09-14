import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { Address } from 'viem';
import { connectEvmWallet } from '../lib/wallet';

type WalletState = {
  evmAddress: Address | null;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
};

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [evmAddress, setEvmAddress] = useState<Address | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The Nimiq account is deliberately not requested here: listAccounts shows a confirmation
  // dialog, and only the optional NIM tip needs it (sendBasicTransaction prompts on its own).
  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      setEvmAddress(await connectEvmWallet());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect wallet.');
    } finally {
      setConnecting(false);
    }
  }, []);

  return (
    <WalletContext.Provider value={{ evmAddress, connecting, error, connect }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
