import { describe, expect, test } from 'vitest';
import {
  HEARTBEAT_EVENTS, heartbeatHookStatus, installHeartbeatHooks, ourHeartbeatCommand,
  uninstallHeartbeatHooks,
} from '../../src/domain/qoder-hooks.js';

const CMD = '"/usr/bin/node" "/x/dist/hooks/lifestream-heartbeat.js" --dir "/y/qoderwork"';
const FOREIGN = {
  hooks: {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'loongsuite-hook --pre' }] }],
    Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'r2c-scan' }] }],
  },
};

describe('installHeartbeatHooks', () => {
  test('五个事件都装上', () => {
    const out = heartbeatHookStatus(installHeartbeatHooks({}, CMD));
    expect(out.installed).toEqual([...HEARTBEAT_EVENTS]);
    expect(out.missing).toEqual([]);
  });

  test('幂等：装两遍不产生重复条目', () => {
    const once = installHeartbeatHooks({}, CMD);
    const twice = installHeartbeatHooks(once, CMD);
    const count = (s: any) => (s.hooks.PreToolUse as any[])
      .flatMap(g => g.hooks).filter((h: any) => h.command.includes('lifestream-heartbeat')).length;
    expect(count(once)).toBe(1);
    expect(count(twice)).toBe(1);
  });

  test('他厂条目一个不动', () => {
    const out = installHeartbeatHooks(FOREIGN, CMD) as any;
    const cmds = (ev: string) => (out.hooks[ev] as any[]).flatMap(g => g.hooks).map((h: any) => h.command);
    expect(cmds('PreToolUse')).toContain('loongsuite-hook --pre');
    expect(cmds('Stop')).toContain('r2c-scan');
  });

  test('不修改传入的对象', () => {
    const before = JSON.stringify(FOREIGN);
    installHeartbeatHooks(FOREIGN, CMD);
    expect(JSON.stringify(FOREIGN)).toBe(before);
  });

  test('命令变了（比如换了心跳目录）也只留一条', () => {
    const once = installHeartbeatHooks({}, CMD);
    const out = installHeartbeatHooks(once, CMD.replace('/y/qoderwork', '/y/qoder-ide')) as any;
    const mine = (out.hooks.Stop as any[]).flatMap(g => g.hooks)
      .filter((h: any) => h.command.includes('lifestream-heartbeat'));
    expect(mine).toHaveLength(1);
    expect(mine[0].command).toContain('/y/qoder-ide');
  });

  // hooks 是数组时若照常改写，JSON.stringify 会丢掉具名属性、落盘成 {"hooks":[]}，
  // 而命令行仍报「已安装」—— 必须显式拒绝而不是静默毁配置。
  test('hooks 是数组时拒绝改写', () => {
    expect(() => installHeartbeatHooks({ hooks: [] } as any, CMD)).toThrow(/结构异常/);
    expect(() => installHeartbeatHooks({ hooks: 'abc' } as any, CMD)).toThrow(/结构异常/);
  });

  test('事件值不是数组时拒绝改写（否则覆盖掉用户原值）', () => {
    expect(() => installHeartbeatHooks({ hooks: { Stop: 'x' } } as any, CMD)).toThrow(/结构异常/);
  });
});

describe('uninstallHeartbeatHooks', () => {
  test('只删自己那一项，他厂条目留着', () => {
    const installed = installHeartbeatHooks(FOREIGN, CMD);
    const out = uninstallHeartbeatHooks(installed) as any;
    expect(heartbeatHookStatus(out).installed).toEqual([]);
    const cmds = (ev: string) => (out.hooks[ev] ?? []).flatMap((g: any) => g.hooks).map((h: any) => h.command);
    expect(cmds('PreToolUse')).toEqual(['loongsuite-hook --pre']);
    expect(cmds('Stop')).toEqual(['r2c-scan']);
  });

  test('卸完后不留空的事件键', () => {
    const out = uninstallHeartbeatHooks(installHeartbeatHooks({}, CMD)) as any;
    expect(Object.keys(out.hooks)).toEqual([]);
  });

  test('对没装过的 settings 是空操作', () => {
    expect(uninstallHeartbeatHooks({})).toEqual({});
  });

  // 他厂本来就写 hooks: [] 的条目必须原样留着；这些组要放在**我们的**事件里、且同一事件里
  // 还有我们那条 hook，否则 hasOurs 会提前 continue，withoutOurs 根本不执行（用例会假绿）。
  test('保留同一事件里他厂 hooks 为空数组的条目', () => {
    const s = {
      hooks: {
        Stop: [
          { matcher: 'keep-me', hooks: [] },
          { matcher: '*', hooks: [{ type: 'command', command: CMD }] },
        ],
      },
    };
    const out = uninstallHeartbeatHooks(s) as any;
    expect(Object.keys(out.hooks)).toContain('Stop');
    expect(out.hooks.Stop).toEqual([{ matcher: 'keep-me', hooks: [] }]);
  });

  test('保留同一事件里他厂非对象形状的组', () => {
    const s = {
      hooks: {
        Stop: [
          'foreign-string',
          { matcher: 'weird', hooks: 'x' },
          { matcher: '*', hooks: [{ type: 'command', command: CMD }] },
        ],
      },
    } as any;
    const out = uninstallHeartbeatHooks(s) as any;
    expect(out.hooks.Stop).toEqual(['foreign-string', { matcher: 'weird', hooks: 'x' }]);
  });

  test('install 也不吞掉他厂 hooks 为空数组的条目', () => {
    const s = { hooks: { Stop: [{ matcher: 'keep-me', hooks: [] }] } };
    const installed = installHeartbeatHooks(s, CMD) as any;
    expect(installed.hooks.Stop).toContainEqual({ matcher: 'keep-me', hooks: [] });
    const out = uninstallHeartbeatHooks(installed) as any;
    expect(out.hooks.Stop).toEqual([{ matcher: 'keep-me', hooks: [] }]);
  });

  test('hooks 是数组时拒绝改写', () => {
    expect(() => uninstallHeartbeatHooks({ hooks: [] } as any)).toThrow(/结构异常/);
  });
});

describe('heartbeatHookStatus', () => {
  test('部分安装时报出缺哪几个', () => {
    const s = installHeartbeatHooks({}, CMD) as any;
    delete s.hooks.Stop;
    expect(heartbeatHookStatus(s).missing).toEqual(['Stop']);
  });

  // 组的 hooks 是字符串等非数组形状时，`.some` 会抛 TypeError，status 直接崩。
  test('组的 hooks 不是数组时不抛，算作没装', () => {
    const s = { hooks: { Stop: [{ matcher: '*', hooks: 'x' }] } } as any;
    expect(() => heartbeatHookStatus(s)).not.toThrow();
    expect(heartbeatHookStatus(s).missing).toContain('Stop');
  });
});

describe('ourHeartbeatCommand', () => {
  test('装过则返回注入的那条命令', () => {
    expect(ourHeartbeatCommand(installHeartbeatHooks(FOREIGN, CMD))).toBe(CMD);
  });
  test('没装过返回 null', () => {
    expect(ourHeartbeatCommand(FOREIGN)).toBeNull();
    expect(ourHeartbeatCommand({})).toBeNull();
  });
});
