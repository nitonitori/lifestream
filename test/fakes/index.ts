import type {
  Clock, TmuxAdapter, TmuxSessionInfo, AgentSource, ControllableSource, ManagedRegistry, ManagedEntry,
  PendingActionStore, ImAdapter, InboundMessage, AgentRunner, DeviceStore, Device,
} from '../../src/ports/index.js';
import type { CreateSessionOptions, Kernel, LiveSession, PendingAction } from '../../src/domain/types.js';
import { flatSessionIdForPath } from '../../src/adapters/sources/base.js';

export class FakeClock implements Clock {
  constructor(public t = 1000) {}
  now() { return this.t; }
}

export class FakeTmux implements TmuxAdapter {
  sessions = new Map<string, { cwd: string; command: string[] }>();
  sent: { name: string; text: string }[] = [];
  literal: { name: string; text: string }[] = [];
  paneText = '';
  async listSessions(): Promise<TmuxSessionInfo[]> {
    return [...this.sessions.keys()].map(name => ({ name, windows: 1, created: 0 }));
  }
  async hasSession(name: string) { return this.sessions.has(name); }
  async newSession(name: string, cwd: string, command: string[]) { this.sessions.set(name, { cwd, command }); }
  async sendText(name: string, text: string) {
    if (!this.sessions.has(name)) throw new Error('no session ' + name);
    this.sent.push({ name, text });
  }
  async sendLiteral(name: string, text: string) {
    if (!this.sessions.has(name)) throw new Error('no session ' + name);
    this.literal.push({ name, text });
  }
  async capturePane() { return this.paneText; }
  async killSession(name: string) { this.sessions.delete(name); }
}

export class FakeSource implements ControllableSource {
  constructor(
    readonly kernel: Kernel = 'claude',
    private readonly bin = 'claude',
    private readonly permissionMode = 'bypassPermissions',
  ) {}

  live: LiveSession[] = [];
  transcripts = new Map<string, string[]>(); // sessionId -> lines
  paths = new Map<string, string>();         // sessionId -> path
  reads = 0;                                 // readLiveSessions 次数：给轮询节拍的测试当计数器
  async readLiveSessions() { this.reads++; return this.live; }
  async locateTranscript(id: string) { return this.paths.get(id) ?? null; }
  async readTranscript(path: string) {
    for (const [id, p] of this.paths) if (p === path) return this.transcripts.get(id) ?? [];
    return [];
  }
  async readTranscriptFrom(path: string, _o: number) { return { lines: await this.readTranscript(path), offset: 0 }; }

  watched: ((changedPath: string) => void)[] = [];
  watchProjects(cb: (changedPath: string) => void): () => void {
    this.watched.push(cb);
    return () => { this.watched = this.watched.filter(x => x !== cb); };
  }
  sessionIdForPath(p: string): string | null { return flatSessionIdForPath(p); }
  launchCommand(sessionId: string, opts: CreateSessionOptions): string[] {
    const cmd = [this.bin, '--session-id', sessionId];
    if (opts.model) cmd.push('--model', opts.model);
    const mode = opts.permissionMode ?? this.permissionMode;
    if (mode) cmd.push('--permission-mode', mode);
    if (opts.name) cmd.push('--name', opts.name);
    return cmd;
  }
  resumeCommand(sessionId: string): string[] {
    return [this.bin, '--resume', sessionId, '--permission-mode', this.permissionMode];
  }
}

// 只读内核（桌面 app）的替身：不实现 launchCommand / resumeCommand，isControllable 判它为只读。
export class FakeReadonlySource implements AgentSource {
  constructor(readonly kernel: Kernel) {}

  live: LiveSession[] = [];
  reads = 0;                                 // readLiveSessions 次数：给轮询节拍的测试当计数器
  async readLiveSessions() { this.reads++; return this.live; }
  async locateTranscript() { return null; }
  async readTranscript() { return []; }
  async readTranscriptFrom() { return { lines: [], offset: 0 }; }

  watched: ((changedPath: string) => void)[] = [];
  watchProjects(cb: (changedPath: string) => void): () => void {
    this.watched.push(cb);
    return () => { this.watched = this.watched.filter(x => x !== cb); };
  }
  sessionIdForPath(p: string): string | null { return flatSessionIdForPath(p); }
}

export class InMemoryManagedRegistry implements ManagedRegistry {
  m = new Map<string, ManagedEntry>();
  async list() { return [...this.m.values()]; }
  async get(id: string) { return this.m.get(id) ?? null; }
  async put(e: ManagedEntry) { this.m.set(e.sessionId, e); }
  async remove(id: string) { this.m.delete(id); }
}

export class InMemoryPendingStore implements PendingActionStore {
  m = new Map<string, PendingAction[]>();
  async get(c: string) { return this.m.get(c) ?? []; }
  async set(c: string, a: PendingAction[]) { this.m.set(c, a); }
  async clear(c: string) { this.m.delete(c); }
}

export class FakeIm implements ImAdapter {
  inbox: InboundMessage[] = [];
  outbox: { conversationId: string; text: string }[] = [];
  async poll(_cursor: string | null) {
    const messages = this.inbox; this.inbox = [];
    return { messages, cursor: 'c' };
  }
  async send(conversationId: string, text: string) { this.outbox.push({ conversationId, text }); }
}

export class FakeAgent implements AgentRunner {
  calls: { key: string; text: string }[] = [];
  responder: (key: string, text: string) => Promise<string> | string = () => 'ok';
  async handle(key: string, text: string) { this.calls.push({ key, text }); return this.responder(key, text); }
}

export class InMemoryDeviceStore implements DeviceStore {
  m = new Map<string, Device>();
  async list() { return [...this.m.values()]; }
  async findByToken(token: string) { return [...this.m.values()].find(d => d.token === token) ?? null; }
  async put(d: Device) { this.m.set(d.id, d); }
  async touch(id: string, now: number) { const d = this.m.get(id); if (d) d.lastSeenAt = now; }
  async remove(id: string) { this.m.delete(id); }
}
