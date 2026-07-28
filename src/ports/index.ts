import type { LiveSession, PendingAction } from '../domain/types.js';

export interface Clock { now(): number; }

export interface TmuxSessionInfo { name: string; windows: number; created: number; }
export interface TmuxAdapter {
  listSessions(): Promise<TmuxSessionInfo[]>;
  hasSession(name: string): Promise<boolean>;
  newSession(name: string, cwd: string, command: string[]): Promise<void>;
  sendText(name: string, text: string): Promise<void>;   // 多行安全: load-buffer -> paste-buffer -> Enter
  sendKeys(name: string, keys: string[]): Promise<void>;  // 原始按键: 裸 send-keys, 不强制回车(应答 TUI 选择器)
  capturePane(name: string): Promise<string>;
  killSession(name: string): Promise<void>;
}

export interface ClaudeHomeAdapter {
  readLiveSessions(): Promise<LiveSession[]>;
  locateTranscript(sessionId: string): Promise<string | null>;
  readTranscript(path: string): Promise<string[]>;
  readTranscriptFrom(path: string, byteOffset: number): Promise<{ lines: string[]; offset: number }>;
  watchProjects(cb: (changedPath: string) => void): () => void;
}

export interface ManagedEntry {
  sessionId: string; tmuxSession: string; cwd: string;
  origin: 'managed' | 'adopted'; createdAt: number;
}
export interface ManagedRegistry {
  list(): Promise<ManagedEntry[]>;
  get(sessionId: string): Promise<ManagedEntry | null>;
  put(entry: ManagedEntry): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

export interface PendingActionStore {
  get(conversationId: string): Promise<PendingAction[]>;
  set(conversationId: string, actions: PendingAction[]): Promise<void>;
  clear(conversationId: string): Promise<void>;
}

export interface InboundMessage {
  msgId: string; senderUid: string; senderName?: string;
  conversationId: string; text: string; ts: number;
}
export interface ImAdapter {
  poll(cursor: string | null): Promise<{ messages: InboundMessage[]; cursor: string }>;
  send(conversationId: string, text: string): Promise<void>;
}

export interface AgentRunner {
  handle(conversationKey: string, userText: string): Promise<string>;
  sessionIdFor?(conversationKey: string): string | undefined;
}

// 每设备动态令牌：主令牌(持久, PC 获取)登录后铸造，cookie 用它；可在设备管理界面撤销。
export interface Device {
  id: string;
  token: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  userAgent?: string;
}
export interface DeviceStore {
  list(): Promise<Device[]>;
  findByToken(token: string): Promise<Device | null>;
  put(device: Device): Promise<void>;
  touch(id: string, now: number): Promise<void>;
  remove(id: string): Promise<void>;
}
