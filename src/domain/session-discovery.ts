import type { Kernel, LiveSession, SessionStatus, SessionSummary, SessionOrigin } from './types.js';

export function deriveStatus(raw: any): SessionStatus {
  return raw?.status === 'busy' ? 'busy' : raw?.status === 'idle' ? 'idle' : 'unknown';
}

export function toLiveSession(raw: any, kernel: Kernel, isPidAlive: (pid: number) => boolean): LiveSession | null {
  if (!raw || typeof raw.pid !== 'number' || typeof raw.sessionId !== 'string') return null;
  if (!isPidAlive(raw.pid)) return null;
  return {
    pid: raw.pid, kernel, sessionId: raw.sessionId, cwd: raw.cwd ?? '', name: raw.name,
    status: deriveStatus(raw), version: raw.version, kind: raw.kind,
    startedAt: raw.startedAt, updatedAt: raw.updatedAt,
  };
}

interface ManagedShape { sessionId: string; tmuxSession: string; cwd: string; kernel: Kernel; origin: 'managed' | 'adopted'; createdAt?: number; }

export function buildSummaries(args: {
  live: LiveSession[];
  managed: ManagedShape[];
  tmuxNames: Set<string>;
  activity: Map<string, number>;
  adoptable: Set<Kernel>;
}): SessionSummary[] {
  const { live, managed, tmuxNames, activity, adoptable } = args;
  const liveById = new Map(live.map(l => [l.sessionId, l]));
  const managedById = new Map(managed.map(m => [m.sessionId, m]));
  const ids = new Set<string>([...liveById.keys(), ...managedById.keys()]);
  const out: SessionSummary[] = [];
  for (const id of ids) {
    const l = liveById.get(id);
    const m = managedById.get(id);
    const controllable = !!(m && tmuxNames.has(m.tmuxSession));
    const origin: SessionOrigin = m ? m.origin : 'external';
    // id 集合是 live ∪ managed，两者必有其一
    const kernel = l?.kernel ?? m!.kernel;
    out.push({
      sessionId: id, kernel, name: l?.name, cwd: l?.cwd || m?.cwd || '',
      status: l?.status ?? 'unknown', origin, live: !!l, controllable,
      adoptable: adoptable.has(kernel),
      tmuxSession: m?.tmuxSession, pid: l?.pid, lastActivity: activity.get(id), createdAt: m?.createdAt,
    });
  }
  // 无转录活动的受控新会话按 createdAt 排在前，避免"看起来没启动"
  return out.sort((a, b) => (b.lastActivity ?? b.createdAt ?? 0) - (a.lastActivity ?? a.createdAt ?? 0));
}
