import { describe, expect, test } from 'vitest';
import {
  HEARTBEAT_EVENTS, heartbeatHookStatus, installHeartbeatHooks, uninstallHeartbeatHooks,
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
});

describe('heartbeatHookStatus', () => {
  test('部分安装时报出缺哪几个', () => {
    const s = installHeartbeatHooks({}, CMD) as any;
    delete s.hooks.Stop;
    expect(heartbeatHookStatus(s).missing).toEqual(['Stop']);
  });
});
