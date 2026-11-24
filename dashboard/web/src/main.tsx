import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
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
