import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

interface State { error: Error | null }

/**
 * Catches a page that fails to render, so the rest of galley (navigation, the drawer with
 * running changes) stays usable. Keyed by the route: moving to another page starts fresh.
 */
class Boundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('galley page failed to render', error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <h1>Something went wrong</h1>
        <div className="notice notice-error" role="alert">
          <div className="grow">This page failed to show: {this.state.error.message}. Other pages still work. Reload to try again, and if it keeps happening, send feedback with the page address.</div>
          <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}

export function PageBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <Boundary key={pathname}>{children}</Boundary>;
}
