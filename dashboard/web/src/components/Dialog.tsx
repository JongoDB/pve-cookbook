import { useEffect, useId, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog: focus moves into it and stays there (Tab wraps), Escape and the backdrop
 * close it, and focus returns to where it was. `footer` holds the buttons.
 */
export function Dialog({ title, onClose, children, footer, wide = false, initialFocus }: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** selector inside the dialog to focus first (default: the first field, else the first button) */
  initialFocus?: string;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const el = box.current;
    const first = (initialFocus && el?.querySelector<HTMLElement>(initialFocus))
      || el?.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select')
      || el?.querySelector<HTMLElement>('.dialog-foot .btn-primary')
      || el;
    first?.focus();
    return () => { before?.focus?.(); };
  }, [initialFocus]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); return; }
    if (e.key !== 'Tab' || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
    if (!items.length) { e.preventDefault(); return; }
    const a = items[0];
    const z = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === a || document.activeElement === box.current)) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close.current(); }}>
      <div ref={box} className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} tabIndex={-1} onKeyDown={onKey}>
        <div className="dialog-head">
          <h2 id={`${id}-t`}>{title}</h2>
          <button type="button" className="icon-btn dialog-x" aria-label="Close" onClick={() => close.current()}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}
