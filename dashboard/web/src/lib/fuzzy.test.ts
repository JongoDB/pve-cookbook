import { describe, expect, it } from 'vitest';
import { rank, score } from './fuzzy';

describe('score', () => {
  it('matches subsequences and prefers prefixes', () => {
    expect(score('web', 'web01')).toBeGreaterThan(score('web', 'my-web01'));
    expect(score('xyz', 'web01')).toBe(-1);
  });

  it('matches each word of a multi-word query, in any order', () => {
    // the API explorer's own example query
    expect(score('qemu config', '/nodes/{node}/qemu/{vmid}/config')).toBeGreaterThan(0);
    expect(score('config qemu', '/nodes/{node}/qemu/{vmid}/config')).toBeGreaterThan(0);
    expect(score('qemu zzz', '/nodes/{node}/qemu/{vmid}/config')).toBe(-1);
  });

  it('ranks the closest paths first', () => {
    const paths = ['/nodes/{node}/lxc/{vmid}/config', '/nodes/{node}/qemu/{vmid}/config', '/nodes/{node}/qemu'];
    expect(rank('qemu config', paths, (p) => p)[0]).toBe('/nodes/{node}/qemu/{vmid}/config');
  });
});
