import { describe, it, expect } from 'vitest';
import { buildAgentArgs, extractAgentResult, MESSENGER_SYSTEM_PROMPT } from '../../src/adapters/agent-runner.js';

const base = { text: '列出会话', mcpConfigPath: '/s/control-mcp.json', systemPrompt: MESSENGER_SYSTEM_PROMPT, permissionMode: 'bypassPermissions' };

describe('buildAgentArgs', () => {
  it('starts a new session with --session-id first turn', () => {
    const a = buildAgentArgs({ ...base, sessionId: 'sid-1', resume: false });
    expect(a).toContain('--session-id');
    expect(a).toContain('sid-1');
    expect(a).not.toContain('--resume');
  });
  it('resumes on later turns (shared context)', () => {
    const a = buildAgentArgs({ ...base, sessionId: 'sid-1', resume: true });
    expect(a).toContain('--resume');
    expect(a).not.toContain('--session-id');
  });
  it('loads our control MCP but NOT strict (keeps user MCP servers + skills/tools)', () => {
    const a = buildAgentArgs({ ...base, sessionId: 's', resume: false });
    expect(a).toContain('--mcp-config');
    expect(a).toContain('/s/control-mcp.json');
    expect(a).not.toContain('--strict-mcp-config');
  });
  it('applies configured permission mode', () => {
    const a = buildAgentArgs({ ...base, sessionId: 's', resume: false, permissionMode: 'plan' });
    const i = a.indexOf('--permission-mode');
    expect(a[i + 1]).toBe('plan');
  });
});

describe('MESSENGER_SYSTEM_PROMPT', () => {
  it('grants full CC capability but gates cross-session control behind propose_*', () => {
    expect(MESSENGER_SYSTEM_PROMPT).toContain('propose_');
  });
});

describe('extractAgentResult', () => {
  it('pulls .result from the result event of claude -p json array', () => {
    const out = JSON.stringify([
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } },
      { type: 'result', subtype: 'success', result: '共有 3 个会话' },
    ]);
    expect(extractAgentResult(out)).toBe('共有 3 个会话');
  });
  it('falls back to last assistant text when no result', () => {
    const out = JSON.stringify([{ type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } }]);
    expect(extractAgentResult(out)).toBe('你好');
  });
  it('handles single-object result and junk', () => {
    expect(extractAgentResult(JSON.stringify({ result: 'ok' }))).toBe('ok');
    expect(extractAgentResult('not json')).toBe('not json');
  });
});
