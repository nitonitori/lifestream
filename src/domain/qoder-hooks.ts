import { join } from 'node:path';
import type { Kernel } from './types.js';

// 心跳目录按 target 分，而读取方按 kernel 找目录：绑上 Extract，Kernel 改名时这里编译期就炸。
export type HookTarget = Extract<Kernel, 'qoder-ide' | 'qoderwork'>;
export const HOOK_TARGETS: HookTarget[] = ['qoder-ide', 'qoderwork'];

export const HEARTBEAT_EVENTS = [
  'SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop',
] as const;
export type HeartbeatEvent = typeof HEARTBEAT_EVENTS[number];

export const HEARTBEAT_MARKER = 'lifestream-heartbeat';

export interface HookEntry { type: string; command: string; timeout?: number }
export interface HookMatcher { matcher?: string; hooks: HookEntry[] }
export interface Settings { hooks?: Record<string, HookMatcher[]>; [k: string]: unknown }

export function heartbeatDir(stateDir: string, target: HookTarget): string {
  return join(stateDir, 'heartbeats', target);
}

const isOurs = (h: HookEntry): boolean =>
  typeof h?.command === 'string' && h.command.includes(HEARTBEAT_MARKER);

// 只过滤组里我们那几条；`hooks` 不是数组的组（别家可能写成字符串等非标准形状）原样保留，
// 否则 `{...g}` 展开后会因“没有 hooks 数组”被当成空组丢掉。
// 只丢「原本非空、被我们过滤成空」的组：他厂本来就写 hooks: [] 的条目要原样留着，
// 否则 install/uninstall 会顺手删掉不属于我们的东西。
const withoutOurs = (groups: HookMatcher[]): HookMatcher[] => {
  const out: HookMatcher[] = [];
  for (const g of groups) {
    if (!Array.isArray(g?.hooks)) { out.push(g); continue; }
    const hooks = g.hooks.filter(h => !isOurs(h));
    if (hooks.length > 0 || g.hooks.length === 0) out.push({ ...g, hooks });
  }
  return out;
};

// 只碰真含我们标记的事件：别家可能留着 hooks 为空数组的条目或非标准形状的组，
// 无条件跑一遍 withoutOurs 会把它们连键一起删掉。
const hasOurs = (groups: unknown): boolean =>
  Array.isArray(groups) && groups.some((g: any) => Array.isArray(g?.hooks) && g.hooks.some(isOurs));

// settings.hooks 只接受普通对象：数组会被 JSON.stringify 丢掉具名属性、落盘成 {"hooks":[]}，
// 而命令行仍报「已安装」—— 与其静默毁掉用户配置，不如显式拒绝。
function assertHooksShape(s: Settings): void {
  if (s.hooks === undefined) return;
  if (s.hooks === null || typeof s.hooks !== 'object' || Array.isArray(s.hooks))
    throw new Error('settings.hooks 结构异常（不是对象），拒绝改写');
}

export function installHeartbeatHooks(settings: Settings, command: string): Settings {
  const next = structuredClone(settings) as Settings;
  assertHooksShape(next);
  next.hooks ??= {};
  for (const ev of HEARTBEAT_EVENTS) {
    // 事件值不是数组时也显式拒绝：直接改写会把用户原有的值覆盖掉。
    const cur = next.hooks[ev];
    if (cur !== undefined && !Array.isArray(cur))
      throw new Error(`settings.hooks.${ev} 结构异常（不是数组），拒绝改写`);
    const groups = withoutOurs(cur ?? []);
    groups.push({ matcher: '*', hooks: [{ type: 'command', command, timeout: 5 }] });
    next.hooks[ev] = groups;
  }
  return next;
}

export function uninstallHeartbeatHooks(settings: Settings): Settings {
  const next = structuredClone(settings) as Settings;
  assertHooksShape(next);
  if (!next.hooks) return next;
  for (const ev of Object.keys(next.hooks)) {
    if (!hasOurs(next.hooks[ev])) continue;
    const groups = withoutOurs(next.hooks[ev] ?? []);
    if (groups.length > 0) next.hooks[ev] = groups;
    else delete next.hooks[ev];
  }
  return next;
}

export function heartbeatHookStatus(
  settings: Settings,
): { installed: HeartbeatEvent[]; missing: HeartbeatEvent[] } {
  const installed: HeartbeatEvent[] = [];
  const missing: HeartbeatEvent[] = [];
  for (const ev of HEARTBEAT_EVENTS) {
    const hit = (settings.hooks?.[ev] ?? [])
      .some(g => (Array.isArray(g?.hooks) ? g.hooks : []).some(isOurs));
    (hit ? installed : missing).push(ev);
  }
  return { installed, missing };
}

// status 要靠它判断注入的脚本是否还在原处：取任一事件里我们那条命令即可（五个事件写的是同一条）。
export function ourHeartbeatCommand(settings: Settings): string | null {
  for (const ev of HEARTBEAT_EVENTS) {
    for (const g of settings.hooks?.[ev] ?? []) {
      const hit = (Array.isArray(g?.hooks) ? g.hooks : []).find(isOurs);
      if (hit) return hit.command;
    }
  }
  return null;
}
