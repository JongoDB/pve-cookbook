import { ApiError } from '../api/http';
import type { Api } from '../api/types';
import { defaultLayout, sanitizeLayout, type Layout } from './layout';

export const DASHBOARD_PREF = 'dashboard';

export interface LoadResult { layout: Layout; /** set when the saved layout could not be read (the default is shown) */ error?: string }

/**
 * Loads and saves the Overview layout per user (GET/PUT /api/prefs/dashboard).
 * A 404 means "never saved": the default layout. Saves are debounced so dragging or
 * clicking resize several times sends one PUT.
 */
export class LayoutPersistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Layout | null = null;
  private disposed = false;

  constructor(
    private api: Pick<Api, 'getPref' | 'putPref'>,
    private onSaveError: (msg: string | null) => void = () => undefined,
    private debounceMs = 800,
  ) {}

  async load(): Promise<LoadResult> {
    try {
      const raw = await this.api.getPref<unknown>(DASHBOARD_PREF);
      const l = sanitizeLayout(raw);
      return l ? { layout: l } : { layout: defaultLayout() };
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return { layout: defaultLayout() };
      return { layout: defaultLayout(), error: `Could not load your saved layout (${e instanceof Error ? e.message : String(e)}). Showing the default.` };
    }
  }

  save(l: Layout): void {
    if (this.disposed) return;
    this.pending = l;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, this.debounceMs);
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const l = this.pending;
    this.pending = null;
    if (!l) return;
    try {
      await this.api.putPref(DASHBOARD_PREF, l);
      this.onSaveError(null);
    } catch (e) {
      this.onSaveError(`Your layout was not saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Sends any pending save immediately, then stops. */
  dispose(): void {
    if (this.pending) void this.flush();
    this.disposed = true;
  }
}
