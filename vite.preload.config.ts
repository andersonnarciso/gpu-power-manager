import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * Build do preload.
 *
 * O preload roda **sandboxed** (`sandbox: true` em `src/main/index.ts`).
 * Nesse modo o carregador do Electron só permite `require` de módulos
 * internos e de poucos built-ins: um `require` relativo para outro arquivo do
 * projeto **não funciona** e o preload inteiro falha ao carregar — o
 * renderer ficaria sem nenhuma ponte.
 *
 * Por isso o preload é empacotado aqui em um único arquivo CommonJS, com o
 * módulo `shared/ipc` embutido. O único `require` que sobra é o do
 * `electron`, que é explicitamente externo.
 */
export default defineConfig({
  build: {
    outDir: 'out/preload',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    target: 'node20',
    lib: {
      entry: fileURLToPath(new URL('./src/preload/index.ts', import.meta.url)),
      formats: ['cjs'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: ['electron'],
      output: {
        entryFileNames: 'index.js',
        format: 'cjs',
        exports: 'auto',
        inlineDynamicImports: true,
      },
    },
  },
});
