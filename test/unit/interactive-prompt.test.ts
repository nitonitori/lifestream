import { describe, it, expect } from 'vitest';
import { parseInteractivePrompt } from '../../src/domain/interactive-prompt.js';

// tmux capture-pane -p 输出常带 TUI 边框字符；样例复刻实测形态(Claude Code v2.1.217)。
const PERMISSION = [
  '╭──────────────────────────────────────────────────────────╮',
  '│ Bash command                                               │',
  '│                                                            │',
  '│ chmod -R 777 /tmp/ls_probe_chmod                           │',
  '│ Change file permissions recursively                        │',
  '│                                                            │',
  '│ Do you want to proceed?                                    │',
  '│ ❯ 1. Yes                                                   │',
  '│   2. No, and tell Claude what to do differently (esc)      │',
  '╰──────────────────────────────────────────────────────────╯',
].join('\n');

const ASK = [
  '╭──────────────────────────────────────────────────────────╮',
  '│ Which approach do you prefer?                              │',
  '│ ❯ 1. Option A                                              │',
  '│   2. Option B                                              │',
  '│   3. Option C                                              │',
  '│                                                            │',
  '│   Use arrow keys, esc to cancel                            │',
  '╰──────────────────────────────────────────────────────────╯',
].join('\n');

const PLAIN = [
  'Here is a numbered list from the transcript:',
  '1. first thing we did',
  '2. second thing we did',
  '',
  'All done, nothing to select.',
].join('\n');

describe('parseInteractivePrompt', () => {
  it('parses a permission box → kind=permission, two options, question', () => {
    const p = parseInteractivePrompt(PERMISSION);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('permission');
    expect(p!.question).toBe('Do you want to proceed?');
    expect(p!.options).toEqual([
      { key: '1', label: 'Yes' },
      { key: '2', label: 'No, and tell Claude what to do differently (esc)' },
    ]);
  });

  it('parses an AskUserQuestion menu → kind=select, multi options', () => {
    const p = parseInteractivePrompt(ASK);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('select');
    expect(p!.question).toBe('Which approach do you prefer?');
    expect(p!.options.map(o => o.key)).toEqual(['1', '2', '3']);
    expect(p!.options[1].label).toBe('Option B');
  });

  it('returns null for ordinary transcript text with numbered lines', () => {
    expect(parseInteractivePrompt(PLAIN)).toBeNull();
  });

  it('returns null for empty pane', () => {
    expect(parseInteractivePrompt('')).toBeNull();
  });
});
