import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LiveSession } from '../../domain/types.js';
import { heartbeatVitals, parseHeartbeat } from '../../domain/heartbeat.js';
import { ProjectsSource, flatSessionIdForPath, safeReaddir } from './base.js';

export interface HeartbeatSourceOpts {
  home: string;
  heartbeatDir: string;
  ttlMs: number;
  now: () => number;
}

export abstract class HeartbeatSource extends ProjectsSource {
  protected readonly o: HeartbeatSourceOpts;

  constructor(o: HeartbeatSourceOpts) { super(o.home); this.o = o; }

  protected async isOwnSession(_sessionId: string): Promise<boolean> { return true; }

  async readLiveSessions(): Promise<LiveSession[]> {
    const out: LiveSession[] = [];
    for (const f of safeReaddir(this.o.heartbeatDir)) {
      if (!f.endsWith('.json')) continue;
      let text: string;
      try { text = readFileSync(join(this.o.heartbeatDir, f), 'utf8'); } catch { continue; }
      const h = parseHeartbeat(text);
      if (!h) continue;
      const v = heartbeatVitals(h, this.o.now(), this.o.ttlMs);
      if (!v.live) continue;
      if (!await this.isOwnSession(h.sessionId)) continue;
      out.push({ sessionId: h.sessionId, kernel: this.kernel, cwd: h.cwd, status: v.status });
    }
    return out;
  }
}

export class QoderWorkSource extends HeartbeatSource {
  readonly kernel = 'qoderwork' as const;

  sessionIdForPath(changedPath: string): string | null {
    return flatSessionIdForPath(changedPath);
  }
}

export class QoderIdeSource extends HeartbeatSource {
  readonly kernel = 'qoder-ide' as const;

  // Quest 会话的 sessionId 本身就带 `.session.execution`（实测心跳载荷），转录名一律是 `<id>.jsonl`。
  protected override candidatePaths(sessionId: string): string[] {
    return safeReaddir(this.projectsDir).map(d => join(this.projectsDir, d, 'transcript', `${sessionId}.jsonl`));
  }

  // ~/.qoder/settings.json 是 qodercli 与 Qoder IDE 共用的，心跳目录区分不了二者；
  // 靠「转录是否在 transcript/ 下」把 qodercli 的平铺会话滤掉。
  protected override async isOwnSession(sessionId: string): Promise<boolean> {
    return (await this.locateTranscript(sessionId)) !== null;
  }

  sessionIdForPath(changedPath: string): string | null {
    const parts = changedPath.split('/').filter(Boolean);
    const file = parts.at(-1);
    if (!file || parts.at(-2) !== 'transcript' || !file.endsWith('.jsonl')) return null;
    return file.slice(0, -'.jsonl'.length);
  }
}
