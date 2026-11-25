import { describe, expect, it } from 'vitest';
import { mappingNodes, pinCalls, pinRuleFor, pinRuleId, ruleNodes } from './ha';

describe('HA pinning', () => {
  const rules = [
    { rule: 'web-apart', type: 'resource-affinity', resources: 'vm:120,vm:121', affinity: 'negative' },
    { rule: 'gpu-300', type: 'node-affinity', resources: 'vm:300,vm:3000', nodes: 'pve1:2,pve2', strict: 1 },
    { rule: 'old', type: 'node-affinity', resources: 'vm:400', nodes: 'pve3', disable: 1 },
  ];
  it('finds the enabled node-affinity rule that names a VM', () => {
    expect(pinRuleFor(rules, 300)?.rule).toBe('gpu-300');
    expect(pinRuleFor(rules, 30)).toBeUndefined();
    expect(pinRuleFor(rules, 120)).toBeUndefined();
    expect(pinRuleFor(rules, 400)).toBeUndefined();
    expect(ruleNodes(rules[1])).toEqual(['pve1', 'pve2']);
  });
  it('reads the nodes of a mapping and picks a free rule id', () => {
    expect(mappingNodes({ map: ['node=pve1,path=0000:16:00.0', 'node=pve2,path=0000:41:00.0', 'node=pve1,path=0000:91:00.0'] })).toEqual(['pve1', 'pve2']);
    expect(pinRuleId(300)).toBe('gpu-300');
    expect(pinRuleId(300, ['gpu-300', 'gpu-300-2'])).toBe('gpu-300-3');
  });
  it('adds only the rule when the VM is already an HA resource', () => {
    const calls = pinCalls({ vmid: 300, mapping: 'gpu-a2-0', nodes: ['pve1'], state: 'started', haResource: true });
    expect(calls).toEqual([{ method: 'POST', path: '/cluster/ha/rules', body: { rule: 'gpu-300', type: 'node-affinity', resources: 'vm:300', nodes: 'pve1', strict: '1', comment: 'galley: gpu-a2-0 only exists on these nodes' } }]);
    expect(pinCalls({ vmid: 300, mapping: 'gpu-a2-0', nodes: ['pve1'], state: 'stopped' })[0]).toEqual({ method: 'POST', path: '/cluster/ha/resources', body: { sid: 'vm:300', state: 'stopped' } });
  });
});
