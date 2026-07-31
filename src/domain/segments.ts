// qodercli 的 run 文件名形如 <ISO 时间戳>-<随机>-p<pid>.jsonl，尾部 pid 是真实的每进程 pid。
export function pidFromRunName(runFile: string): number | null {
  const m = runFile.match(/-p(\d+)(?:\.jsonl)?$/);
  return m ? Number(m[1]) : null;
}

// segments 是事件日志（不是转录）。事件并非成对追加（实测大量 .finished 没有对应 .started，
// 并发 hook 还会造出假空闲窗口），故这里只抽 cwd，状态交给上层一律报 unknown。
export function parseSegments(lines: string[]): { cwd?: string } {
  let cwd: string | undefined;
  for (const line of lines) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const type = typeof o?.type === 'string' ? o.type : '';
    // 取第一条 session.config.loaded：run 内 project_root 不变，首条即可，后续不覆盖。
    if (cwd === undefined && type === 'session.config.loaded' && typeof o?.data?.project_root === 'string') {
      cwd = o.data.project_root;
    }
  }
  return { cwd };
}
