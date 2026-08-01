import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ClaudeSource } from '../../src/adapters/sources/claude.js';
import { QoderCliSource } from '../../src/adapters/sources/qoder-cli.js';
import { QoderIdeSource, QoderWorkSource } from '../../src/adapters/sources/qoder-desktop.js';
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
  // 下面的用例拿本进程 pid 当「活 pid」，要过归属闸就得把 bin 传成本进程在 ps 里的名字。
  // 不能硬编码 'node'：ps -o comm= 给的是进程标题，而 vitest 的 worker 会把它改写成
  // `node (vitest 1)`，硬编码会让本该 live 的用例被归属闸挡掉。故运行时问一次 ps。
  // 单列 comm 不截断，与 pidOwnsRun 里从 `lstart=,comm=` 末列取到的值一致。
  const selfBin = execFileSync('ps', ['-p', String(process.pid), '-o', 'comm='], { encoding: 'utf8' }).trim();

  // 返回写入的 run 文件路径，供「开机时间闸」的测试 backdate mtime。
  const seed = (h: string, sessionId: string, run: string, lines: string[]) => {
    const dir = join(h, 'logs', 'sessions', '-Users-l-dev-foo', sessionId, 'segments');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${run}.jsonl`);
    writeFileSync(p, lines.join('\n') + '\n');
    return p;
  };

  test('kernel 是 qodercli 且用 qodercli 方言', () => {
    const s = new QoderCliSource(home(), 'qodercli', 'bypass_permissions');
    expect(s.kernel).toBe('qodercli');
    expect(s.launchCommand('sid', { cwd: '/tmp' }))
      .toEqual(['qodercli', '--session-id', 'sid', '--permission-mode', 'bypass_permissions']);
  });

  // 传 selfBin 的几条会真的走通 ps，且 vitest 进程启动于 seed 文件创建之前，
  // 因此顺带正向覆盖了归属闸的两半（进程名匹配 + 启动早于 run 文件创建）。
  test('run 名 pid 活着才算 live，cwd 取自 segments、状态一律 unknown', async () => {
    const h = home();
    seed(h, 'alive', `2026-07-30T16-31-03-aaaa-p${process.pid}`, [
      JSON.stringify({ type: 'session.config.loaded', data: { project_root: '/Users/l/dev/foo' } }),
      JSON.stringify({ type: 'model.request.started', data: {} }),
    ]);
    seed(h, 'dead', '2026-07-30T16-31-03-bbbb-p99999999', [
      JSON.stringify({ type: 'session.config.loaded', data: { project_root: '/Users/l/dev/bar' } }),
    ]);
    const live = await new QoderCliSource(h, selfBin, 'bypass_permissions').readLiveSessions();
    expect(live.map(x => x.sessionId)).toEqual(['alive']);
    expect(live[0]).toMatchObject({ kernel: 'qodercli', cwd: '/Users/l/dev/foo', status: 'unknown' });
  });

  test('同一会话有多个 run 时取名字最大的那个（run 名以 ISO 时间戳开头）', async () => {
    const h = home();
    seed(h, 's1', '2026-07-30T16-31-03-aaaa-p99999999', [
      JSON.stringify({ type: 'session.config.loaded', data: { project_root: '/old' } }),
    ]);
    seed(h, 's1', `2026-07-30T16-47-38-bbbb-p${process.pid}`, [
      JSON.stringify({ type: 'session.config.loaded', data: { project_root: '/new' } }),
    ]);
    const live = await new QoderCliSource(h, selfBin).readLiveSessions();
    expect(live).toHaveLength(1);
    expect(live[0]!.cwd).toBe('/new');
  });

  test('pid 活着但进程名不是本 source 的 bin，不算 live（pid 复用防护）', async () => {
    const h = home();
    seed(h, 'reused', `2026-07-30T16-31-03-cccc-p${process.pid}`, [
      JSON.stringify({ type: 'session.config.loaded', data: { project_root: '/x' } }),
    ]);
    const live = await new QoderCliSource(h, 'qodercli').readLiveSessions();
    expect(live).toEqual([]);
  });

  test('pid 活着、名字也对，但进程启动晚于 run 文件创建，不算 live（同开机内 pid 复用防护）', async () => {
    const h = home();
    // 先建 run 文件（占位 pid），等过 1s（ps lstart 精度是秒），再起子进程并把文件改名带上它的 pid。
    // rename 保留 birthtime，于是「文件先创建、进程后启动」这个幽灵场景被精确复现。
    const p = seed(h, 'ghost', '2026-07-30T16-31-03-gggg-p1', [
      JSON.stringify({ type: 'session.config.loaded', data: { project_root: '/x' } }),
    ]);
    await new Promise(r => setTimeout(r, 1100));
    const child = spawn('/bin/sleep', ['60']);
    try {
      // spawn 失败时 child.pid 是 undefined，文件名会变成 -pundefined 而被 pidFromRunName 挡掉
      // —— 那样这条用例就算归属闸失效也照样通过（假绿），故先钉住确实拿到了 pid。
      expect(child.pid).toBeGreaterThan(0);
      renameSync(p, p.replace('-p1.jsonl', `-p${child.pid}.jsonl`));
      const live = await new QoderCliSource(h, 'sleep').readLiveSessions();
      expect(live).toEqual([]);
    } finally { child.kill(); }
  });

  test('run 日志在本次开机之前写的，不算 live（pid 复用防护）', async () => {
    const h = home();
    const p = seed(h, 'stale', `2026-07-30T16-31-03-dddd-p${process.pid}`, [
      JSON.stringify({ type: 'session.config.loaded', data: { project_root: '/x' } }),
    ]);
    const old = new Date('2000-01-01T00:00:00Z');
    utimesSync(p, old, old);
    const live = await new QoderCliSource(h, selfBin).readLiveSessions();
    expect(live).toEqual([]);
  });

  test('run 名没有 -p 后缀则跳过', async () => {
    const h = home();
    seed(h, 'nopid', '2026-07-30T16-31-03-eeee', [
      JSON.stringify({ type: 'session.config.loaded', data: { project_root: '/x' } }),
    ]);
    const live = await new QoderCliSource(h, selfBin).readLiveSessions();
    expect(live).toEqual([]);
  });

  test('segments 里没有 project_root 时 cwd 落成空串', async () => {
    const h = home();
    seed(h, 'nocwd', `2026-07-30T16-31-03-ffff-p${process.pid}`, [
      JSON.stringify({ type: 'turn.started', data: {} }),
    ]);
    const live = await new QoderCliSource(h, selfBin).readLiveSessions();
    expect(live).toHaveLength(1);
    expect(live[0]!.cwd).toBe('');
  });

  test('平铺转录归自己，transcript/ 下的不归自己', () => {
    const s = new QoderCliSource(home(), 'qodercli');
    expect(s.sessionIdForPath('-Users-l/abc.jsonl')).toBe('abc');
    expect(s.sessionIdForPath('-Users-l/transcript/abc.jsonl')).toBeNull();
  });
});

const NOW = 1785400000000;
const TTL = 30 * 60 * 1000;

const hbFile = (dir: string, sessionId: string, event: string, ts = NOW) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.json`),
    JSON.stringify({ sessionId, cwd: '/Users/l/dev/foo', event, ts }));
};

const ideTranscript = (h: string, name: string) => {
  const dir = join(h, 'projects', '-Users-l-dev-foo', 'transcript');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), '{}\n');
};

describe('QoderWorkSource', () => {
  const mk = (h: string, hb: string) =>
    new QoderWorkSource({ home: h, heartbeatDir: hb, ttlMs: TTL, now: () => NOW });

  test('只读：isControllable 为 false', () => {
    expect(isControllable(mk(home(), home()))).toBe(false);
  });

  test('心跳给出枚举、cwd 与状态', async () => {
    const h = home(); const hb = join(home(), 'hb');
    hbFile(hb, 'w1', 'PreToolUse');
    const live = await mk(h, hb).readLiveSessions();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      sessionId: 'w1', kernel: 'qoderwork', cwd: '/Users/l/dev/foo', status: 'busy',
    });
  });

  test('超出 TTL 的不列出', async () => {
    const h = home(); const hb = join(home(), 'hb');
    hbFile(hb, 'stale', 'PreToolUse', NOW - TTL - 1);
    expect(await mk(h, hb).readLiveSessions()).toEqual([]);
  });

  test('Stop 之后仍列出（一轮对话结束不等于会话结束），状态 idle', async () => {
    const h = home(); const hb = join(home(), 'hb');
    hbFile(hb, 'stopped', 'Stop');
    const live = await mk(h, hb).readLiveSessions();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ sessionId: 'stopped', status: 'idle' });
  });

  test('心跳目录里的非 .json 文件被忽略', async () => {
    const h = home(); const hb = join(home(), 'hb');
    hbFile(hb, 'w1', 'PostToolUse');
    mkdirSync(hb, { recursive: true });
    writeFileSync(join(hb, 'w2.txt'),
      JSON.stringify({ sessionId: 'w2', cwd: '/Users/l/dev/foo', event: 'PostToolUse', ts: NOW }));
    expect((await mk(h, hb).readLiveSessions()).map(x => x.sessionId)).toEqual(['w1']);
  });

  test('单个心跳文件内容坏掉只跳过它，不影响同目录其它会话', async () => {
    const h = home(); const hb = join(home(), 'hb');
    hbFile(hb, 'good', 'PostToolUse');
    mkdirSync(hb, { recursive: true });
    writeFileSync(join(hb, 'bad.json'), 'boom');
    expect((await mk(h, hb).readLiveSessions()).map(x => x.sessionId)).toEqual(['good']);
  });

  test('没有转录的新会话也列出（不做转录过滤）', async () => {
    const h = home(); const hb = join(home(), 'hb');
    hbFile(hb, 'brandnew', 'SessionStart');
    expect((await mk(h, hb).readLiveSessions()).map(x => x.sessionId)).toEqual(['brandnew']);
  });
});

describe('QoderIdeSource', () => {
  const mk = (h: string, hb: string) =>
    new QoderIdeSource({ home: h, heartbeatDir: hb, ttlMs: TTL, now: () => NOW });

  test('只读：isControllable 为 false', () => {
    expect(isControllable(mk(home(), home()))).toBe(false);
  });

  test('只认 transcript/ 下有转录的心跳（滤掉共用 settings 带来的 qodercli 会话）', async () => {
    const h = home(); const hb = join(home(), 'hb');
    ideTranscript(h, 'ide1.jsonl');
    hbFile(hb, 'ide1', 'PostToolUse');
    hbFile(hb, 'cli1', 'PostToolUse');       // qodercli 的会话：transcript/ 下没有它
    const live = await mk(h, hb).readLiveSessions();
    expect(live.map(x => x.sessionId)).toEqual(['ide1']);
    expect(live[0]!.kernel).toBe('qoder-ide');
  });

  test('Quest 会话的 sessionId 自带 .session.execution，转录名就是 <id>.jsonl', async () => {
    const h = home(); const hb = join(home(), 'hb');
    const id = 'task-0123456789abcdef0123.session.execution';
    ideTranscript(h, `${id}.jsonl`);
    hbFile(hb, id, 'PreToolUse');
    expect((await mk(h, hb).readLiveSessions()).map(x => x.sessionId)).toEqual([id]);
    expect(await mk(h, hb).locateTranscript(id)).toContain(`${id}.jsonl`);
  });

  test('sessionIdForPath 只认 transcript/ 一层，只剥 .jsonl', () => {
    const s = mk(home(), home());
    expect(s.sessionIdForPath('-Users-l/transcript/abc.jsonl')).toBe('abc');
    expect(s.sessionIdForPath('-Users-l/transcript/task-0123456789abcdef0123.session.execution.jsonl'))
      .toBe('task-0123456789abcdef0123.session.execution');
    expect(s.sessionIdForPath('-Users-l/abc.jsonl')).toBeNull();
    expect(s.sessionIdForPath('-Users-l/transcript/abc.json')).toBeNull();
  });
});
