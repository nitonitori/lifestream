import { EventEmitter } from 'node:events';
import type { TmuxAdapter, ClaudeHomeAdapter, ManagedRegistry, Clock, ManagedEntry } from '../ports/index.js';
import type { SessionSummary, SessionDetail, TranscriptEvent, PlaneEvent } from './types.js';
import { NotFoundError, NotControllableError, ConflictError } from './errors.js';
import { parseTranscript } from './transcript-parser.js';
import { buildSummaries } from './session-discovery.js';

export function tmuxNameFor(id: string) { return 'lifestream-' + id.slice(0, 8); }

interface Deps {
  tmux: TmuxAdapter;
  home: ClaudeHomeAdapter;
  registry: ManagedRegistry;
  clock: Clock;
  claudeBin: string;
  tmuxSocket: string;
  newSessionId: () => string;
  pollIntervalMs?: number;
}

export class ControlPlane extends EventEmitter {
  private lastSeen = new Set<string>();
  private emittedUuids = new Map<string, Set<string>>();
  private timer?: NodeJS.Timeout;
  private unwatch?: () => void;

  constructor(private d: Deps) { super(); }

  private emitEvent(e: PlaneEvent) { this.emit('event', e); }

  private async activityMap(ids: Iterable<string>): Promise<Map<string, number>> {
    const activity = new Map<string, number>();
    for (const id of ids) {
      const p = await this.d.home.locateTranscript(id);
      if (!p) continue;
      const last = parseTranscript(await this.d.home.readTranscript(p)).at(-1);
      if (last?.ts) activity.set(id, last.ts);
    }
    return activity;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const live = await this.d.home.readLiveSessions();
    const managed = await this.d.registry.list();
    const tmuxNames = new Set((await this.d.tmux.listSessions()).map(t => t.name));
    const ids = new Set<string>([...live.map(l => l.sessionId), ...managed.map(m => m.sessionId)]);
    const activity = await this.activityMap(ids);
    return buildSummaries({ live, managed, tmuxNames, activity });
  }

  async getSession(id: string): Promise<SessionDetail> {
    const s = (await this.listSessions()).find(x => x.sessionId === id);
    if (!s) throw new NotFoundError('session not found: ' + id);
    const path = await this.d.home.locateTranscript(id);
    const count = path ? parseTranscript(await this.d.home.readTranscript(path)).length : 0;
    return { ...s, transcriptPath: path ?? undefined, messageCount: count };
  }

  async getMessages(id: string, opts: { sinceUuid?: string; limit?: number } = {}): Promise<TranscriptEvent[]> {
    const path = await this.d.home.locateTranscript(id);
    if (!path) return [];
    let events = parseTranscript(await this.d.home.readTranscript(path));
    if (opts.sinceUuid) {
      const idx = events.findIndex(e => e.uuid === opts.sinceUuid);
      if (idx >= 0) events = events.slice(idx + 1);
    }
    if (opts.limit && events.length > opts.limit) events = events.slice(-opts.limit);
    return events;
  }

  async sendMessage(id: string, text: string): Promise<void> {
    const entry = await this.d.registry.get(id);
    if (entry && await this.d.tmux.hasSession(entry.tmuxSession)) {
      await this.d.tmux.sendText(entry.tmuxSession, text);
      return;
    }
    const live = await this.d.home.readLiveSessions();
    if (live.some(l => l.sessionId === id)) {
      throw new NotControllableError('session is external/not managed; adopt it first: ' + id);
    }
    throw new NotFoundError('session not found: ' + id);
  }

  async createSession(opts: { cwd: string; name?: string; model?: string; permissionMode?: string; initialPrompt?: string }): Promise<SessionSummary> {
    const id = this.d.newSessionId();
    const name = tmuxNameFor(id);
    const cmd = [this.d.claudeBin, '--session-id', id];
    if (opts.model) cmd.push('--model', opts.model);
    if (opts.permissionMode) cmd.push('--permission-mode', opts.permissionMode);
    if (opts.name) cmd.push('--name', opts.name);
    await this.d.tmux.newSession(name, opts.cwd, cmd);
    const entry: ManagedEntry = { sessionId: id, tmuxSession: name, cwd: opts.cwd, origin: 'managed', createdAt: this.d.clock.now() };
    await this.d.registry.put(entry);
    if (opts.initialPrompt) await this.d.tmux.sendText(name, opts.initialPrompt);
    return { sessionId: id, name: opts.name, cwd: opts.cwd, status: 'unknown', origin: 'managed', live: true, controllable: true, tmuxSession: name, createdAt: entry.createdAt };
  }

  private async resolveCwd(id: string): Promise<string> {
    const live = await this.d.home.readLiveSessions();
    const l = live.find(x => x.sessionId === id);
    if (l?.cwd) return l.cwd;
    const path = await this.d.home.locateTranscript(id);
    if (path) {
      for (const line of await this.d.home.readTranscript(path)) {
        try { const o = JSON.parse(line); if (o?.cwd) return o.cwd; } catch { /* skip */ }
      }
    }
    return process.cwd();
  }

  async adoptSession(id: string, opts: { force?: boolean } = {}): Promise<SessionSummary> {
    const live = await this.d.home.readLiveSessions();
    if (live.some(l => l.sessionId === id) && !opts.force) {
      throw new ConflictError('session still running; exit its window first or use force: ' + id);
    }
    const cwd = await this.resolveCwd(id);
    const name = tmuxNameFor(id);
    await this.d.tmux.newSession(name, cwd, [this.d.claudeBin, '--resume', id]);
    const createdAt = this.d.clock.now();
    await this.d.registry.put({ sessionId: id, tmuxSession: name, cwd, origin: 'adopted', createdAt });
    return { sessionId: id, cwd, status: 'unknown', origin: 'adopted', live: true, controllable: true, tmuxSession: name, createdAt };
  }

  // 结束/归档会话：受控会话 kill tmux（其 claude 进程随之退出）并移出注册表；
  // 外部（非受控）存活会话不属于本服务，拒绝删除，提示去其所属终端退出。
  async archiveSession(id: string): Promise<void> {
    const entry = await this.d.registry.get(id);
    if (entry) {
      if (await this.d.tmux.hasSession(entry.tmuxSession)) await this.d.tmux.killSession(entry.tmuxSession);
      await this.d.registry.remove(id);
      this.lastSeen.delete(id);
      this.emitEvent({ type: 'session.removed', sessionId: id });
      return;
    }
    const live = await this.d.home.readLiveSessions();
    if (live.some(l => l.sessionId === id)) {
      throw new NotControllableError('外部会话无法删除，请在其所属终端退出: ' + id);
    }
    throw new NotFoundError('session not found: ' + id);
  }

  async pollOnce(): Promise<void> {
    const summaries = await this.listSessions();
    const now = new Set(summaries.map(s => s.sessionId));
    for (const s of summaries) this.emitEvent({ type: 'session.updated', session: s });
    for (const id of this.lastSeen) if (!now.has(id)) this.emitEvent({ type: 'session.removed', sessionId: id });
    this.lastSeen = now;
  }

  async ingestTranscript(id: string): Promise<void> {
    const path = await this.d.home.locateTranscript(id);
    if (!path) return;
    const seen = this.emittedUuids.get(id) ?? new Set<string>();
    for (const e of parseTranscript(await this.d.home.readTranscript(path))) {
      if (e.uuid && seen.has(e.uuid)) continue;
      if (e.uuid) seen.add(e.uuid);
      this.emitEvent({ type: 'message', sessionId: id, event: e });
    }
    this.emittedUuids.set(id, seen);
  }

  async start(): Promise<void> {
    await this.pollOnce();
    this.timer = setInterval(() => { void this.pollOnce(); }, this.d.pollIntervalMs ?? 2000);
    this.unwatch = this.d.home.watchProjects((changed) => {
      const m = changed.match(/([0-9a-f-]{36})\.jsonl$/i);
      if (m) void this.ingestTranscript(m[1]);
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.unwatch?.();
  }
}
