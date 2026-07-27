import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeHome } from '../../src/adapters/claude-home.js';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'lsh-'));
  mkdirSync(join(home, 'sessions'), { recursive: true });
  mkdirSync(join(home, 'projects', '-w-proj'), { recursive: true });
  writeFileSync(join(home, 'sessions', '111.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', cwd: '/w', status: 'idle' }));
  writeFileSync(join(home, 'sessions', 'dead.json'), JSON.stringify({ pid: 2147480000, sessionId: 'sdead', cwd: '/w', status: 'idle' }));
  writeFileSync(join(home, 'projects', '-w-proj', 's1.jsonl'), JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }) + '\n');
  return new ClaudeHome(home);
}

describe('ClaudeHome (integration)', () => {
  it('reads live sessions for alive pid, skips dead (A2.AC1/AC3)', async () => {
    const live = await setup().readLiveSessions();
    expect(live.find(l => l.sessionId === 's1')).toMatchObject({ cwd: '/w', status: 'idle' });
    expect(live.find(l => l.sessionId === 'sdead')).toBeUndefined();
  });
  it('locates and reads transcript by sessionId', async () => {
    const h = setup();
    const p = await h.locateTranscript('s1');
    expect(p).toContain('s1.jsonl');
    expect((await h.readTranscript(p!))[0]).toContain('"uuid":"u1"');
  });
  it('returns null when transcript missing', async () => {
    expect(await setup().locateTranscript('nope')).toBeNull();
  });
});
