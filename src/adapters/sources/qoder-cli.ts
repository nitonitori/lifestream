import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LiveSession } from '../../domain/types.js';
import { parseSegments, pidFromRunName } from '../../domain/segments.js';
import { CliSource, isPidAlive, safeReaddir } from './base.js';

export class QoderCliSource extends CliSource {
  readonly kernel = 'qodercli' as const;

  // qodercli 没有 Claude 那样的 sessions/<pid>.json 心跳文件，
  // 只能从 logs/sessions/<project>/<sessionId>/segments 的 run 日志反推存活与状态。
  async readLiveSessions(): Promise<LiveSession[]> {
    const root = join(this.home, 'logs', 'sessions');
    const out: LiveSession[] = [];
    for (const proj of safeReaddir(root)) {
      for (const sessionId of safeReaddir(join(root, proj))) {
        const segDir = join(root, proj, sessionId, 'segments');
        // run 名以 ISO 时间戳开头，字典序最大即最新。
        const run = safeReaddir(segDir).filter(f => f.endsWith('.jsonl')).sort().at(-1);
        if (!run) continue;
        const pid = pidFromRunName(run);
        if (pid === null || !isPidAlive(pid)) continue;
        let lines: string[];
        try { lines = readFileSync(join(segDir, run), 'utf8').split('\n').filter(Boolean); }
        catch { continue; }
        const { cwd, status } = parseSegments(lines);
        out.push({ sessionId, kernel: 'qodercli', cwd: cwd ?? '', status, pid });
      }
    }
    return out;
  }
}
