/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FEE_RECIPIENT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
