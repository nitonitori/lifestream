import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Tmux } from '../../src/adapters/tmux.js';
import { ClaudeHome } from '../../src/adapters/claude-home.js';
import { parseTranscript } from '../../src/domain/transcript-parser.js';

const tmux = new Tmux('ls-loop');
const NAME = 'ls-loop-' + process.pid;
afterAll(async () => { try { await tmux.killSession(NAME); } catch { /* ignore */ } });

describe('tmux send-keys -> transcript loop (B2 acceptance)', () => {
  it('injected text lands in the session transcript', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lsloop-'));
    const script = join(process.cwd(), 'test/integration/fake-claude.sh');
    chmodSync(script, 0o755);
    const id = '11111111-2222-3333-4444-555555555555';

    // Launch a managed tmux session running the fake claude (owns the PTY).
    await tmux.newSession(NAME, home, ['bash', script, '--home', home, '--proj', '-w', '--session-id', id]);
    // Inject a multi-word message the same way ControlPlane.sendMessage does.
    await tmux.sendText(NAME, 'hello-loop from lifestream');
    await new Promise(r => setTimeout(r, 1500));

    const path = await new ClaudeHome(home).locateTranscript(id);
    expect(path).not.toBeNull();
    const events = parseTranscript(await new ClaudeHome(home).readTranscript(path!));
    expect(events.some(e => e.kind === 'user' && (e as any).text.includes('hello-loop from lifestream'))).toBe(true);
  }, 20000);
});
