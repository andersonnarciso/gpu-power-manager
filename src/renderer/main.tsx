// Must stay first: installs the React Fast Refresh hooks that the strict CSP
// blocks in the inline preamble of @vitejs/plugin-react.
import './lib/dev/refresh-shim';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/globals.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('Elemento #root não encontrado no documento.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
