import { describe, it, expect } from 'vitest';
import { parseTranscriptLine, parseTranscript } from '../../src/domain/transcript-parser.js';
import * as F from '../fixtures/transcript-lines.js';

describe('parseTranscriptLine', () => {
  it('parses user text (A1.AC1)', () => {
    const e = parseTranscriptLine(F.userLine)!;
    expect(e.kind).toBe('user');
    expect(e).toMatchObject({ uuid: 'u1', text: '你好' });
    expect(e.ts).toBe(Date.parse('2026-07-27T02:53:09.041Z'));
  });
  it('parses assistant text + tool_use (A1.AC2)', () => {
    const e = parseTranscriptLine(F.assistantToolLine)!;
    expect(e.kind).toBe('assistant');
    if (e.kind !== 'assistant') throw new Error();
    expect(e.text).toBe('我来处理');
    expect(e.toolUses).toEqual([{ id: 'tu1', name: 'Bash', input: { command: 'ls' } }]);
  });
  it('parses tool_result (A1.AC3)', () => {
    const e = parseTranscriptLine(F.toolResultLine)!;
    expect(e.kind).toBe('tool_result');
    if (e.kind !== 'tool_result') throw new Error();
    expect(e).toMatchObject({ toolUseId: 'tu1', content: 'file.txt', isError: false });
  });
  it('returns null on bad JSON (A1.AC4)', () => {
    expect(parseTranscriptLine(F.halfLine)).toBeNull();
    expect(parseTranscriptLine('')).toBeNull();
  });
  it('maps unknown/meta types to meta (A1.AC5)', () => {
    const e = parseTranscriptLine(F.metaLine)!;
    expect(e.kind).toBe('meta');
    if (e.kind !== 'meta') throw new Error();
    expect(e.type).toBe('last-prompt');
  });
});

describe('parseTranscript', () => {
  it('filters null and dedups by uuid', () => {
    const events = parseTranscript([F.userLine, F.userLine, F.halfLine, F.assistantToolLine]);
    expect(events.map(e => e.uuid)).toEqual(['u1', 'a1']);
  });
});
