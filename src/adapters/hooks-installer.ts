import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type HookTarget, type Settings, heartbeatDir } from '../domain/qoder-hooks.js';

export interface TargetPaths { settings: string; heartbeatDir: string }

export function targetPaths(
  homes: Record<HookTarget, string>, stateDir: string, t: HookTarget,
): TargetPaths {
  return { settings: join(homes[t], 'settings.json'), heartbeatDir: heartbeatDir(stateDir, t) };
}

export function heartbeatScriptPath(): string {
  const p = resolve(process.cwd(), 'dist/hooks/lifestream-heartbeat.js');
  if (!existsSync(p)) throw new Error(`找不到 ${p}，先执行 npm run build`);
  return p;
}

export function heartbeatCommand(script: string, dir: string): string {
  // 双引号内 $ 与反引号仍会被 shell 解释，含这些字符的路径拼出来的命令会静默失效。
  for (const s of [process.execPath, script, dir])
    if (/["$`\\]/.test(s)) throw new Error(`路径含 shell 特殊字符，无法安全注入：${s}`);
  return `"${process.execPath}" "${script}" --dir "${dir}"`;
}

// heartbeatCommand 的逆向：命令形如 `"<node>" "<script>" --dir "<dir>"`，取第二个引号段。
// 两者必须成对修改 —— 改了命令串格式就得同步改这里的正则，否则 status 报不出脚本路径。
export function scriptPathFromCommand(cmd: string): string | null {
  const m = cmd.match(/^"[^"]*"\s+"([^"]*)"/);
  return m?.[1] ?? null;
}

// 解析失败必须抛：返回 {} 再写回去会把用户原有的 settings 抹掉。
export function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  try { return JSON.parse(text) as Settings; }
  catch { throw new Error(`${file} 不是合法 JSON，拒绝改写`); }
}

export function writeSettings(file: string, s: Settings, now: number): string | null {
  let backup: string | null = null;
  if (existsSync(file)) {
    backup = `${file}.lifestream-backup-${now}`;
    copyFileSync(file, backup);
  } else {
    mkdirSync(dirname(file), { recursive: true });
  }
  writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  return backup;
}
