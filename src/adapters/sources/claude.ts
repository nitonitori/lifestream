import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LiveSession } from '../../domain/types.js';
import { toLiveSession } from '../../domain/session-discovery.js';
import { CliSource, isPidAlive, safeReaddir } from './base.js';

export class ClaudeSource extends CliSource {
  readonly kernel = 'claude' as const;

  async readLiveSessions(): Promise<LiveSession[]> {
    const dir = join(this.home, 'sessions');
    const out: LiveSession[] = [];
    for (const f of safeReaddir(dir)) {
      if (!f.endsWith('.json')) continue;
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
      const s = toLiveSession(raw as any, 'claude', isPidAlive);
      if (s) out.push(s);
    }
    return out;
  }
}
