import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, watch, existsSync, mkdirSync, openSync, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';

export function nextBackoffMs(consecutiveFailures: number, base = 500, max = 30000): number {
  return Math.min(max, base * Math.pow(2, consecutiveFailures));
}

export interface SupervisorOptions {
  command: string[];              // 例如 ['node','dist/cli.js','serve']
  cwd: string;
  watchDir?: string;              // 提供则监视其变更并优雅重启（热更新）
  pidFile?: string;
  logFile?: string;
  backoffBaseMs?: number;         // 便于测试
  stableMs?: number;              // 子进程存活超过此时长视为稳定，重置退避
  onLog?: (line: string) => void;
}

// 守护/监督进程：保活（崩溃退避重启）+ 源码变更热重启 + SIGHUP 重启 + 优雅关闭。
export class Supervisor {
  private child?: ChildProcess;
  private failures = 0;
  private stopping = false;
  private restarting = false;
  private startedAt = 0;
  private watcher?: FSWatcher;
  private watchTimer?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;

  constructor(private o: SupervisorOptions) {}

  private log(msg: string) {
    const line = `[daemon ${new Date().toISOString()}] ${msg}`;
    if (this.o.onLog) this.o.onLog(line); else console.log(line);
  }

  start() {
    if (this.o.pidFile) {
      mkdirSync(dirname(this.o.pidFile), { recursive: true });
      writeFileSync(this.o.pidFile, String(process.pid));
    }
    process.on('SIGHUP', () => { this.log('SIGHUP -> restart'); this.restart(); });
    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());
    if (this.o.watchDir && existsSync(this.o.watchDir)) this.startWatch(this.o.watchDir);
    this.spawnChild();
  }

  private spawnChild() {
    const [cmd, ...args] = this.o.command;
    let stdio: any = 'inherit';
    if (this.o.logFile) {
      mkdirSync(dirname(this.o.logFile), { recursive: true });
      const fd = openSync(this.o.logFile, 'a');
      stdio = ['ignore', fd, fd];
    }
    this.startedAt = Date.now();
    this.log(`spawn: ${this.o.command.join(' ')}`);
    this.child = spawn(cmd, args, { cwd: this.o.cwd, stdio, env: process.env });
    this.child.on('exit', (code, signal) => this.onExit(code, signal));
  }

  private onExit(code: number | null, signal: string | null) {
    if (this.stopping) return;
    const ranMs = Date.now() - this.startedAt;
    if (this.restarting) {
      this.restarting = false;
      this.failures = 0;
      this.log('child exited for restart -> respawn now');
      this.spawnChild();
      return;
    }
    if (ranMs > (this.o.stableMs ?? 10000)) this.failures = 0;
    const delay = nextBackoffMs(this.failures, this.o.backoffBaseMs ?? 500);
    this.failures++;
    this.log(`child exited (code=${code} signal=${signal}); restart in ${delay}ms`);
    this.restartTimer = setTimeout(() => { if (!this.stopping) this.spawnChild(); }, delay);
  }

  restart() {
    if (!this.child || this.restarting) return;
    this.restarting = true;
    this.log('graceful restart: SIGTERM child');
    this.child.kill('SIGTERM');
    // 兜底：若子进程未在 5s 内退出则强杀
    const c = this.child;
    setTimeout(() => { if (this.restarting && c && !c.killed) c.kill('SIGKILL'); }, 5000);
  }

  private startWatch(dir: string) {
    this.watcher = watch(dir, { recursive: true }, (_e, fname) => {
      if (!fname || !/\.(ts|js|css|html|json)$/.test(String(fname))) return;
      clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => { this.log(`change: ${fname} -> restart`); this.restart(); }, 400);
    });
  }

  stop() {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.watchTimer);
    this.watcher?.close();
    this.log('stopping');
    if (this.child && !this.child.killed) this.child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 300);
  }
}
