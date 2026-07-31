import { existsSync, readFileSync, readdirSync, watch } from 'node:fs';
import { join } from 'node:path';
import type { CreateSessionOptions, Kernel, LiveSession } from '../../domain/types.js';
import type { AgentSource, ControllableSource } from '../../ports/index.js';

export function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === 'EPERM'; }
}

// sessionId 来自 HTTP path 参数并会被拼进文件路径，这里挡住 ../ 与分隔符。
export function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

export function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

export function flatSessionIdForPath(changedPath: string): string | null {
  const parts = changedPath.split('/').filter(Boolean);
  const file = parts.at(-1);
  if (!file || !file.endsWith('.jsonl')) return null;
  if (parts.at(-2) === 'transcript') return null;
  return file.slice(0, -'.jsonl'.length);
}

export abstract class ProjectsSource implements AgentSource {
  abstract readonly kernel: Kernel;
  protected readonly projectsDir: string;

  constructor(protected readonly home: string) {
    this.projectsDir = join(home, 'projects');
  }

  abstract readLiveSessions(): Promise<LiveSession[]>;
  abstract sessionIdForPath(changedPath: string): string | null;

  protected candidatePaths(sessionId: string): string[] {
    return safeReaddir(this.projectsDir).map(d => join(this.projectsDir, d, `${sessionId}.jsonl`));
  }

  async locateTranscript(sessionId: string): Promise<string | null> {
    if (!isSafeSessionId(sessionId)) return null;
    for (const p of this.candidatePaths(sessionId)) if (existsSync(p)) return p;
    return null;
  }

  async readTranscript(path: string): Promise<string[]> {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter(Boolean);
  }

  async readTranscriptFrom(path: string, byteOffset: number): Promise<{ lines: string[]; offset: number }> {
    const buf = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
    const slice = buf.subarray(byteOffset).toString('utf8');
    return { lines: slice.split('\n').filter(Boolean), offset: buf.length };
  }

  watchProjects(cb: (changedPath: string) => void): () => void {
    if (!existsSync(this.projectsDir)) return () => {};
    const w = watch(this.projectsDir, { recursive: true }, (_e, fname) => { if (fname) cb(String(fname)); });
    return () => w.close();
  }
}

export abstract class CliSource extends ProjectsSource implements ControllableSource {
  constructor(home: string, private readonly bin: string, private readonly permissionMode?: string) {
    super(home);
  }

  launchCommand(sessionId: string, opts: CreateSessionOptions): string[] {
    const cmd = [this.bin, '--session-id', sessionId];
    if (opts.model) cmd.push('--model', opts.model);
    const mode = opts.permissionMode ?? this.permissionMode;
    if (mode) cmd.push('--permission-mode', mode);
    if (opts.name) cmd.push('--name', opts.name);
    return cmd;
  }

  resumeCommand(sessionId: string): string[] {
    const cmd = [this.bin, '--resume', sessionId];
    if (this.permissionMode) cmd.push('--permission-mode', this.permissionMode);
    return cmd;
  }

  sessionIdForPath(changedPath: string): string | null {
    return flatSessionIdForPath(changedPath);
  }
}
