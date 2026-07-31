import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HeartbeatPayload { sessionId: string; cwd: string; event: string; ts: number }

export function heartbeatPayload(raw: string, now: number): HeartbeatPayload | null {
  let o: any;
  try { o = JSON.parse(raw); } catch { return null; }
  const sessionId = o?.sessionId ?? o?.session_id;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  return {
    sessionId,
    cwd: typeof o?.cwd === 'string' ? o.cwd : '',
    event: typeof o?.hook_event_name === 'string' ? o.hook_event_name : 'unknown',
    ts: now,
  };
}

export function writeHeartbeat(dir: string, p: HeartbeatPayload): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${p.sessionId}.json`), JSON.stringify(p));
}

export async function main(argv: string[], stdin: AsyncIterable<Buffer | string>): Promise<void> {
  const i = argv.indexOf('--dir');
  const dir = i >= 0 ? argv[i + 1] : undefined;
  if (!dir) return;
  let raw = '';
  for await (const chunk of stdin) raw += String(chunk);
  const p = heartbeatPayload(raw, Date.now());
  if (p) writeHeartbeat(dir, p);
}

// 判断“本文件是被当脚本直接执行”还是“被 import”（vitest import 本文件时不能触发 main）。
// 必须按 realpath 比较：注入到别家 settings.json 里的命令串一旦含符号链接（dist 是软链、
// macOS 的 /tmp -> /private/tmp 等），argv[1] 与 import.meta.url 就不相等，
// 朴素的字符串比较会让守卫静默失效 —— 心跳一个都不写、也不报错，和“宿主没触发 hook”一模一样。
export function isDirectRun(entry: string | undefined, moduleUrl: string): boolean {
  if (!entry) return false;
  const self = fileURLToPath(moduleUrl);
  if (entry === self) return true;
  try { return realpathSync(entry) === realpathSync(self); } catch { return false; }
}

// 任何异常都吞掉：这个 hook 挂在别人的进程里，绝不能把宿主搞崩。
if (isDirectRun(process.argv[1], import.meta.url)) {
  void main(process.argv.slice(2), process.stdin).catch(() => {});
}
