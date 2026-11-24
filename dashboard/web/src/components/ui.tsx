import { useState, type ReactNode } from 'react';
import { pct } from '../lib/format';

export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--accent-fg)" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 15h18l-2 5H5z" />
      <path d="M12 15V4l6 9" />
    </svg>
  );
}

export function Dot({ tone, label }: { tone: 'ok' | 'warn' | 'crit' | 'off'; label?: string }) {
  return <span className={`dot dot-${tone}`} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>●</span>;
}

export function Level({ level }: { level: string }) {
  return <span className={`level level-${level.toLowerCase()}`}>{level}</span>;
}

export function Bar({ used, total, color = 'var(--accent-fg)', label }: { used: number; total: number; color?: string; label: string }) {
  const p = pct(used, total);
  return (
    <span className="bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)}>
      <span className="bar-fill" style={{ width: `${p}%`, background: color }} />
    </span>
  );
}

export function CopyButton({ text, label = 'Copy CLI', className = 'btn' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked */ }
      }}
    >
      {done ? 'Copied' : label}
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

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="error-box" role="alert">{message}</div>;
}
