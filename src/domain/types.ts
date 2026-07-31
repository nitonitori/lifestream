export type SessionStatus = 'busy' | 'idle' | 'unknown';
export type SessionOrigin = 'managed' | 'external' | 'adopted';

// 会话所属的 agent 内核（决定命令行方言与落盘约定）。
export type Kernel = 'claude' | 'qodercli' | 'qoderwork' | 'qoder-ide';

export interface CreateSessionOptions {
  cwd: string;
  kernel?: Kernel;
  name?: string;
  model?: string;
  permissionMode?: string;
  initialPrompt?: string;
}

// 来自 ~/.claude/sessions/<pid>.json
export interface LiveSession {
  pid?: number;   // 桌面 source 没有 pid
  kernel: Kernel;
  sessionId: string;
  cwd: string;
  name?: string;
  status: SessionStatus;
  version?: string;
  kind?: string;
  startedAt?: number;
  updatedAt?: number;
}

export interface SessionSummary {
  sessionId: string;
  kernel: Kernel;
  name?: string;
  cwd: string;
  status: SessionStatus;
  origin: SessionOrigin;
  live: boolean;
  controllable: boolean;
  adoptable: boolean;
  tmuxSession?: string;
  pid?: number;
  lastActivity?: number;
  createdAt?: number;
}

export interface SessionDetail extends SessionSummary {
  transcriptPath?: string;
  messageCount: number;
}

export type TranscriptEvent =
  | { kind: 'user'; uuid: string; ts: number; text: string; raw: unknown }
  | { kind: 'assistant'; uuid: string; ts: number; text: string; toolUses: { id: string; name: string; input: unknown }[]; raw: unknown }
  | { kind: 'tool_result'; uuid: string; ts: number; toolUseId: string; content: string; isError: boolean; raw: unknown }
  | { kind: 'meta'; uuid?: string; ts?: number; type: string; raw: unknown };

export type PlaneEvent =
  | { type: 'session.updated'; session: SessionSummary }
  | { type: 'session.removed'; sessionId: string }
  | { type: 'message'; sessionId: string; event: TranscriptEvent };

export type PendingActionKind = 'send' | 'create' | 'adopt';
export interface PendingAction {
  id: string;
  conversationId: string;
  kind: PendingActionKind;
  params: Record<string, unknown>;
  description: string;
  createdAt: number;
}
