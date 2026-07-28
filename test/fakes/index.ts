import type {
  Clock, TmuxAdapter, TmuxSessionInfo, ClaudeHomeAdapter, ManagedRegistry, ManagedEntry,
  PendingActionStore, ImAdapter, InboundMessage, AgentRunner, DeviceStore, Device,
} from '../../src/ports/index.js';
import type { LiveSession, PendingAction } from '../../src/domain/types.js';

export class FakeClock implements Clock {
  constructor(public t = 1000) {}
  now() { return this.t; }
}

export class FakeTmux implements TmuxAdapter {
  sessions = new Map<string, { cwd: string; command: string[] }>();
  sent: { name: string; text: string }[] = [];
  keys: { name: string; keys: string[] }[] = [];
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
  async sendKeys(name: string, keys: string[]) {
    if (!this.sessions.has(name)) throw new Error('no session ' + name);
    this.keys.push({ name, keys });
  }
  async capturePane() { return this.paneText; }
  async killSession(name: string) { this.sessions.delete(name); }
}

export class FakeClaudeHome implements ClaudeHomeAdapter {
  live: LiveSession[] = [];
  transcripts = new Map<string, string[]>(); // sessionId -> lines
  paths = new Map<string, string>();         // sessionId -> path
  async readLiveSessions() { return this.live; }
  async locateTranscript(id: string) { return this.paths.get(id) ?? null; }
  async readTranscript(path: string) {
    for (const [id, p] of this.paths) if (p === path) return this.transcripts.get(id) ?? [];
    return [];
  }
  async readTranscriptFrom(path: string, _o: number) { return { lines: await this.readTranscript(path), offset: 0 }; }
  watchProjects(_cb: (p: string) => void) { return () => {}; }
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
