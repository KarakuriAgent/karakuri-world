/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SNAPSHOT_URL: string;
  readonly VITE_AUTH_MODE: 'public' | 'access';
  readonly VITE_PHASE3_EFFECTS_ENABLED?: 'true' | 'false';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
