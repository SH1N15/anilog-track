/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ANILOG_EDITION?: 'standard' | 'original';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
