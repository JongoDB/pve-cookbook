import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { Api, Me } from './api/types';
import { ApiError } from './api/http';
import { AppProvider } from './state/app';
import { Layout } from './components/Layout';
import { ErrorBox } from './components/ui';
import { Login, Setup } from './pages/Auth';
import { Overview } from './pages/Overview';
import { Guests } from './pages/Guests';
import { GuestDetail } from './pages/GuestDetail';
import { NodeDetail } from './pages/NodeDetail';
import { StorageDetail } from './pages/StorageDetail';
import { Activity, Nodes, StorageList } from './pages/Lists';
import { Protection } from './pages/Protection';
import { Audit } from './pages/Audit';
import { Clusters } from './pages/Clusters';
import { SESSION_ENDED } from './lib/auth';

type Boot = { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'setup' } | { phase: 'login'; notice?: string } | { phase: 'ready'; me: Me };

export function App({ api }: { api: Api }) {
  const [boot, setBoot] = useState<Boot>({ phase: 'loading' });

  const start = useCallback(async () => {
    try {
      const s = await api.setup();
      if (s.needsSetup) { setBoot({ phase: 'setup' }); return; }
      try {
        setBoot({ phase: 'ready', me: await api.me() });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setBoot({ phase: 'login' });
        else throw e;
      }
    } catch (e) {
      setBoot({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, [api]);

  useEffect(() => { void start(); }, [start]);

  // Any 401 "unauthenticated" outside login (HttpApi reports them centrally) ends the session:
  // back to login. Only acts while logged in, so the boot-time /api/me probe stays quiet.
  useEffect(() => {
    api.onUnauthorized(() => setBoot((b) => (b.phase === 'ready' ? { phase: 'login', notice: SESSION_ENDED } : b)));
    return () => api.onUnauthorized(null);
  }, [api]);

  const setMe = useCallback((m: Me | null) => setBoot(m ? { phase: 'ready', me: m } : { phase: 'login' }), []);

  switch (boot.phase) {
    case 'loading':
      return <div className="boot" role="status">Connecting to galley</div>;
    case 'error':
      return (
        <div className="boot">
          <ErrorBox message={`galley's API did not answer: ${boot.message}. Check that the galley service is running, then retry.`} />
          <button type="button" className="btn" onClick={() => void start()}>Retry</button>
        </div>
      );
    case 'setup':
      return <Setup api={api} onDone={() => setBoot({ phase: 'login' })} />;
    case 'login':
      return <Login api={api} notice={boot.notice} onLogin={(m) => setBoot({ phase: 'ready', me: m })} />;
    case 'ready':
      return (
        <BrowserRouter>
          <AppProvider api={api} me={boot.me} setMe={setMe}>
            <Layout>
              <Routes>
                <Route path="/" element={<Overview />} />
                <Route path="/guests" element={<Guests />} />
                <Route path="/guests/:cluster/:vmid" element={<GuestDetail />} />
                <Route path="/nodes" element={<Nodes />} />
                <Route path="/nodes/:cluster/:node" element={<NodeDetail />} />
                <Route path="/storage" element={<StorageList />} />
                <Route path="/storage/:cluster/:storage" element={<StorageDetail />} />
                <Route path="/protection" element={<Protection />} />
                <Route path="/activity" element={<Activity />} />
                <Route path="/operations" element={<Navigate to="/activity" replace />} />
                <Route path="/audit" element={<Audit />} />
                <Route path="/clusters" element={<Clusters />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Layout>
          </AppProvider>
        </BrowserRouter>
      );
  }
}
