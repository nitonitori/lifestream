import type { LiveSession, SessionStatus, SessionSummary, SessionOrigin } from './types.js';

export function deriveStatus(raw: any): SessionStatus {
  return raw?.status === 'busy' ? 'busy' : raw?.status === 'idle' ? 'idle' : 'unknown';
}

export function toLiveSession(raw: any, isPidAlive: (pid: number) => boolean): LiveSession | null {
  if (!raw || typeof raw.pid !== 'number' || typeof raw.sessionId !== 'string') return null;
  if (!isPidAlive(raw.pid)) return null;
  return {
    pid: raw.pid, sessionId: raw.sessionId, cwd: raw.cwd ?? '', name: raw.name,
    status: deriveStatus(raw), version: raw.version, kind: raw.kind,
    startedAt: raw.startedAt, updatedAt: raw.updatedAt,
  };
}

interface ManagedShape { sessionId: string; tmuxSession: string; cwd: string; origin: 'managed' | 'adopted'; }

export function buildSummaries(args: {
  live: LiveSession[];
  managed: ManagedShape[];
  tmuxNames: Set<string>;
  activity: Map<string, number>;
}): SessionSummary[] {
  const { live, managed, tmuxNames, activity } = args;
  const liveById = new Map(live.map(l => [l.sessionId, l]));
  const managedById = new Map(managed.map(m => [m.sessionId, m]));
  const ids = new Set<string>([...liveById.keys(), ...managedById.keys()]);
  const out: SessionSummary[] = [];
  for (const id of ids) {
    const l = liveById.get(id);
    const m = managedById.get(id);
    const controllable = !!(m && tmuxNames.has(m.tmuxSession));
    const origin: SessionOrigin = m ? m.origin : 'external';
    out.push({
      sessionId: id, name: l?.name, cwd: l?.cwd ?? m?.cwd ?? '',
      status: l?.status ?? 'unknown', origin, live: !!l, controllable,
      tmuxSession: m?.tmuxSession, pid: l?.pid, lastActivity: activity.get(id),
    });
  }
  return out.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
}
