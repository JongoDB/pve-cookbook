// Minimal typing for the parts of noVNC's RFB class galley uses (the package ships no types).
declare module '@novnc/novnc' {
  export interface RFBOptions {
    credentials?: { password?: string; username?: string; target?: string };
    shared?: boolean;
    wsProtocols?: string[];
  }
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions);
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    viewOnly: boolean;
    focusOnClick: boolean;
    background: string;
    disconnect(): void;
    sendCredentials(credentials: { password?: string; username?: string }): void;
    sendCtrlAltDel(): void;
    focus(): void;
  }
}
