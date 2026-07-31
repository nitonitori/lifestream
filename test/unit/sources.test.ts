import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ClaudeSource } from '../../src/adapters/sources/claude.js';
import { QoderCliSource } from '../../src/adapters/sources/qoder-cli.js';
import { flatSessionIdForPath } from '../../src/adapters/sources/base.js';
import { isControllable } from '../../src/ports/index.js';

const home = () => mkdtempSync(join(tmpdir(), 'ls-src-'));

describe('flatSessionIdForPath', () => {
  test('平铺的 jsonl 取文件名主体', () => {
    expect(flatSessionIdForPath('-Users-l-dev-foo/abc-123.jsonl')).toBe('abc-123');
  });
  test('绝对路径同样有效', () => {
    expect(flatSessionIdForPath('/Users/l/.qoder/projects/-Users-l/abc.jsonl')).toBe('abc');
  });
  test('transcript/ 下的转录不归自己', () => {
    expect(flatSessionIdForPath('-Users-l/transcript/abc.jsonl')).toBeNull();
  });
  test('非 jsonl 返回 null', () => {
    expect(flatSessionIdForPath('-Users-l/abc.json')).toBeNull();
  });
});

describe('ClaudeSource', () => {
  test('kernel 是 claude 且可控', () => {
    const s = new ClaudeSource(home(), 'claude', 'bypassPermissions');
    expect(s.kernel).toBe('claude');
    expect(isControllable(s)).toBe(true);
  });

  test('launchCommand 带上 claude 方言的权限模式', () => {
    const s = new ClaudeSource(home(), 'claude', 'bypassPermissions');
    expect(s.launchCommand('sid', { cwd: '/tmp' }))
      .toEqual(['claude', '--session-id', 'sid', '--permission-mode', 'bypassPermissions']);
  });

  test('opts.permissionMode 覆盖构造时的默认值', () => {
    const s = new ClaudeSource(home(), 'claude', 'bypassPermissions');
    expect(s.launchCommand('sid', { cwd: '/tmp', permissionMode: 'plan' }))
      .toEqual(['claude', '--session-id', 'sid', '--permission-mode', 'plan']);
  });

  test('resumeCommand 用 --resume', () => {
    const s = new ClaudeSource(home(), 'claude', 'bypassPermissions');
    expect(s.resumeCommand('ext'))
      .toEqual(['claude', '--resume', 'ext', '--permission-mode', 'bypassPermissions']);
  });

  test('注入的权限模式取值可以是 qodercli 方言', () => {
    const s = new ClaudeSource(home(), 'qodercli', 'bypass_permissions');
    expect(s.launchCommand('sid', { cwd: '/tmp' }))
      .toEqual(['qodercli', '--session-id', 'sid', '--permission-mode', 'bypass_permissions']);
  });

  test('readLiveSessions 只报 pid 还活着的会话，且带 kernel', async () => {
    const h = home();
    mkdirSync(join(h, 'sessions'), { recursive: true });
    writeFileSync(join(h, 'sessions', 'a.json'),
      JSON.stringify({ sessionId: 'a', pid: process.pid, cwd: '/tmp/a' }));
    writeFileSync(join(h, 'sessions', 'b.json'),
      JSON.stringify({ sessionId: 'b', pid: 99999999, cwd: '/tmp/b' }));
    const live = await new ClaudeSource(h, 'claude').readLiveSessions();
    expect(live.map(x => x.sessionId)).toEqual(['a']);
    expect(live[0]!.kernel).toBe('claude');
  });

  test('locateTranscript 拒绝越界 sessionId', async () => {
    const h = home();
    mkdirSync(join(h, 'projects', '-Users-l'), { recursive: true });
    writeFileSync(join(h, 'projects', 'evil.jsonl'), '{}');
    expect(await new ClaudeSource(h, 'claude').locateTranscript('../evil')).toBeNull();
  });
});

describe('QoderCliSource', () => {
  const seed = (h: string, sessionId: string, run: string, lines: string[]) => {
    const dir = join(h, 'logs', 'sessions', '-Users-l-dev-foo', sessionId, 'segments');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${run}.jsonl`), lines.join('\n') + '\n');
  };

  test('kernel 是 qodercli 且用 qodercli 方言', () => {
    const s = new QoderCliSource(home(), 'qodercli', 'bypass_permissions');
    expect(s.kernel).toBe('qodercli');
    expect(s.launchCommand('sid', { cwd: '/tmp' }))
      .toEqual(['qodercli', '--session-id', 'sid', '--permission-mode', 'bypass_permissions']);
  });

  test('run 名 pid 活着才算 live，cwd 与状态取自 segments', async () => {
    const h = home();
    seed(h, 'alive', `2026-07-30T16-31-03-aaaa-p${process.pid}`, [
      JSON.stringify({ type: 'session.config.loaded', data: { project_root: '/Users/l/dev/foo' } }),
      JSON.stringify({ type: 'model.request.started', data: {} }),
    ]);
    seed(h, 'dead', '2026-07-30T16-31-03-bbbb-p99999999', [
      JSON.stringify({ type: 'session.config.loaded', data: { project_root: '/Users/l/dev/bar' } }),
    ]);
    const live = await new QoderCliSource(h, 'qodercli', 'bypass_permissions').readLiveSessions();
    expect(live.map(x => x.sessionId)).toEqual(['alive']);
    expect(live[0]).toMatchObject({ kernel: 'qodercli', cwd: '/Users/l/dev/foo', status: 'busy' });
  });

  test('同一会话有多个 run 时取名字最大的那个（run 名以 ISO 时间戳开头）', async () => {
    const h = home();
    seed(h, 's1', '2026-07-30T16-31-03-aaaa-p99999999', [
      JSON.stringify({ type: 'session.config.loaded', data: { project_root: '/old' } }),
    ]);
    seed(h, 's1', `2026-07-30T16-47-38-bbbb-p${process.pid}`, [
      JSON.stringify({ type: 'session.config.loaded', data: { project_root: '/new' } }),
    ]);
    const live = await new QoderCliSource(h, 'qodercli').readLiveSessions();
    expect(live).toHaveLength(1);
    expect(live[0]!.cwd).toBe('/new');
  });

  test('平铺转录归自己，transcript/ 下的不归自己', () => {
    const s = new QoderCliSource(home(), 'qodercli');
    expect(s.sessionIdForPath('-Users-l/abc.jsonl')).toBe('abc');
    expect(s.sessionIdForPath('-Users-l/transcript/abc.jsonl')).toBeNull();
  });
});
