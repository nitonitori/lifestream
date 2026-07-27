import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { Tmux } from '../../src/adapters/tmux.js';

const tmux = new Tmux('ls-test');
const NAME = 'ls-it-' + process.pid;
const OUT = `/tmp/ls-it-out-${process.pid}`;
afterAll(async () => { try { await tmux.killSession(NAME); } catch { /* ignore */ } try { if (existsSync(OUT)) rmSync(OUT); } catch { /* ignore */ } });

describe('Tmux (integration)', () => {
  it('new/has/send/kill roundtrip with multiline (B1)', async () => {
    await tmux.newSession(NAME, process.cwd(), ['sh', '-c', `cat >> ${OUT}`]);
    expect(await tmux.hasSession(NAME)).toBe(true);
    await tmux.sendText(NAME, 'line-one\nline-two');
    await new Promise(r => setTimeout(r, 500));
    const content = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    expect(content).toContain('line-one');
    expect(content).toContain('line-two');
    await tmux.killSession(NAME);
    expect(await tmux.hasSession(NAME)).toBe(false);
  });
});
