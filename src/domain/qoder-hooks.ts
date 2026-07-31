import { join } from 'node:path';

export type HookTarget = 'qoder-ide' | 'qoderwork';
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

const withoutOurs = (groups: HookMatcher[]): HookMatcher[] =>
  groups.map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => !isOurs(h)) }))
        .filter(g => g.hooks.length > 0);

export function installHeartbeatHooks(settings: Settings, command: string): Settings {
  const next = structuredClone(settings) as Settings;
  next.hooks ??= {};
  for (const ev of HEARTBEAT_EVENTS) {
    const groups = withoutOurs(next.hooks[ev] ?? []);
    groups.push({ matcher: '*', hooks: [{ type: 'command', command, timeout: 5 }] });
    next.hooks[ev] = groups;
  }
  return next;
}

export function uninstallHeartbeatHooks(settings: Settings): Settings {
  const next = structuredClone(settings) as Settings;
  if (!next.hooks) return next;
  for (const ev of Object.keys(next.hooks)) {
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
    const hit = (settings.hooks?.[ev] ?? []).some(g => (g.hooks ?? []).some(isOurs));
    (hit ? installed : missing).push(ev);
  }
  return { installed, missing };
}
