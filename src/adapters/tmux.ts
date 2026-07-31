import { execFile } from 'node:child_process';
import type { TmuxAdapter, TmuxSessionInfo } from '../ports/index.js';
import { UpstreamError } from '../domain/errors.js';

export class Tmux implements TmuxAdapter {
  constructor(private socket: string, private bin = 'tmux') {}

  private run(args: string[], stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(this.bin, ['-L', this.socket, ...args], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new UpstreamError(`tmux ${args[0]} failed: ${stderr || err.message}`));
        resolve(stdout);
      });
      if (stdin !== undefined) { child.stdin!.end(stdin); }
    });
  }

  async listSessions(): Promise<TmuxSessionInfo[]> {
    try {
      const out = await this.run(['list-sessions', '-F', '#{session_name}\t#{session_windows}\t#{session_created}']);
      return out.split('\n').filter(Boolean).map(l => {
        const [name, windows, created] = l.split('\t');
        return { name, windows: Number(windows), created: Number(created) };
      });
    } catch {
      return []; // no tmux server yet => no sessions
    }
  }

  async hasSession(name: string): Promise<boolean> {
    try { await this.run(['has-session', '-t', name]); return true; } catch { return false; }
  }

  async newSession(name: string, cwd: string, command: string[]): Promise<void> {
    await this.run(['new-session', '-d', '-s', name, '-c', cwd, ...command]);
  }

  async sendText(name: string, text: string): Promise<void> {
    const buf = 'ls-' + process.pid + '-' + Math.abs(hash(text + name));
    await this.run(['load-buffer', '-b', buf, '-'], text);
    await this.run(['paste-buffer', '-d', '-b', buf, '-t', name]);
    await this.run(['send-keys', '-t', name, 'Enter']);
  }

  // send-keys -l 关掉键名查找、按字面 UTF-8 处理, 因此发不出 Escape/Up/Enter, 只能送字面字符。
  async sendLiteral(name: string, text: string): Promise<void> {
    await this.run(['send-keys', '-l', '-t', name, text]);
  }

  async capturePane(name: string): Promise<string> {
    return this.run(['capture-pane', '-p', '-t', name]);
  }

  async killSession(name: string): Promise<void> {
    await this.run(['kill-session', '-t', name]);
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h;
}
