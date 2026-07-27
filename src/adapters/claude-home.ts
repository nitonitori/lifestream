import { readdirSync, readFileSync, existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeHomeAdapter } from '../ports/index.js';
import type { LiveSession } from '../domain/types.js';
import { toLiveSession } from '../domain/session-discovery.js';

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

export class ClaudeHome implements ClaudeHomeAdapter {
  constructor(private home: string) {}

  async readLiveSessions(): Promise<LiveSession[]> {
    const dir = join(this.home, 'sessions');
    if (!existsSync(dir)) return [];
    const out: LiveSession[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        const ls = toLiveSession(raw, isPidAlive);
        if (ls) out.push(ls);
      } catch { /* skip malformed */ }
    }
    return out;
  }

  async locateTranscript(sessionId: string): Promise<string | null> {
    const proj = join(this.home, 'projects');
    if (!existsSync(proj)) return null;
    for (const d of readdirSync(proj)) {
      const p = join(proj, d, `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
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
    const proj = join(this.home, 'projects');
    if (!existsSync(proj)) return () => {};
    const w = watch(proj, { recursive: true }, (_e, fname) => { if (fname) cb(String(fname)); });
    return () => w.close();
  }
}
