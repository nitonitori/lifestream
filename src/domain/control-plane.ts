import { EventEmitter } from 'node:events';
import type { TmuxAdapter, AgentSource, ManagedRegistry, Clock, ManagedEntry } from '../ports/index.js';
import { isControllable } from '../ports/index.js';
import type { Kernel, CreateSessionOptions, SessionSummary, SessionDetail, TranscriptEvent, PlaneEvent } from './types.js';
import { NotFoundError, NotControllableError, ConflictError } from './errors.js';
import { parseTranscript } from './transcript-parser.js';
import { buildSummaries } from './session-discovery.js';
import { parseInteractivePrompt, type InteractivePrompt } from './interactive-prompt.js';

export function tmuxNameFor(id: string) { return 'lifestream-' + id.slice(0, 8); }

interface Deps {
  tmux: TmuxAdapter;
  sources: AgentSource[];
  registry: ManagedRegistry;
  clock: Clock;
  newSessionId: () => string;
  pollIntervalMs?: number;
  readonlyPollIntervalMs?: number;
  // 结束原进程用（接管存活会话时）。默认 SIGTERM；测试可注入。
  killProcess?: (pid: number) => void;
}

export class ControlPlane extends EventEmitter {
  private readonly lastSeen = new Map<Kernel, Set<string>>();
  private emittedUuids = new Map<string, Set<string>>();
  private readonly byKernel = new Map<Kernel, AgentSource>();
  private readonly kernelOf = new Map<string, Kernel>();
  private timers: NodeJS.Timeout[] = [];
  private unwatchers: (() => void)[] = [];

  constructor(private d: Deps) {
    super();
    for (const s of d.sources) this.byKernel.set(s.kernel, s);
  }

  private emitEvent(e: PlaneEvent) { this.emit('event', e); }

  private async sourceOf(id: string): Promise<AgentSource> {
    const cached = this.kernelOf.get(id);
    if (cached) { const s = this.byKernel.get(cached); if (s) return s; }
    const entry = await this.d.registry.get(id);
    if (entry) {
      const s = this.byKernel.get(entry.kernel);
      if (s) { this.kernelOf.set(id, s.kernel); return s; }
    }
    // 转录探测先于 live 枚举：qodercli 的 readLiveSessions 要走一遍整棵 logs/sessions。
    for (const s of this.d.sources) {
      if (await s.locateTranscript(id)) { this.kernelOf.set(id, s.kernel); return s; }
    }
    for (const s of this.d.sources) {
      const live = await s.readLiveSessions();
      if (live.some(l => l.sessionId === id)) { this.kernelOf.set(id, s.kernel); return s; }
    }
    throw new NotFoundError('session not found: ' + id);
  }

  private async isLive(id: string): Promise<boolean> {
    for (const s of this.d.sources) {
      const live = await s.readLiveSessions();
      if (live.some(l => l.sessionId === id)) return true;
    }
    return false;
  }

  private async activityMap(ids: Map<string, Kernel>): Promise<Map<string, number>> {
    const activity = new Map<string, number>();
    for (const [id, kernel] of ids) {
      const src = this.byKernel.get(kernel);
      if (!src) continue;
      const p = await src.locateTranscript(id);
      if (!p) continue;
      const last = parseTranscript(await src.readTranscript(p)).at(-1);
      if (last?.ts) activity.set(id, last.ts);
    }
    return activity;
  }

  private async summarize(sources: AgentSource[]): Promise<SessionSummary[]> {
    const kernels = new Set(sources.map(s => s.kernel));
    const live = (await Promise.all(sources.map(s => s.readLiveSessions()))).flat();
    const managed = (await this.d.registry.list()).filter(m => kernels.has(m.kernel));
    const tmuxNames = new Set((await this.d.tmux.listSessions()).map(t => t.name));
    const ids = new Map<string, Kernel>();
    for (const m of managed) ids.set(m.sessionId, m.kernel);
    for (const l of live) ids.set(l.sessionId, l.kernel);
    for (const [id, k] of ids) this.kernelOf.set(id, k);
    const activity = await this.activityMap(ids);
    return buildSummaries({
      live, managed, tmuxNames, activity,
      adoptable: new Set<Kernel>(sources.filter(isControllable).map(s => s.kernel)),
    });
  }

  async listSessions(): Promise<SessionSummary[]> { return this.summarize(this.d.sources); }

  async getSession(id: string): Promise<SessionDetail> {
    const s = (await this.listSessions()).find(x => x.sessionId === id);
    if (!s) throw new NotFoundError('session not found: ' + id);
    const src = await this.sourceOf(id);
    const path = await src.locateTranscript(id);
    const count = path ? parseTranscript(await src.readTranscript(path)).length : 0;
    return { ...s, transcriptPath: path ?? undefined, messageCount: count };
  }

  async getMessages(id: string, opts: { sinceUuid?: string; limit?: number } = {}): Promise<TranscriptEvent[]> {
    let src: AgentSource;
    try { src = await this.sourceOf(id); } catch { return []; }
    const path = await src.locateTranscript(id);
    if (!path) return [];
    let events = parseTranscript(await src.readTranscript(path));
    if (opts.sinceUuid) {
      const idx = events.findIndex(e => e.uuid === opts.sinceUuid);
      if (idx >= 0) events = events.slice(idx + 1);
    }
    if (opts.limit && events.length > opts.limit) events = events.slice(-opts.limit);
    return events;
  }

  // 受控会话的 tmux 名守卫：受控且 tmux 存活 → 返回 tmux 名；
  // 是外部存活会话 → NotControllable(需先接管)；否则 NotFound。
  private async managedTmuxName(id: string): Promise<string> {
    const entry = await this.d.registry.get(id);
    if (entry && await this.d.tmux.hasSession(entry.tmuxSession)) return entry.tmuxSession;
    if (await this.isLive(id)) {
      throw new NotControllableError('session is external/not managed; adopt it first: ' + id);
    }
    throw new NotFoundError('session not found: ' + id);
  }

  async sendMessage(id: string, text: string): Promise<void> {
    await this.d.tmux.sendText(await this.managedTmuxName(id), text);
  }

  // 抓取受控会话当前 pane 文本(用于识别是否卡在交互选择器)。
  async capturePane(id: string): Promise<string> {
    return this.d.tmux.capturePane(await this.managedTmuxName(id));
  }

  // 识别受控会话是否停在 TUI 选择器上；返回结构化提示或 null。
  async detectPrompt(id: string): Promise<InteractivePrompt | null> {
    return parseInteractivePrompt(await this.capturePane(id));
  }

  // 应答交互选择器：只送字面字符(编号)，不追加 Enter。
  async answerPrompt(id: string, key: string): Promise<void> {
    await this.d.tmux.sendLiteral(await this.managedTmuxName(id), key);
  }

  async createSession(opts: CreateSessionOptions): Promise<SessionSummary> {
    const kernel = opts.kernel ?? 'claude';
    const src = this.byKernel.get(kernel);
    if (!src) throw new NotFoundError('no source for kernel: ' + kernel);
    if (!isControllable(src)) throw new NotControllableError('kernel is read-only, cannot create session: ' + kernel);
    const id = this.d.newSessionId();
    const name = tmuxNameFor(id);
    const cmd = src.launchCommand(id, opts);
    await this.d.tmux.newSession(name, opts.cwd, cmd);
    const entry: ManagedEntry = { sessionId: id, tmuxSession: name, cwd: opts.cwd, kernel, origin: 'managed', createdAt: this.d.clock.now() };
    await this.d.registry.put(entry);
    this.kernelOf.set(id, kernel);
    if (opts.initialPrompt) await this.d.tmux.sendText(name, opts.initialPrompt);
    return {
      sessionId: id, kernel, name: opts.name, cwd: opts.cwd, status: 'unknown', origin: 'managed',
      live: true, controllable: true, adoptable: true, tmuxSession: name, createdAt: entry.createdAt,
    };
  }

  private async resolveCwd(src: AgentSource, id: string): Promise<string> {
    const live = await src.readLiveSessions();
    const l = live.find(x => x.sessionId === id);
    if (l?.cwd) return l.cwd;
    const path = await src.locateTranscript(id);
    if (path) {
      for (const line of await src.readTranscript(path)) {
        try { const o = JSON.parse(line); if (o?.cwd) return o.cwd; } catch { /* skip */ }
      }
    }
    return process.cwd();
  }

  async adoptSession(id: string, opts: { force?: boolean } = {}): Promise<SessionSummary> {
    const src = await this.sourceOf(id);
    if (!isControllable(src)) throw new NotControllableError('kernel is read-only, cannot adopt: ' + src.kernel);
    const live = await src.readLiveSessions();
    const liveMatches = live.filter(l => l.sessionId === id);
    if (liveMatches.length && !opts.force) {
      throw new ConflictError('session still running; exit its window first or use force: ' + id);
    }
    // force 接管存活会话：先结束原进程（其持有该 session id），等它释放，再 --resume。
    let cwdHint: string | undefined;
    if (liveMatches.length) {
      cwdHint = liveMatches.find(l => l.cwd)?.cwd;
      for (const l of liveMatches) if (l.pid) this.killPid(l.pid);
      await this.waitForSessionGone(id);
    }
    const cwd = cwdHint ?? await this.resolveCwd(src, id);
    const name = tmuxNameFor(id);
    const cmd = src.resumeCommand(id);
    await this.d.tmux.newSession(name, cwd, cmd);
    const createdAt = this.d.clock.now();
    await this.d.registry.put({ sessionId: id, tmuxSession: name, cwd, kernel: src.kernel, origin: 'adopted', createdAt });
    return {
      sessionId: id, kernel: src.kernel, cwd, status: 'unknown', origin: 'adopted',
      live: true, controllable: true, adoptable: true, tmuxSession: name, createdAt,
    };
  }

  private killPid(pid: number): void {
    try { (this.d.killProcess ?? ((p: number) => process.kill(p, 'SIGTERM')))(pid); }
    catch { /* 已退出 / 无权限 */ }
  }

  // 轮询直到该 session id 从 live 注册表消失（原进程已释放），最多约 3s 后仍继续。
  private async waitForSessionGone(id: string, tries = 15, delayMs = 200): Promise<void> {
    for (let i = 0; i < tries; i++) {
      if (!await this.isLive(id)) return;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // 结束/归档会话：受控会话 kill tmux（其 claude 进程随之退出）并移出注册表；
  // 外部（非受控）存活会话不属于本服务，拒绝删除，提示去其所属终端退出。
  async archiveSession(id: string): Promise<void> {
    const entry = await this.d.registry.get(id);
    if (entry) {
      if (await this.d.tmux.hasSession(entry.tmuxSession)) await this.d.tmux.killSession(entry.tmuxSession);
      await this.d.registry.remove(id);
      this.lastSeen.get(entry.kernel)?.delete(id);
      this.emitEvent({ type: 'session.removed', sessionId: id });
      return;
    }
    if (await this.isLive(id)) {
      throw new NotControllableError('外部会话无法删除，请在其所属终端退出: ' + id);
    }
    throw new NotFoundError('session not found: ' + id);
  }

  // 消失判定只在本组内做，否则只读组的慢节拍轮询会把可控组的会话误判为消失。
  private async pollSources(group: AgentSource[]): Promise<void> {
    const list = await this.summarize(group);
    for (const s of list) this.emitEvent({ type: 'session.updated', session: s });
    for (const src of group) {
      const seen = this.lastSeen.get(src.kernel) ?? new Set<string>();
      const now = new Set(list.filter(x => x.kernel === src.kernel).map(x => x.sessionId));
      for (const id of seen) if (!now.has(id)) this.emitEvent({ type: 'session.removed', sessionId: id });
      this.lastSeen.set(src.kernel, now);
    }
  }

  async pollOnce(): Promise<void> { await this.pollSources(this.d.sources); }

  async ingestTranscript(id: string): Promise<void> {
    let src: AgentSource;
    try { src = await this.sourceOf(id); } catch { return; }
    await this.ingestFrom(src, id);
  }

  private async ingestFrom(src: AgentSource, id: string): Promise<void> {
    const path = await src.locateTranscript(id);
    if (!path) return;
    const seen = this.emittedUuids.get(id) ?? new Set<string>();
    for (const e of parseTranscript(await src.readTranscript(path))) {
      if (e.uuid && seen.has(e.uuid)) continue;
      if (e.uuid) seen.add(e.uuid);
      this.emitEvent({ type: 'message', sessionId: id, event: e });
    }
    this.emittedUuids.set(id, seen);
  }

  async start(): Promise<void> {
    const ctl = this.d.sources.filter(isControllable);
    const ro = this.d.sources.filter(s => !isControllable(s));
    await this.pollOnce();
    if (ctl.length > 0) {
      this.timers.push(setInterval(() => { void this.pollSources(ctl); }, this.d.pollIntervalMs ?? 2000));
    }
    if (ro.length > 0) {
      this.timers.push(setInterval(() => { void this.pollSources(ro); }, this.d.readonlyPollIntervalMs ?? 5000));
    }
    for (const s of this.d.sources) {
      this.unwatchers.push(s.watchProjects((changed) => {
        const id = s.sessionIdForPath(changed);
        if (id) void this.ingestFrom(s, id);
      }));
    }
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const u of this.unwatchers) u();
    this.unwatchers = [];
  }
}
