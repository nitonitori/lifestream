import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export interface Config {
  web: { host: string; port: number; token: string };
  tmux: { bin: string; socket: string };
  claude: { bin: string; defaultModel?: string | null; agentPermissionMode: string; sessionPermissionMode: string };
  paths: { claudeHome: string; stateDir: string };
  qoder: { cliBin: string; cliPermissionMode: string; qoderHome: string; qoderWorkHome: string; heartbeatTtlMs: number };
  im: {
    enabled: boolean; provider: string; dwsPath?: string; pollIntervalMs: number;
    channel: { conversationId: string; send: { type: 'user' | 'group' | 'openId'; target: string } };
    replyMarker: string;
    commandPrefix: string;
    allowedSenderIds: string[];
    confirmWords: string[]; cancelWords: string[]; confirmTtlMs: number;
  };
}

function expand(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

export function loadConfig(file = 'lifestream.config.json'): Config {
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return {
    web: { host: '127.0.0.1', port: 8787, token: '', ...(raw.web ?? {}) },
    tmux: { bin: 'tmux', socket: 'lifestream', ...(raw.tmux ?? {}) },
    claude: {
      bin: 'claude', defaultModel: null,
      // 信使 Agent（回 IM 消息的那个 claude）的权限模式。
      agentPermissionMode: 'bypassPermissions',
      // 被控会话（tmux 里跑的 claude）的权限模式，默认 bypassPermissions：
      // 远程无键盘，否则会话会卡在“This command requires approval”而 Web 无法应答。
      sessionPermissionMode: 'bypassPermissions',
      ...(raw.claude ?? {}),
    },
    paths: {
      claudeHome: expand(raw.paths?.claudeHome ?? '~/.claude'),
      stateDir: expand(raw.paths?.stateDir ?? '~/.lifestream'),
    },
    // Qoder 三个产品共用这一块：cli* 只给 qodercli，qoderWorkHome / heartbeatTtlMs 给桌面 source。
    qoder: {
      cliBin: raw.qoder?.cliBin ?? 'qodercli',
      // qodercli 的方言是下划线（Claude Code 是 bypassPermissions），flag 名相同。
      cliPermissionMode: raw.qoder?.cliPermissionMode ?? 'bypass_permissions',
      qoderHome: expand(raw.qoder?.qoderHome ?? '~/.qoder'),
      qoderWorkHome: expand(raw.qoder?.qoderWorkHome ?? '~/.qoderwork'),
      heartbeatTtlMs: raw.qoder?.heartbeatTtlMs ?? 30 * 60 * 1000,
    },
    im: {
      enabled: false, provider: 'dingtalk', pollIntervalMs: 3000,
      channel: { conversationId: '', send: { type: 'user', target: '' } },
      replyMarker: '🤖 ',
      commandPrefix: '',
      allowedSenderIds: [],
      confirmWords: ['确认', '确定', 'yes', 'y', 'ok'],
      cancelWords: ['取消', 'no', 'n'],
      confirmTtlMs: 300000,
      ...(raw.im ?? {}),
    },
  };
}
