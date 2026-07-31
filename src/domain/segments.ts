import type { SessionStatus } from './types.js';

// qodercli 的 run 文件名形如 <ISO 时间戳>-<随机>-p<pid>.jsonl，尾部 pid 是真实的每进程 pid。
export function pidFromRunName(runFile: string): number | null {
  const m = runFile.match(/-p(\d+)(?:\.jsonl)?$/);
  return m ? Number(m[1]) : null;
}

// segments 是事件日志（不是转录）：事件成对追加，所以「末条以 .started 结尾」就是 busy。
export function parseSegments(lines: string[]): { cwd?: string; status: SessionStatus } {
  let cwd: string | undefined;
  let status: SessionStatus = 'idle';
  for (const line of lines) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const type = typeof o?.type === 'string' ? o.type : '';
    if (cwd === undefined && type === 'session.config.loaded' && typeof o?.data?.project_root === 'string') {
      cwd = o.data.project_root;
    }
    if (type.endsWith('.started')) status = 'busy';
    else if (type.endsWith('.finished')) status = 'idle';
  }
  return { cwd, status };
}
