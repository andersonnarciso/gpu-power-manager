/**
 * Development-server compatibility shim.
 *
 * `@vitejs/plugin-react` injects an **inline** `<script>` preamble that defines
 * `window.$RefreshReg$` and `window.$RefreshSig$`. This application ships a
 * strict Content Security Policy (`script-src 'self'`), which blocks inline
 * scripts, so in the Vite dev server the preamble never runs and the plugin
 * aborts with "can't detect preamble".
 *
 * This module installs the very same no-op hooks before the application entry
 * is evaluated (ES module imports are evaluated first), which keeps the dev
 * server working without weakening the CSP. In a production build
 * `import.meta.env.DEV` is `false` and the module body is removed entirely.
 */

if (import.meta.env.DEV) {
  interface RefreshScope {
    $RefreshReg$?: () => void;
    $RefreshSig$?: (type: unknown) => unknown;
  }

  const scope = window as unknown as RefreshScope;
  scope.$RefreshReg$ = scope.$RefreshReg$ ?? ((): void => undefined);
  scope.$RefreshSig$ = scope.$RefreshSig$ ?? ((type: unknown): unknown => type);
}
