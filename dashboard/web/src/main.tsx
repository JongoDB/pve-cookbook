import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted fonts (CSP font-src 'self': no external requests).
import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-600.css';
import '@fontsource/barlow-semi-condensed/latin-500.css';
import '@fontsource/barlow-semi-condensed/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import './styles.css';
import { App } from './App';
import { HttpApi } from './api/http';
import type { Api } from './api/types';

// Mock mode (`npm run dev:mock`) uses an in-memory API; the import is dropped from
// production builds because the condition is a compile-time constant.
const api: Api = import.meta.env.VITE_MOCK === '1'
  ? new (await import('./api/mock')).MockApi()
  : new HttpApi();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
);
