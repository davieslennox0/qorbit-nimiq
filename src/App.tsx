import type { ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { WalletProvider, useWallet } from './hooks/WalletContext';
import { TabBar, TopBar } from './components/Chrome';
import Connect from './screens/Connect';
import Portfolio from './screens/Portfolio';
import Market from './screens/Market';
import AssetDetail from './screens/AssetDetail';
import Swap from './screens/swap/Swap';
import Send from './screens/send/Send';

function Authed({ children, back }: { children: ReactNode; back?: boolean }) {
  const { evmAddress } = useWallet();
  if (!evmAddress) return <Navigate to="/" replace />;
  return (
    <>
      <TopBar back={back} />
      {children}
      <TabBar />
    </>
  );
}

export default function App() {
  return (
    <WalletProvider>
      {/* Hash routing: works from any static host / WebView origin with no server rewrites. */}
      <HashRouter>
        <div className="app-shell">
          <Routes>
            <Route path="/" element={<Connect />} />
            <Route path="/portfolio" element={<Authed><Portfolio /></Authed>} />
            <Route path="/market" element={<Authed><Market /></Authed>} />
            <Route path="/asset/:address" element={<Authed back><AssetDetail /></Authed>} />
            <Route path="/swap" element={<Authed><Swap /></Authed>} />
            <Route path="/send" element={<Authed><Send /></Authed>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </HashRouter>
    </WalletProvider>
  );
}
