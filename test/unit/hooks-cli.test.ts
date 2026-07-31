import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { heartbeatHookStatus, installHeartbeatHooks } from '../../src/domain/qoder-hooks.js';
import {
  heartbeatCommand, readSettings, scriptPathFromCommand,
} from '../../src/adapters/hooks-installer.js';
import { heartbeatPayload, isDirectRun, writeHeartbeat } from '../../src/hooks/lifestream-heartbeat.js';
import { runHooksCommand } from '../../src/hooks/cli.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'ls-hooks-'));

const mk = (root: string) => {
  const ide = join(root, 'qoder');
  const work = join(root, 'qoderwork');
  mkdirSync(ide, { recursive: true });
  mkdirSync(work, { recursive: true });
  const logs: string[] = [];
  return {
    ide, work, logs,
    deps: {
      homes: { 'qoder-ide': ide, qoderwork: work },
      stateDir: join(root, 'state'),
      script: () => '/x/dist/hooks/lifestream-heartbeat.js',
      now: () => 1785400000000,
      log: (s: string) => logs.push(s),
    },
  };
};

describe('heartbeatPayload', () => {
  test('camelCase 的 sessionId 与 hook_event_name', () => {
    const p = heartbeatPayload(JSON.stringify({
      sessionId: 'abc-1', cwd: '/Users/l/dev/foo', hook_event_name: 'PreToolUse',
    }), 42);
    expect(p).toEqual({ sessionId: 'abc-1', cwd: '/Users/l/dev/foo', event: 'PreToolUse', ts: 42 });
  });
  test('snake_case 的 session_id 也接受', () => {
    expect(heartbeatPayload(JSON.stringify({ session_id: 'abc', hook_event_name: 'Stop' }), 1)?.sessionId)
      .toBe('abc');
  });
  test('没有 sessionId 返回 null', () => {
    expect(heartbeatPayload(JSON.stringify({ hook_event_name: 'Stop' }), 1)).toBeNull();
  });
  test('sessionId 含路径分隔符时拒绝（会被拼进文件名）', () => {
    expect(heartbeatPayload(JSON.stringify({ sessionId: '../evil' }), 1)).toBeNull();
  });
  test('非 JSON 返回 null', () => {
    expect(heartbeatPayload('boom', 1)).toBeNull();
  });
});

describe('writeHeartbeat', () => {
  test('按 sessionId 写一个文件，目录自动创建', () => {
    const dir = join(tmp(), 'hb', 'qoderwork');
    writeHeartbeat(dir, { sessionId: 's1', cwd: '/tmp', event: 'Stop', ts: 7 });
    expect(JSON.parse(readFileSync(join(dir, 's1.json'), 'utf8')))
      .toEqual({ sessionId: 's1', cwd: '/tmp', event: 'Stop', ts: 7 });
  });
});

// 注入到别家 settings.json 的命令串可能含符号链接（dist 是软链等），
// 朴素的 argv[1] 字符串比较会让自执行守卫静默失效，心跳一个都不写。
describe('isDirectRun', () => {
  test('同一个文件经符号链接调用也认得出来', () => {
    const root = tmp();
    const real = join(root, 'lifestream-heartbeat.js');
    writeFileSync(real, '// 占位');
    const link = join(root, 'linked.js');
    symlinkSync(real, link);
    const url = pathToFileURL(real).href;
    expect(isDirectRun(real, url)).toBe(true);
    expect(isDirectRun(link, url)).toBe(true);
  });

  test('被 import（argv[1] 是别的文件）时不算直接执行', () => {
    const root = tmp();
    const real = join(root, 'lifestream-heartbeat.js');
    writeFileSync(real, '// 占位');
    const other = join(root, 'vitest.mjs');
    writeFileSync(other, '// 占位');
    expect(isDirectRun(other, pathToFileURL(real).href)).toBe(false);
    expect(isDirectRun(undefined, pathToFileURL(real).href)).toBe(false);
  });
});

describe('runHooksCommand', () => {
  test('install --target all 装两个 settings 并建两个心跳目录', () => {
    const root = tmp();
    const { deps, ide, work } = mk(root);
    expect(runHooksCommand(['install', '--target', 'all'], deps)).toBe(0);
    expect(heartbeatHookStatus(readSettings(join(ide, 'settings.json'))).missing).toEqual([]);
    expect(heartbeatHookStatus(readSettings(join(work, 'settings.json'))).missing).toEqual([]);
    expect(existsSync(join(root, 'state', 'heartbeats', 'qoder-ide'))).toBe(true);
    expect(existsSync(join(root, 'state', 'heartbeats', 'qoderwork'))).toBe(true);
  });

  test('两个 target 的心跳目录各不相同', () => {
    const root = tmp();
    const { deps, ide, work } = mk(root);
    runHooksCommand(['install', '--target', 'all'], deps);
    const cmd = (f: string) => JSON.stringify(readSettings(join(f, 'settings.json')));
    expect(cmd(ide)).toContain(join('heartbeats', 'qoder-ide'));
    expect(cmd(work)).toContain(join('heartbeats', 'qoderwork'));
  });

  test('先备份再改写：备份内容是改写前的原文', () => {
    const root = tmp();
    const { deps, work } = mk(root);
    const file = join(work, 'settings.json');
    const original = JSON.stringify({
      hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'loongsuite' }] }] },
    });
    writeFileSync(file, original);
    runHooksCommand(['install', '--target', 'qoderwork'], deps);
    const backups = readdirSync(work).filter(f => f.includes('lifestream-backup-'));
    expect(backups).toHaveLength(1);
    // 断言内容而不只是「文件存在」：否则实现改成「写后再备份」也照样过。
    expect(readFileSync(join(work, backups[0]), 'utf8')).toBe(original);
    expect(JSON.stringify(readSettings(file))).toContain('loongsuite');
  });

  test('--dry-run 不落盘、也不建心跳目录', () => {
    const root = tmp();
    const { deps, work, logs } = mk(root);
    expect(runHooksCommand(['install', '--target', 'qoderwork', '--dry-run'], deps)).toBe(0);
    expect(existsSync(join(work, 'settings.json'))).toBe(false);
    expect(existsSync(join(root, 'state', 'heartbeats', 'qoderwork'))).toBe(false);
    expect(logs.join('\n')).toContain('dry-run');
  });

  test('CLI 层幂等：连跑两次 install 只留一条我们的 hook', () => {
    const root = tmp();
    const { deps, work } = mk(root);
    runHooksCommand(['install', '--target', 'qoderwork'], deps);
    runHooksCommand(['install', '--target', 'qoderwork'], deps);
    const s = readSettings(join(work, 'settings.json')) as any;
    const mine = (s.hooks.Stop as any[]).flatMap(g => g.hooks)
      .filter((h: any) => h.command.includes('lifestream-heartbeat'));
    expect(mine).toHaveLength(1);
  });

  test('uninstall 只删自己那一项', () => {
    const root = tmp();
    const { deps, work } = mk(root);
    const file = join(work, 'settings.json');
    writeFileSync(file, JSON.stringify({
      hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'loongsuite' }] }] },
    }));
    runHooksCommand(['install', '--target', 'qoderwork'], deps);
    expect(runHooksCommand(['uninstall', '--target', 'qoderwork'], deps)).toBe(0);
    expect(heartbeatHookStatus(readSettings(file)).installed).toEqual([]);
    expect(JSON.stringify(readSettings(file))).toContain('loongsuite');
  });

  test('status 分别报出装了的与没装的 target', () => {
    const root = tmp();
    const { deps, logs } = mk(root);
    runHooksCommand(['install', '--target', 'qoderwork'], deps);
    expect(runHooksCommand(['status'], deps)).toBe(0);
    const out = logs.join('\n');
    expect(out).toMatch(/qoderwork: .*已装 5\/5/);
    expect(out).toMatch(/qoder-ide: .*已装 0\/5/);
  });

  // 「装了但没心跳」最常见的成因就是这个：注入的 dist 路径挪走了。
  test('status 报出注入的脚本已丢失', () => {
    const root = tmp();
    const { deps, work, logs } = mk(root);
    const gone = join(root, 'moved-away', 'dist', 'hooks', 'lifestream-heartbeat.js');
    writeFileSync(
      join(work, 'settings.json'),
      JSON.stringify(installHeartbeatHooks({}, heartbeatCommand(gone, join(root, 'hb')))),
    );
    expect(runHooksCommand(['status'], deps)).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain(gone);
    expect(out).toContain('已丢失');
  });

  test('缺 --target 或子命令不认识时返回 2 并打 usage', () => {
    const { deps, logs } = mk(tmp());
    expect(runHooksCommand(['install'], deps)).toBe(2);
    expect(runHooksCommand(['bogus'], deps)).toBe(2);
    expect(logs.join('\n')).toContain('lifestream hooks');
  });

  test('未知 --target 返回 2 并说明未知', () => {
    const { deps, logs } = mk(tmp());
    expect(runHooksCommand(['install', '--target', 'vscode'], deps)).toBe(2);
    expect(logs.join('\n')).toContain('未知');
  });

  test('settings.json 不是合法 JSON 时拒绝改写', () => {
    const root = tmp();
    const { deps, work } = mk(root);
    const file = join(work, 'settings.json');
    writeFileSync(file, '{ 坏掉的 json');
    expect(() => runHooksCommand(['install', '--target', 'qoderwork'], deps))
      .toThrow(/不是合法 JSON/);
    expect(readFileSync(file, 'utf8')).toBe('{ 坏掉的 json');
  });
});

describe('heartbeatCommand / scriptPathFromCommand', () => {
  test('往返：拼出的命令能解析回脚本路径（含空格也行）', () => {
    const script = '/a b/dist/hooks/lifestream-heartbeat.js';
    expect(scriptPathFromCommand(heartbeatCommand(script, '/c d/heartbeats/qoderwork')))
      .toBe(script);
  });

  // 双引号内 $ 与反引号仍会被 shell 解释，拼出来的命令会静默失效。
  test('路径含 shell 特殊字符时拒绝拼命令', () => {
    for (const bad of ['/a"b/x.js', '/a$b/x.js', '/a`b/x.js', '/a\\b/x.js'])
      expect(() => heartbeatCommand(bad, '/hb')).toThrow(/shell 特殊字符/);
    expect(() => heartbeatCommand('/ok/x.js', '/hb/`whoami`')).toThrow(/shell 特殊字符/);
  });
});
