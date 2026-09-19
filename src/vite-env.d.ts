/* Minimal Vite client shim so `vite dev` typechecks without extra deps. */
interface ImportMetaEnv {
  readonly DEV: boolean;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
