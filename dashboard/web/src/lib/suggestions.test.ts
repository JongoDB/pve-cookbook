import { describe, expect, it } from 'vitest';
import { splitSuggestions, startersFor } from './suggestions';

describe('splitSuggestions', () => {
  it('strips the block and returns its items', () => {
    const r = splitSuggestions('All good.\n\n<suggestions>\n- Show pve1\n- What about backups?\n</suggestions>');
    expect(r).toEqual({ text: 'All good.', suggestions: ['Show pve1', 'What about backups?'] });
  });

  it('leaves text without a block alone', () => {
    expect(splitSuggestions('Use `a < b` here.')).toEqual({ text: 'Use `a < b` here.', suggestions: [] });
  });

  it('tolerates a missing closing tag, whitespace, * and numbered bullets, and quotes', () => {
    const r = splitSuggestions('Done.\n<suggestions >\n   *   One  \n\n2. "Two"\n• Three');
    expect(r).toEqual({ text: 'Done.', suggestions: ['One', 'Two', 'Three'] });
  });

  it('keeps at most 4 items, drops long, empty and duplicate ones', () => {
    const long = 'x'.repeat(121);
    const r = splitSuggestions(`Hi\n<suggestions>\n- a\n- \n- ${long}\n- A\n- b\n- c\n- d\n- e\n</suggestions>`);
    expect(r.suggestions).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ignores an empty block', () => {
    expect(splitSuggestions('Hi\n<suggestions>\n</suggestions>')).toEqual({ text: 'Hi', suggestions: [] });
  });

  it('is case-insensitive and drops anything after the block', () => {
    expect(splitSuggestions('Hi <SUGGESTIONS>\n- a\n</Suggestions> trailing')).toEqual({ text: 'Hi', suggestions: ['a'] });
  });

  it('hides a partial opening tag while streaming, but not once done', () => {
    for (const tail of ['<', '<s', '<sugg', '<suggestions', '<SUGGEST']) {
      expect(splitSuggestions(`Answer.\n\n${tail}`, true).text).toBe('Answer.');
    }
    expect(splitSuggestions('Answer <', false).text).toBe('Answer <');
    // a "<" that is not the start of the tag stays
    expect(splitSuggestions('if a <b', true).text).toBe('if a <b');
  });

  it('never shows the raw tag mid-stream, and holds back a half-written item', () => {
    expect(splitSuggestions('Answer.\n<suggestions', true)).toEqual({ text: 'Answer.', suggestions: [] });
    expect(splitSuggestions('Answer.\n<suggestions>\n- Fir', true)).toEqual({ text: 'Answer.', suggestions: [] });
    expect(splitSuggestions('Answer.\n<suggestions>\n- First\n- Sec', true)).toEqual({ text: 'Answer.', suggestions: ['First'] });
  });
});

describe('startersFor', () => {
  it('picks questions for the page', () => {
    expect(startersFor('/')[0]).toBe('What needs my attention?');
    expect(startersFor('/guests/pve-lab/120', 'web01')).toEqual(['Why is web01 slow?', 'Snapshot web01', 'How do I add a disk to web01?']);
    expect(startersFor('/guests/pve-lab/120')[0]).toBe('Why is this guest slow?');
    expect(startersFor('/hardware')).toContain('Which GPUs can I pass through?');
    expect(startersFor('/protection')).toContain("Which guests aren't backed up?");
    expect(startersFor('/create')).toContain('Help me create an LLM server');
    expect(startersFor('/audit')).toEqual(['What needs my attention?', 'How do changes work?']);
  });
});
