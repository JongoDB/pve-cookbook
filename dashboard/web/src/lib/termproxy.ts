// PVE termproxy wire format (what the PVE web UI's xterm.js client speaks):
// the first message is "<user>:<ticket>\n"; then keyboard input is "0:<byte length>:<data>",
// a resize is "1:<cols>:<rows>:" and "2" is a keep-alive ping. Output arrives as raw bytes.

const encoder = new TextEncoder();

export const loginMessage = (user: string, password: string) => `${user}:${password}\n`;

/** Length is in UTF-8 bytes, not UTF-16 code units: "ä" is 2, "😀" is 4. */
export const inputFrame = (data: string) => `0:${encoder.encode(data).length}:${data}`;

export const resizeFrame = (cols: number, rows: number) => `1:${Math.max(1, Math.floor(cols))}:${Math.max(1, Math.floor(rows))}:`;

export const PING_FRAME = '2';

/** ws:// or wss:// URL of galley's console proxy for a one-time token, on the page's own origin. */
export function consoleSocketUrl(token: string, loc: { protocol: string; host: string } = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/api/console/${encodeURIComponent(token)}`;
}
