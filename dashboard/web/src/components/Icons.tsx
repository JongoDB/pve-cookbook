// Small stroke icons (aria-hidden; every icon button carries a text label).
const base = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const IconFold = () => <svg {...base}><path d="M9 6l6 6-6 6" /></svg>;
export const IconUnfold = () => <svg {...base}><path d="M15 6l-6 6 6 6" /></svg>;
export const IconClose = () => <svg {...base}><path d="M6 6l12 12M18 6L6 18" /></svg>;
export const IconUp = () => <svg {...base}><path d="M15 18l-6-6 6-6" /></svg>;
export const IconDown = () => <svg {...base}><path d="M9 6l6 6-6 6" /></svg>;
export const IconResize = () => <svg {...base}><path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4" /></svg>;
export const IconGrip = () => <svg {...base}><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></svg>;
export const IconSettings = () => <svg {...base}><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>;
export const IconMenu = () => <svg {...base}><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
export const IconAssistant = () => <svg {...base}><path d="M5 5h14v10H9l-4 4z" /></svg>;
export const IconChanges = () => <svg {...base}><path d="M5 7h10M5 12h14M5 17h8" /><path d="M17 5l2 2-2 2" /></svg>;
export const IconActivity = () => <svg {...base}><path d="M3 12h4l3-7 4 14 3-7h4" /></svg>;
export const IconHelp = () => <svg {...base}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.4" /><path d="M12 17h0" /></svg>;
