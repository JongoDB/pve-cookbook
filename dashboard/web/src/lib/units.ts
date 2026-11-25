import type { MetricName } from '../api/types';

/** Number with at most one decimal below 10 and none above, without a trailing ".0". */
function short(n: number): string {
  const a = Math.abs(n);
  const s = a >= 10 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** Binary byte units: 1536 → "1.5 KiB", 8 GiB → "8 GiB". */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'unknown';
  if (n === 0) return '0 B';
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i++; }
  return `${n < 0 ? '-' : ''}${short(v)} ${BYTE_UNITS[i]}`;
}

const BIT_UNITS = ['bit/s', 'kbit/s', 'Mbit/s', 'Gbit/s', 'Tbit/s'];

/** Network rate: PVE reports bytes/s; admins think in bits (×8, decimal units). */
export function formatBitRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec === null || bytesPerSec === undefined || !Number.isFinite(bytesPerSec)) return 'unknown';
  let v = Math.abs(bytesPerSec * 8);
  if (v === 0) return '0 bit/s';
  let i = 0;
  while (v >= 1000 && i < BIT_UNITS.length - 1) { v /= 1000; i++; }
  return `${short(v)} ${BIT_UNITS[i]}`;
}

/** Disk throughput, bytes/s in binary units. */
export const formatByteRate = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? 'unknown' : `${formatBytes(n)}/s`);

/** A 0–1 fraction as a percentage: 0.423 → "42%", 0.004 → "0.4%". */
export function formatPct(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return 'unknown';
  return `${short(fraction * 100)}%`;
}

/** How a metric's values are measured, which decides its axis and labels. */
export type MetricUnit = 'fraction' | 'percent' | 'bytes' | 'netRate' | 'byteRate' | 'count';

export const METRIC_UNIT: Record<MetricName, MetricUnit> = {
  cpu: 'fraction', ioWait: 'fraction',
  pressureCpu: 'percent', pressureIo: 'percent', pressureMem: 'percent',
  cpus: 'count', load: 'count',
  memUsed: 'bytes', memTotal: 'bytes', swapUsed: 'bytes', swapTotal: 'bytes',
  rootUsed: 'bytes', rootTotal: 'bytes', diskUsed: 'bytes', diskTotal: 'bytes',
  netIn: 'netRate', netOut: 'netRate', diskRead: 'byteRate', diskWrite: 'byteRate',
};

export const METRIC_LABEL: Record<MetricName, string> = {
  cpu: 'CPU', cpus: 'CPUs', memUsed: 'Memory used', memTotal: 'Memory total', swapUsed: 'Swap used', swapTotal: 'Swap total',
  rootUsed: 'Root disk used', rootTotal: 'Root disk total', diskUsed: 'Used', diskTotal: 'Total',
  netIn: 'In', netOut: 'Out', diskRead: 'Read', diskWrite: 'Write', ioWait: 'IO wait', load: 'Load',
  pressureCpu: 'CPU pressure', pressureIo: 'IO pressure', pressureMem: 'Memory pressure',
};

export function formatValue(unit: MetricUnit, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'no data';
  switch (unit) {
    case 'fraction': return formatPct(v);
    case 'percent': return `${short(v)}%`;
    case 'bytes': return formatBytes(v);
    case 'netRate': return formatBitRate(v);
    case 'byteRate': return formatByteRate(v);
    case 'count': return v >= 100 ? String(Math.round(v)) : v.toFixed(2).replace(/\.?0+$/, '') || '0';
  }
}

/** A "nice" step at or above raw: 1, 2, 2.5 or 5 × 10^n (or × base^n for binary units). */
function niceStep(raw: number, base: 10 | 1024 = 10): number {
  if (raw <= 0) return 1;
  if (base === 1024) {
    // binary: step is 1, 2, 4, 8, … 512 × 1024^n
    let unit = 1;
    while (raw / unit >= 1024) unit *= 1024;
    let m = 1;
    while (m * unit < raw) m *= 2;
    return m * unit;
  }
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/**
 * Axis domain and ticks (0 … max) for a unit. Fractions cap at 100% unless the data exceeds it;
 * network rates tick on bit boundaries; bytes on binary boundaries.
 */
export function axisTicks(unit: MetricUnit, dataMax: number, count = 4): { max: number; ticks: number[] } {
  let m = Number.isFinite(dataMax) && dataMax > 0 ? dataMax : 0;
  // Utilisation reads honestly on a fixed 0–100% axis (a flat 3% line should look flat).
  if (unit === 'fraction' && m <= 1) return { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  if (unit === 'percent' && m <= 0) m = 1;
  if (m <= 0) m = unit === 'netRate' ? 125 : unit === 'bytes' || unit === 'byteRate' ? 1024 : 1;
  if (unit === 'netRate') {
    const stepBits = niceStep((m * 8) / count);
    const step = stepBits / 8;
    return { max: step * Math.ceil(m / step), ticks: range(step * Math.ceil(m / step), step) };
  }
  const base = unit === 'bytes' || unit === 'byteRate' ? 1024 : 10;
  const step = niceStep(m / count, base);
  const max = step * Math.ceil(m / step);
  return { max, ticks: range(max, step) };
}

function range(max: number, step: number): number[] {
  const out: number[] = [];
  for (let v = 0; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** Parse a PVE size string ("200G", "512M", "1T", "32") into bytes. Bare numbers are GiB for disks. */
export function parseSize(s: string | undefined, bareUnit: 'G' | 'M' | 'B' = 'G'): number | null {
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)([KMGTP]?)$/i.exec(s.trim());
  if (!m) return null;
  const unit = (m[2] || bareUnit).toUpperCase();
  const pow = { B: 0, K: 1, M: 2, G: 3, T: 4, P: 5 }[unit] ?? 0;
  return Number(m[1]) * 1024 ** pow;
}
