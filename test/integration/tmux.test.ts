import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { Tmux } from '../../src/adapters/tmux.js';

const tmux = new Tmux('ls-test');
const NAME = 'ls-it-' + process.pid;
const OUT = `/tmp/ls-it-out-${process.pid}`;
afterAll(async () => { try { await tmux.killSession(NAME); } catch { /* ignore */ } try { if (existsSync(OUT)) rmSync(OUT); } catch { /* ignore */ } });

// 真 tmux 集成：每条要串行 spawn 五六次 tmux（首次还要拉起 server），并等 500ms 让 cat 落盘。
// 整套并行跑时会顶到 vitest 默认的 5s 上限，故显式给足预算；断言本身与耗时无关。
const REAL_TMUX_TIMEOUT_MS = 20_000;

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
  }, REAL_TMUX_TIMEOUT_MS);

  it('sendLiteral 不追加 Enter（真 tmux 字节级）', async () => {
    // 独立前缀: tmux 的 -t 按前缀解析, 若叫 NAME + '-lit' 则上一条测试的 hasSession(NAME) 会命中它。
    const name = 'ls-lit-' + process.pid;
    const out = `/tmp/ls-lit-out-${process.pid}`;
    try {
      await tmux.newSession(name, process.cwd(), ['sh', '-c', `cat >> ${out}`]);
      await tmux.sendLiteral(name, 'abc');
      await new Promise(r => setTimeout(r, 500));
      // 没有回车 => cat 的行缓冲不 flush => 文件根本没被创建/仍为空
      expect(existsSync(out) ? readFileSync(out, 'utf8') : '').toBe('');
      expect(await tmux.capturePane(name)).toContain('abc');
      // 补一次带回车的发送 => 两段字符同一行交付, 证明 abc 之后确实没有过换行
      await tmux.sendText(name, 'def');
      await new Promise(r => setTimeout(r, 500));
      expect(readFileSync(out, 'utf8')).toBe('abcdef\n');
    } finally {
      try { await tmux.killSession(name); } catch { /* ignore */ }
      try { if (existsSync(out)) rmSync(out); } catch { /* ignore */ }
    }
  }, REAL_TMUX_TIMEOUT_MS);
});
