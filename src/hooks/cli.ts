import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  HEARTBEAT_EVENTS, HOOK_TARGETS, type HookTarget,
  heartbeatHookStatus, installHeartbeatHooks, ourHeartbeatCommand, uninstallHeartbeatHooks,
} from '../domain/qoder-hooks.js';
import {
  heartbeatCommand, nodePathFromCommand, readSettings, scriptPathFromCommand, targetPaths,
  writeSettings,
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

// 最近一次心跳的时间：文件数为 0 或都 stat 不到时返回空串（不追加这段）。
function latestHeartbeat(dir: string, files: string[]): string {
  let newest = 0;
  for (const f of files) {
    try { newest = Math.max(newest, statSync(join(dir, f)).mtimeMs); } catch { /* 忽略 */ }
  }
  return newest > 0 ? `，最近 ${new Date(newest).toISOString()}` : '';
}

// 命令串里 node 与脚本都是安装时的绝对路径：脚本随目录挪走、node 随 nvm 升级/清理而消失，
// 任一丢了 hook 都静默死掉，所以两者分别报存在性。
const pathLine = (what: string, p: string): string =>
  `  ${what} ${p}：` + (existsSync(p) ? '存在' : '已丢失（心跳不会产生，重新 install 即可修）');

export function runHooksCommand(args: string[], d: HooksDeps): number {
  const sub = args[0];

  if (sub === 'status') {
    for (const t of HOOK_TARGETS) {
      const p = targetPaths(d.homes, d.stateDir, t);
      let line: string;
      const extra: string[] = [];
      try {
        const settings = readSettings(p.settings);
        const st = heartbeatHookStatus(settings);
        line = `已装 ${st.installed.length}/${HEARTBEAT_EVENTS.length}`
          + (st.missing.length > 0 ? `，缺 ${st.missing.join(',')}` : '');
        // 「装了但没心跳」最常见的成因：settings 里那条命令写的是安装时 cwd 下 dist 的绝对路径，
        // 目录挪走或没 build 就静默哑掉。所以 status 得报出脚本还在不在。
        const cmd = ourHeartbeatCommand(settings);
        const script = cmd ? scriptPathFromCommand(cmd) : null;
        const node = cmd ? nodePathFromCommand(cmd) : null;
        if (script) extra.push(pathLine('注入的脚本', script));
        if (node) extra.push(pathLine('注入的 node', node));
      } catch (e) { line = `读取失败：${(e as Error).message}`; }
      const files = safeReaddir(p.heartbeatDir).filter(f => f.endsWith('.json'));
      d.log(`${t}: ${p.settings} — ${line}`);
      for (const l of extra) d.log(l);
      d.log(`  心跳目录 ${p.heartbeatDir}：${files.length} 个文件`
        + latestHeartbeat(p.heartbeatDir, files));
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
