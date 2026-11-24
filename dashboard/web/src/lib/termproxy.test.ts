import { describe, expect, it } from 'vitest';
import { consoleSocketUrl, inputFrame, loginMessage, resizeFrame } from './termproxy';

describe('termproxy framing', () => {
  it('logs in with user:ticket and a newline', () => {
    expect(loginMessage('root@pam', 'PVEVNC:abc')).toBe('root@pam:PVEVNC:abc\n');
  });
  it('frames input with its UTF-8 byte length', () => {
    expect(inputFrame('ls\r')).toBe('0:3:ls\r');
    expect(inputFrame('ä')).toBe('0:2:ä');
    expect(inputFrame('😀')).toBe('0:4:😀');
    expect(inputFrame('\x1b[A')).toBe('0:3:\x1b[A');
    expect(inputFrame('')).toBe('0:0:');
  });
  it('frames resizes as whole positive numbers', () => {
    expect(resizeFrame(120, 40)).toBe('1:120:40:');
    expect(resizeFrame(80.7, 0)).toBe('1:80:1:');
  });
  it('opens the websocket on the page origin', () => {
    expect(consoleSocketUrl('tok/1', { protocol: 'https:', host: 'galley.example:8443' })).toBe('wss://galley.example:8443/api/console/tok%2F1');
    expect(consoleSocketUrl('t', { protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/api/console/t');
  });
});
