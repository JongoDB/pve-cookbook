import { describe, expect, it } from 'vitest';
import { axisTicks, formatBitRate, formatBytes, formatPct, formatValue, parseSize } from './units';

describe('formatBytes (binary units)', () => {
  it('uses KiB/MiB/GiB/TiB with at most one decimal below 10', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(8 * 1024 ** 3)).toBe('8 GiB');
    expect(formatBytes(503 * 1024 ** 3)).toBe('503 GiB');
    expect(formatBytes(31.4 * 1024 ** 4)).toBe('31 TiB');
    expect(formatBytes(1.25 * 1024 ** 4)).toBe('1.3 TiB');
  });
  it('says unknown instead of inventing a number', () => {
    expect(formatBytes(null)).toBe('unknown');
    expect(formatBytes(NaN)).toBe('unknown');
  });
});

describe('formatBitRate (network as bits)', () => {
  it('multiplies bytes/s by 8 and uses decimal bit units', () => {
    expect(formatBitRate(0)).toBe('0 bit/s');
    expect(formatBitRate(100)).toBe('800 bit/s');
    expect(formatBitRate(125_000)).toBe('1 Mbit/s');
    expect(formatBitRate(12_500_000)).toBe('100 Mbit/s');
    expect(formatBitRate(125_000_000)).toBe('1 Gbit/s');
    expect(formatBitRate(1_562_500_000)).toBe('13 Gbit/s');
  });
});

describe('formatPct', () => {
  it('formats fractions', () => {
    expect(formatPct(0.423)).toBe('42%');
    expect(formatPct(0.004)).toBe('0.4%');
    expect(formatPct(0)).toBe('0%');
    expect(formatPct(1)).toBe('100%');
    expect(formatPct(undefined)).toBe('unknown');
  });
  it('formatValue routes by unit', () => {
    expect(formatValue('fraction', 0.5)).toBe('50%');
    expect(formatValue('percent', 3.25)).toBe('3.3%');
    expect(formatValue('netRate', 125_000)).toBe('1 Mbit/s');
    expect(formatValue('byteRate', 2 * 1024 ** 2)).toBe('2 MiB/s');
    expect(formatValue('count', 1.5)).toBe('1.5');
    expect(formatValue('bytes', null)).toBe('no data');
  });
});

describe('axisTicks', () => {
  it('pins utilisation to 0–100%', () => {
    expect(axisTicks('fraction', 0.03)).toEqual({ max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] });
  });
  it('ticks network rates on round bit values', () => {
    const { max, ticks } = axisTicks('netRate', 100_000_000); // 800 Mbit/s
    expect(max * 8).toBe(800_000_000);
    expect(ticks.map((t) => formatBitRate(t))).toEqual(['0 bit/s', '200 Mbit/s', '400 Mbit/s', '600 Mbit/s', '800 Mbit/s']);
  });
  it('ticks bytes on binary boundaries', () => {
    const { ticks } = axisTicks('bytes', 30 * 1024 ** 3);
    expect(ticks.map(formatBytes)).toEqual(['0 B', '8 GiB', '16 GiB', '24 GiB', '32 GiB']);
  });
});

describe('parseSize', () => {
  it('reads PVE size strings', () => {
    expect(parseSize('200G')).toBe(200 * 1024 ** 3);
    expect(parseSize('512M')).toBe(512 * 1024 ** 2);
    expect(parseSize('1T')).toBe(1024 ** 4);
    expect(parseSize('32')).toBe(32 * 1024 ** 3);
    expect(parseSize('x')).toBeNull();
  });
});
