import { describe, expect, it } from 'vitest';
import { areaPath, linePath, linearScale, nearestIndex, segments } from './chart';

const x = linearScale(0, 4, 0, 400);
const y = linearScale(0, 10, 100, 0);

describe('chart null-gap handling', () => {
  it('finds runs of non-null values', () => {
    expect(segments([1, 2, null, 4, 5])).toEqual([[0, 1], [3, 4]]);
    expect(segments([null, null])).toEqual([]);
    expect(segments([null, 3, null])).toEqual([[1, 1]]);
    expect(segments([0, 0])).toEqual([[0, 1]]); // zero is a value, not a gap
  });

  it('breaks the line at nulls instead of drawing them as zero', () => {
    const d = linePath([0, 1, 2, 3, 4], [5, 5, null, 10, 0], x, y);
    expect(d).toBe('M0,50L100,50M300,0L400,100');
    expect(d).not.toContain('200,'); // the null sample at t=2 is never plotted
  });

  it('draws an isolated sample as a zero-length segment (a dot)', () => {
    expect(linePath([0, 1, 2], [null, 5, null], x, y)).toBe('M100,50L100,50');
  });

  it('returns an empty path when every sample is missing', () => {
    expect(linePath([0, 1], [null, null], x, y)).toBe('');
  });

  it('closes each area run to the baseline separately', () => {
    expect(areaPath([0, 1, 2, 3, 4], [5, 5, null, 10, 0], x, y, 100)).toBe('M0,100L0,50L100,50L100,100ZM300,100L300,0L400,100L400,100Z');
  });

  it('finds the nearest sample for the crosshair', () => {
    expect(nearestIndex([10, 20, 30], 24)).toBe(1);
    expect(nearestIndex([10, 20, 30], 26)).toBe(2);
    expect(nearestIndex([10, 20, 30], -5)).toBe(0);
    expect(nearestIndex([], 5)).toBe(-1);
  });
});
