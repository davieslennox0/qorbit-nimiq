/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FEE_RECIPIENT?: string;
  /** LI.FI integrator name registered at portal.li.fi with a fee wallet; enables the 0.5% fee on Bitget routes */
  readonly VITE_LIFI_FEE_INTEGRATOR?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
