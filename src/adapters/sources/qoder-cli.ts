import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { uptime } from 'node:os';
import { basename, join } from 'node:path';
import type { LiveSession } from '../../domain/types.js';
import { parseSegments, pidFromRunName } from '../../domain/segments.js';
import { CliSource, isPidAlive, safeReaddir } from './base.js';

export class QoderCliSource extends CliSource {
  readonly kernel = 'qodercli' as const;

  // 第二道闸：pid 活着不代表它还是 qodercli —— 复用后可能是任意进程。
  // 逐个 pid 查而不批量：`ps -p a,b,c` 只要有一个 pid 越界就整批退出 1。
  // ps 本身失败时返回 false（宁可少报一个会话，也不能把无关进程当成会话去 kill）。
  private pidRunsBin(pid: number): boolean {
    try {
      const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 2000 }).trim();
      // ps 给出的形状不统一（node 是绝对路径、qodercli 是短名），按 basename 比。
      return comm !== '' && basename(comm) === basename(this.bin);
    } catch { return false; }
  }

  // qodercli 没有 Claude 那样的 sessions/<pid>.json 心跳文件，
  // 只能从 logs/sessions/<project>/<sessionId>/segments 的 run 日志反推存活。
  async readLiveSessions(): Promise<LiveSession[]> {
    const root = join(this.home, 'logs', 'sessions');
    const out: LiveSession[] = [];
    // run 名尾部的 pid 是历史值：logs/sessions 只追加不清理，重启后 pid 会被系统复用，
    // 于是「幽灵活会话」既删不掉（archiveSession 见 isLive 就拒），force 接管还会 SIGTERM 无关进程。
    // 第一道闸：日志文件必须在本次开机之后被写过。
    const bootMs = Date.now() - uptime() * 1000;
    for (const proj of safeReaddir(root)) {
      for (const sessionId of safeReaddir(join(root, proj))) {
        const segDir = join(root, proj, sessionId, 'segments');
        // run 名以 ISO 时间戳开头，字典序最大即最新。
        const run = safeReaddir(segDir).filter(f => f.endsWith('.jsonl')).sort().at(-1);
        if (!run) continue;
        const runPath = join(segDir, run);
        let mtimeMs: number;
        try { mtimeMs = statSync(runPath).mtimeMs; } catch { continue; }
        if (mtimeMs < bootMs) continue;
        const pid = pidFromRunName(run);
        if (pid === null || !isPidAlive(pid) || !this.pidRunsBin(pid)) continue;
        let lines: string[];
        try { lines = readFileSync(runPath, 'utf8').split('\n').filter(Boolean); }
        catch { continue; }
        const { cwd } = parseSegments(lines);
        out.push({ sessionId, kernel: 'qodercli', cwd: cwd ?? '', status: 'unknown', pid });
      }
    }
    return out;
  }
}
