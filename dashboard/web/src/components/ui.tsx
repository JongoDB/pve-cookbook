import { useState, type ReactNode } from 'react';
import { pct } from '../lib/format';

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 15h18l-2 5H5z" />
      <path d="M12 15V4l6 9h-6" />
    </svg>
  );
}

export type Tone = 'ok' | 'warn' | 'crit' | 'off';

/** A coloured dot that always carries its meaning as text. */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`status status-${tone}`}>{children}</span>;
}

const LEVEL_TEXT: Record<string, string> = { CRIT: 'Crit', WARN: 'Warn', INFO: 'Info' };
const LEVEL_CLASS: Record<string, string> = { CRIT: 'badge-crit', WARN: 'badge-warn', INFO: 'badge-info' };

export function Level({ level }: { level: string }) {
  return <span className={`badge ${LEVEL_CLASS[level] ?? 'badge-neutral'}`}>{LEVEL_TEXT[level] ?? level}</span>;
}

export function Badge({ kind = 'neutral', children }: { kind?: 'ok' | 'warn' | 'crit' | 'info' | 'neutral'; children: ReactNode }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

/** Usage bar. Fill turns amber from 85 % and red from 95 % (and the label says the number). */
export function Meter({ used, total, label, text, fixed = false, warnAt = 85, critAt = 95 }: {
  used: number; total: number; label: string; text?: ReactNode; fixed?: boolean; warnAt?: number; critAt?: number;
}) {
  const p = pct(used, total);
  const cls = p >= critAt ? ' crit' : p >= warnAt ? ' warn' : '';
  return (
    <span className="meter">
      <span className={`meter-track${fixed ? ' fixed' : ''}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)}>
        <span className={`meter-fill${cls}`} style={{ width: `${p}%` }} />
      </span>
      {text !== undefined && <span className="meter-label">{text}</span>}
    </span>
  );
}

export function CopyButton({ text, label = 'Copy commands', className = 'btn btn-sm' }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setState('done'); } catch { setState('failed'); }
        setTimeout(() => setState('idle'), 1800);
      }}
    >
      <span aria-live="polite">{state === 'done' ? 'Copied' : state === 'failed' ? 'Copy blocked by the browser' : label}</span>
    </button>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children ? <div className="muted">{children}</div> : null}
    </div>
  );
}

export function ErrorBox({ message, children }: { message: string | null; children?: ReactNode }) {
  if (!message) return null;
  return <div className="notice notice-error" role="alert"><div className="grow">{message}{children}</div></div>;
}

export function Loading({ what }: { what: string }) {
  return <div className="muted panel-body" role="status">Loading {what}</div>;
}
