export const userLine = JSON.stringify({
  type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-07-27T02:53:09.041Z',
  message: { role: 'user', content: '你好' },
});
export const assistantToolLine = JSON.stringify({
  type: 'assistant', uuid: 'a1', timestamp: '2026-07-27T02:53:10.000Z',
  message: { role: 'assistant', content: [
    { type: 'text', text: '我来处理' },
    { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
  ] },
});
export const toolResultLine = JSON.stringify({
  type: 'user', uuid: 'r1', timestamp: '2026-07-27T02:53:11.000Z',
  message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tu1', content: 'file.txt', is_error: false },
  ] },
});
export const metaLine = JSON.stringify({ type: 'last-prompt', leafUuid: 'x', sessionId: 's' });
export const halfLine = '{"type":"user","uuid":"bad"';
