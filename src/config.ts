import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export interface Config {
  web: { host: string; port: number; token: string };
  tmux: { bin: string; socket: string };
  claude: { bin: string; defaultModel?: string | null; agentPermissionMode: string };
  paths: { claudeHome: string; stateDir: string };
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
    claude: { bin: 'claude', defaultModel: null, agentPermissionMode: 'bypassPermissions', ...(raw.claude ?? {}) },
    paths: {
      claudeHome: expand(raw.paths?.claudeHome ?? '~/.claude'),
      stateDir: expand(raw.paths?.stateDir ?? '~/.lifestream'),
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
