import { mkdirSync } from 'node:fs';
import {
  HEARTBEAT_EVENTS, HOOK_TARGETS, type HookTarget,
  heartbeatHookStatus, installHeartbeatHooks, uninstallHeartbeatHooks,
} from '../domain/qoder-hooks.js';
import {
  heartbeatCommand, readSettings, targetPaths, writeSettings,
} from '../adapters/hooks-installer.js';
import { safeReaddir } from '../adapters/sources/base.js';

const USAGE = 'usage: lifestream hooks <install|uninstall|status> --target <qoder-ide|qoderwork|all> [--dry-run]';

export interface HooksDeps {
  homes: Record<HookTarget, string>;
  stateDir: string;
  script: () => string;
  now: () => number;
  log: (s: string) => void;
}

export function runHooksCommand(args: string[], d: HooksDeps): number {
  const sub = args[0];

  if (sub === 'status') {
    for (const t of HOOK_TARGETS) {
      const p = targetPaths(d.homes, d.stateDir, t);
      let line: string;
      try {
        const st = heartbeatHookStatus(readSettings(p.settings));
        line = `已装 ${st.installed.length}/${HEARTBEAT_EVENTS.length}`
          + (st.missing.length > 0 ? `，缺 ${st.missing.join(',')}` : '');
      } catch (e) { line = `读取失败：${(e as Error).message}`; }
      const n = safeReaddir(p.heartbeatDir).filter(f => f.endsWith('.json')).length;
      d.log(`${t}: ${p.settings} — ${line}`);
      d.log(`  心跳目录 ${p.heartbeatDir}：${n} 个文件`);
    }
    return 0;
  }

  if (sub !== 'install' && sub !== 'uninstall') { d.log(USAGE); return 2; }

  const i = args.indexOf('--target');
  const raw = i >= 0 ? args[i + 1] : undefined;
  if (!raw) { d.log(USAGE); return 2; }
  const targets = raw === 'all' ? HOOK_TARGETS : HOOK_TARGETS.filter(t => t === raw);
  if (targets.length === 0) { d.log(`未知 --target: ${raw}`); d.log(USAGE); return 2; }

  const dryRun = args.includes('--dry-run');
  for (const t of targets) {
    const p = targetPaths(d.homes, d.stateDir, t);
    const before = readSettings(p.settings);
    const after = sub === 'install'
      ? installHeartbeatHooks(before, heartbeatCommand(d.script(), p.heartbeatDir))
      : uninstallHeartbeatHooks(before);
    if (dryRun) {
      d.log(`dry-run（未落盘）${p.settings} 的 hooks 将变为：`);
      d.log(JSON.stringify(after.hooks ?? {}, null, 2));
      continue;
    }
    const backup = writeSettings(p.settings, after, d.now());
    if (sub === 'install') mkdirSync(p.heartbeatDir, { recursive: true });
    d.log(`${sub === 'install' ? '已安装' : '已卸载'} ${t}：${p.settings}`
      + (backup ? `（备份 ${backup}）` : ''));
  }
  return 0;
}
