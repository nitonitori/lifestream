import { execFile } from 'node:child_process';
import { readFileSync, statSync, type Stats } from 'node:fs';
import { uptime } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { LiveSession } from '../../domain/types.js';
import { parseSegments, pidFromRunName } from '../../domain/segments.js';
import { CliSource, isPidAlive, safeReaddir } from './base.js';

const execFileAsync = promisify(execFile);

export class QoderCliSource extends CliSource {
  readonly kernel = 'qodercli' as const;

  // 第三道闸：pid 活着、名字对，也未必是这个 run 的主人 —— 同一次开机内 pid 会被复用
  //（实测真实环境四天内就复用过一次）。run 文件是该进程自己创建的，所以「进程启动时刻
  // 早于 run 文件创建时刻」是精确判据：被复用的新进程必然启动于老 run 文件之后。
  // 逐个 pid 查而不批量：`ps -p a,b,c` 只要有一个 pid 越界就整批退出 1。
  // ps 本身失败时返回 false（宁可少报一个会话，也不能把无关进程当成会话去 kill）。
  private async pidOwnsRun(pid: number, runBirthMs: number): Promise<boolean> {
    let out: string;
    try {
      // lstart 必须放前面：ps 只有最后一列不截断，comm 在前会被截到 16 字符。
      // LC_ALL=C：默认 locale 下 lstart 输出中文（「五  7月/31 …」）无法解析。
      const r = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'lstart=,comm='],
        { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' } });
      out = r.stdout.trim();
    } catch { return false; }
    // 形如 `Fri Jul 31 14:34:26 2026 /path/to/bin`：前 5 个 token 是 lstart，其余是 comm。
    const tok = out.split(/\s+/).filter(Boolean);
    if (tok.length < 6) return false;
    const startMs = Date.parse(tok.slice(0, 5).join(' '));
    if (Number.isNaN(startMs) || startMs > runBirthMs) return false;
    // ps 给出的形状不统一（node 是绝对路径、qodercli 是短名），按 basename 比。
    return basename(tok.slice(5).join(' ')) === basename(this.bin);
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
        let st: Stats;
        try { st = statSync(runPath); } catch { continue; }
        if (st.mtimeMs < bootMs) continue;
        const pid = pidFromRunName(run);
        if (pid === null || !isPidAlive(pid) || !(await this.pidOwnsRun(pid, st.birthtimeMs))) continue;
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
