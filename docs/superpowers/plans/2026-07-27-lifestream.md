# Lifestream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本机跑一个常驻服务，监控/控制所有 Claude Code 实例，并经 Web(鉴权) + 钉钉 IM(uid 白名单 + 变更确认) + MCP 控制面 三入口操作。

**Architecture:** 核心 `ControlPlane` 为纯逻辑域，通过注入的适配器接口(Tmux/ClaudeHome/Registry/Im/Agent/Clock)与副作用解耦。tmux 托管 PTY 实现同一-session 控制；transcript 解析走 `~/.claude` 文件。三入口共享一个 ControlPlane。

**Tech Stack:** TypeScript + Node v24 (ESM) + Fastify + @modelcontextprotocol/sdk + vitest + tsx。

参考: [RFC](../specs/2026-07-27-lifestream-rfc.md) · [SPEC](../specs/2026-07-27-lifestream-spec.md) · [STORY](../specs/2026-07-27-lifestream-story.md)

## Global Constraints

- Node `>=24`，`"type":"module"`，全 ESM，import 带 `.js` 后缀(TS NodeNext)。
- 全部副作用经 `src/ports/index.ts` 接口；`src/domain/*` 不得直接 import `node:fs`/`node:child_process`。
- 测试用 vitest；单元测试零真实 IO(用 `test/fakes/*`)。
- 领域错误类固定：`NotFoundError`/`NotControllableError`/`ConflictError`/`ValidationError`/`UpstreamError`(见 Task 5)。
- tmux 专用 socket 名来自 config(`tmux.socket`，默认 `lifestream`)；会话名 `lifestream-<uuid前8位>`。
- 每个 Task 结束必须 `git commit`；测试全绿才提交。
- cookie 名固定 `ls_token`；SSE 事件名 `status`/`message`。

## File Structure

```
src/
  domain/
    types.ts               # 领域类型(SPEC §2)
    errors.ts              # 领域错误类
    transcript-parser.ts   # JSONL 行 -> TranscriptEvent
    session-discovery.ts   # sessions/*.json 解析 + 摘要聚合
    control-plane.ts       # 核心编排(EventEmitter)
    pending.ts             # PendingAction 摘要构造(纯函数)
  ports/index.ts           # 适配器接口
  adapters/
    clock.ts               # SystemClock
    tmux.ts                # TmuxAdapter (execFile tmux -L)
    claude-home.ts         # ClaudeHomeAdapter (fs + watch)
    managed-registry.ts    # JSON 文件持久化
    pending-store.ts       # PendingActionStore JSON 文件持久化
    im-dingtalk.ts         # ImAdapter 封装 dws
    agent-runner.ts        # AgentRunner headless claude
  server/
    auth.ts                # 鉴权 preHandler
    sse.ts                 # SSE 广播器
    routes.ts              # REST + SSE 注册
    http.ts                # Fastify 装配
  mcp/control-mcp.ts       # MCP stdio server
  im/linker.ts             # 轮询+白名单+确认状态机
  config.ts                # 配置加载/校验
  cli.ts                   # lifestream 命令
  index.ts                 # 组合根
test/
  fakes/                   # FakeTmux/FakeClaudeHome/FakeIm/FakeAgent/FakeClock/InMemoryStores
  fixtures/                # 真实 JSONL/sessions 样本(脱敏)
  unit/ component/ integration/
web/                       # 静态前端
```

---

## Task 0: 项目脚手架

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`(已存在，追加), `src/domain/.gitkeep`

**Interfaces:**
- Produces: 可运行 `npm test`(0 用例通过)、`npx tsc --noEmit` 通过。

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "lifestream",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "bin": { "lifestream": "./dist/cli.js" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/cli.ts",
    "start": "node dist/cli.js"
  },
  "dependencies": {
    "fastify": "^5.2.0",
    "@fastify/cookie": "^11.0.2",
    "@fastify/static": "^8.0.4",
    "@modelcontextprotocol/sdk": "^1.12.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "vitest": "^3.0.0",
    "@types/node": "^24.0.0"
  }
}
```

- [ ] **Step 2: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: 写 vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
```

- [ ] **Step 4: 安装依赖**

Run: `npm install`
Expected: 无 error，生成 `node_modules` 与 `package-lock.json`。

- [ ] **Step 5: 验证空测试与类型**

Run: `npm test` → Expected: "No test files found" 或 0 passed(退出码 0，vitest run 空集返回 0)。
Run: `npm run typecheck` → Expected: 无输出、退出码 0。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold TS+vitest project"
```

---

## Task 1: 领域类型与错误 (types.ts, errors.ts)

**Files:**
- Create: `src/domain/types.ts`, `src/domain/errors.ts`
- Test: `test/unit/errors.test.ts`

**Interfaces:**
- Produces: SPEC §2 全部类型；错误类 `NotFoundError`/`NotControllableError`/`ConflictError`/`ValidationError`/`UpstreamError`，各有 `code: string` 字段与 `httpStatus: number`。

- [ ] **Step 1: 写失败测试 `test/unit/errors.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { NotFoundError, NotControllableError, ConflictError, ValidationError, UpstreamError } from '../../src/domain/errors.js';

describe('domain errors', () => {
  it('carry code and httpStatus', () => {
    expect(new NotFoundError('x').httpStatus).toBe(404);
    expect(new NotFoundError('x').code).toBe('NOT_FOUND');
    expect(new NotControllableError('x').httpStatus).toBe(409);
    expect(new ConflictError('x').httpStatus).toBe(409);
    expect(new ValidationError('x').httpStatus).toBe(400);
    expect(new UpstreamError('x').httpStatus).toBe(502);
  });
  it('are instanceof Error', () => {
    expect(new NotFoundError('x')).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/errors.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写 `src/domain/errors.ts`**

```ts
export class DomainError extends Error {
  constructor(message: string, readonly code: string, readonly httpStatus: number) {
    super(message);
    this.name = new.target.name;
  }
}
export class NotFoundError extends DomainError {
  constructor(msg: string) { super(msg, 'NOT_FOUND', 404); }
}
export class NotControllableError extends DomainError {
  constructor(msg: string) { super(msg, 'NOT_CONTROLLABLE', 409); }
}
export class ConflictError extends DomainError {
  constructor(msg: string) { super(msg, 'CONFLICT', 409); }
}
export class ValidationError extends DomainError {
  constructor(msg: string) { super(msg, 'VALIDATION', 400); }
}
export class UpstreamError extends DomainError {
  constructor(msg: string) { super(msg, 'UPSTREAM', 502); }
}
```

- [ ] **Step 4: 写 `src/domain/types.ts`** (从 SPEC §2 复制，完整)

```ts
export type SessionStatus = 'busy' | 'idle' | 'unknown';
export type SessionOrigin = 'managed' | 'external' | 'adopted';

export interface LiveSession {
  pid: number; sessionId: string; cwd: string; name?: string;
  status: SessionStatus; version?: string; kind?: string;
  startedAt?: number; updatedAt?: number;
}
export interface SessionSummary {
  sessionId: string; name?: string; cwd: string; status: SessionStatus;
  origin: SessionOrigin; live: boolean; controllable: boolean;
  tmuxSession?: string; pid?: number; lastActivity?: number;
}
export interface SessionDetail extends SessionSummary {
  transcriptPath?: string; messageCount: number;
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
  id: string; conversationId: string; kind: PendingActionKind;
  params: Record<string, unknown>; description: string; createdAt: number;
}
```

- [ ] **Step 5: 运行测试通过 + 类型检查**

Run: `npx vitest run test/unit/errors.test.ts` → PASS。
Run: `npm run typecheck` → 退出码 0。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(domain): types and error classes"
```

---

## Task 2: TranscriptParser (STORY A1)

**Files:**
- Create: `src/domain/transcript-parser.ts`
- Test: `test/unit/transcript-parser.test.ts`, `test/fixtures/transcript-lines.ts`

**Interfaces:**
- Produces:
  - `parseTranscriptLine(line: string): TranscriptEvent | null`
  - `parseTranscript(lines: string[]): TranscriptEvent[]` (过滤 null；按 uuid 去重，保留首次)

- [ ] **Step 1: 写 fixtures `test/fixtures/transcript-lines.ts`**

```ts
export const userLine = JSON.stringify({
  type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-07-27T02:53:09.041Z',
  message: { role: 'user', content: '你好' },
});
export const assistantToolLine = JSON.stringify({
  type: 'assistant', uuid: 'a1', timestamp: '2026-07-27T02:53:10.000Z',
  message: { role: 'assistant', content: [
    { type: 'text', text: '我来处理' },
    { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
  ] },
});
export const toolResultLine = JSON.stringify({
  type: 'user', uuid: 'r1', timestamp: '2026-07-27T02:53:11.000Z',
  message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tu1', content: 'file.txt', is_error: false },
  ] },
});
export const metaLine = JSON.stringify({ type: 'last-prompt', leafUuid: 'x', sessionId: 's' });
export const halfLine = '{"type":"user","uuid":"bad"'; // 非法 JSON
```

- [ ] **Step 2: 写失败测试 `test/unit/transcript-parser.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { parseTranscriptLine, parseTranscript } from '../../src/domain/transcript-parser.js';
import * as F from '../fixtures/transcript-lines.js';

describe('parseTranscriptLine', () => {
  it('parses user text (A1.AC1)', () => {
    const e = parseTranscriptLine(F.userLine)!;
    expect(e.kind).toBe('user');
    expect(e).toMatchObject({ uuid: 'u1', text: '你好' });
    expect(e.ts).toBe(Date.parse('2026-07-27T02:53:09.041Z'));
  });
  it('parses assistant text + tool_use (A1.AC2)', () => {
    const e = parseTranscriptLine(F.assistantToolLine)!;
    expect(e.kind).toBe('assistant');
    if (e.kind !== 'assistant') throw new Error();
    expect(e.text).toBe('我来处理');
    expect(e.toolUses).toEqual([{ id: 'tu1', name: 'Bash', input: { command: 'ls' } }]);
  });
  it('parses tool_result (A1.AC3)', () => {
    const e = parseTranscriptLine(F.toolResultLine)!;
    expect(e.kind).toBe('tool_result');
    if (e.kind !== 'tool_result') throw new Error();
    expect(e).toMatchObject({ toolUseId: 'tu1', content: 'file.txt', isError: false });
  });
  it('returns null on bad JSON (A1.AC4)', () => {
    expect(parseTranscriptLine(F.halfLine)).toBeNull();
    expect(parseTranscriptLine('')).toBeNull();
  });
  it('maps unknown/meta types to meta (A1.AC5)', () => {
    const e = parseTranscriptLine(F.metaLine)!;
    expect(e.kind).toBe('meta');
    if (e.kind !== 'meta') throw new Error();
    expect(e.type).toBe('last-prompt');
  });
});

describe('parseTranscript', () => {
  it('filters null and dedups by uuid', () => {
    const events = parseTranscript([F.userLine, F.userLine, F.halfLine, F.assistantToolLine]);
    expect(events.map(e => e.uuid)).toEqual(['u1', 'a1']);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run test/unit/transcript-parser.test.ts` → FAIL(模块不存在)。

- [ ] **Step 4: 写实现 `src/domain/transcript-parser.ts`**

```ts
import type { TranscriptEvent } from './types.js';

function toTs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text).join('\n');
  }
  return '';
}

export function parseTranscriptLine(line: string): TranscriptEvent | null {
  const s = line.trim();
  if (!s) return null;
  let o: any;
  try { o = JSON.parse(s); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const ts = toTs(o.timestamp);
  const msg = o.message;

  if (o.type === 'assistant' && msg && msg.role === 'assistant') {
    const content = Array.isArray(msg.content) ? msg.content : [];
    const toolUses = content.filter((b: any) => b?.type === 'tool_use')
      .map((b: any) => ({ id: b.id, name: b.name, input: b.input }));
    return { kind: 'assistant', uuid: o.uuid, ts: ts ?? 0, text: textFromContent(msg.content), toolUses, raw: o };
  }
  if (o.type === 'user' && msg && msg.role === 'user') {
    const content = msg.content;
    if (Array.isArray(content)) {
      const tr = content.find((b: any) => b?.type === 'tool_result');
      if (tr) {
        return { kind: 'tool_result', uuid: o.uuid, ts: ts ?? 0,
          toolUseId: tr.tool_use_id,
          content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          isError: !!tr.is_error, raw: o };
      }
    }
    return { kind: 'user', uuid: o.uuid, ts: ts ?? 0, text: textFromContent(content), raw: o };
  }
  return { kind: 'meta', uuid: o.uuid, ts, type: String(o.type ?? 'unknown'), raw: o };
}

export function parseTranscript(lines: string[]): TranscriptEvent[] {
  const seen = new Set<string>();
  const out: TranscriptEvent[] = [];
  for (const line of lines) {
    const e = parseTranscriptLine(line);
    if (!e) continue;
    const key = e.uuid;
    if (key) { if (seen.has(key)) continue; seen.add(key); }
    out.push(e);
  }
  return out;
}
```

- [ ] **Step 5: 运行测试通过**

Run: `npx vitest run test/unit/transcript-parser.test.ts` → PASS。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(domain): transcript parser (A1)"
```

---

## Task 3: SessionDiscovery (STORY A2, A3)

**Files:**
- Create: `src/domain/session-discovery.ts`
- Test: `test/unit/session-discovery.test.ts`

**Interfaces:**
- Consumes: `LiveSession`, `SessionSummary`, `ManagedEntry`(见 Task 4 ports；此处仅用其形状 `{sessionId,tmuxSession,cwd,origin}`)。
- Produces:
  - `deriveStatus(raw: any): SessionStatus`
  - `toLiveSession(raw: any, isPidAlive: (pid:number)=>boolean): LiveSession | null`
  - `buildSummaries(args: { live: LiveSession[]; managed: {sessionId:string;tmuxSession:string;cwd:string;origin:'managed'|'adopted'}[]; tmuxNames: Set<string>; activity: Map<string,number> }): SessionSummary[]`

- [ ] **Step 1: 写失败测试 `test/unit/session-discovery.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { deriveStatus, toLiveSession, buildSummaries } from '../../src/domain/session-discovery.js';

describe('deriveStatus', () => {
  it('maps busy/idle and defaults unknown (A2.AC2)', () => {
    expect(deriveStatus({ status: 'busy' })).toBe('busy');
    expect(deriveStatus({ status: 'idle' })).toBe('idle');
    expect(deriveStatus({})).toBe('unknown');
  });
});

describe('toLiveSession', () => {
  it('reads live session fields (A2.AC1)', () => {
    const raw = { pid: 100, sessionId: 's1', cwd: '/w', name: 'n', status: 'busy' };
    expect(toLiveSession(raw, () => true)).toMatchObject({ pid: 100, sessionId: 's1', cwd: '/w', status: 'busy' });
  });
  it('returns null when pid not alive (A2.AC3)', () => {
    expect(toLiveSession({ pid: 100, sessionId: 's1', cwd: '/w' }, () => false)).toBeNull();
  });
});

describe('buildSummaries', () => {
  it('managed+tmux => controllable (A3.AC2)', () => {
    const s = buildSummaries({
      live: [{ pid: 1, sessionId: 's1', cwd: '/w', status: 'idle' }],
      managed: [{ sessionId: 's1', tmuxSession: 'lifestream-s1', cwd: '/w', origin: 'managed' }],
      tmuxNames: new Set(['lifestream-s1']),
      activity: new Map([['s1', 123]]),
    })[0];
    expect(s).toMatchObject({ origin: 'managed', controllable: true, live: true, lastActivity: 123, tmuxSession: 'lifestream-s1' });
  });
  it('external live session => not controllable (A3.AC3)', () => {
    const s = buildSummaries({
      live: [{ pid: 2, sessionId: 's2', cwd: '/w2', status: 'busy' }],
      managed: [], tmuxNames: new Set(), activity: new Map(),
    })[0];
    expect(s).toMatchObject({ origin: 'external', controllable: false, live: true });
  });
  it('managed but tmux gone => not controllable', () => {
    const s = buildSummaries({
      live: [], managed: [{ sessionId: 's3', tmuxSession: 't3', cwd: '/w', origin: 'managed' }],
      tmuxNames: new Set(), activity: new Map(),
    })[0];
    expect(s).toMatchObject({ sessionId: 's3', live: false, controllable: false });
  });
});
```

- [ ] **Step 2: 运行确认失败** — `npx vitest run test/unit/session-discovery.test.ts` → FAIL。

- [ ] **Step 3: 写实现 `src/domain/session-discovery.ts`**

```ts
import type { LiveSession, SessionStatus, SessionSummary, SessionOrigin } from './types.js';

export function deriveStatus(raw: any): SessionStatus {
  return raw?.status === 'busy' ? 'busy' : raw?.status === 'idle' ? 'idle' : 'unknown';
}
export function toLiveSession(raw: any, isPidAlive: (pid: number) => boolean): LiveSession | null {
  if (!raw || typeof raw.pid !== 'number' || typeof raw.sessionId !== 'string') return null;
  if (!isPidAlive(raw.pid)) return null;
  return {
    pid: raw.pid, sessionId: raw.sessionId, cwd: raw.cwd ?? '', name: raw.name,
    status: deriveStatus(raw), version: raw.version, kind: raw.kind,
    startedAt: raw.startedAt, updatedAt: raw.updatedAt,
  };
}

interface ManagedShape { sessionId: string; tmuxSession: string; cwd: string; origin: 'managed' | 'adopted'; }
export function buildSummaries(args: {
  live: LiveSession[]; managed: ManagedShape[]; tmuxNames: Set<string>; activity: Map<string, number>;
}): SessionSummary[] {
  const { live, managed, tmuxNames, activity } = args;
  const liveById = new Map(live.map(l => [l.sessionId, l]));
  const managedById = new Map(managed.map(m => [m.sessionId, m]));
  const ids = new Set<string>([...liveById.keys(), ...managedById.keys()]);
  const out: SessionSummary[] = [];
  for (const id of ids) {
    const l = liveById.get(id);
    const m = managedById.get(id);
    const controllable = !!(m && tmuxNames.has(m.tmuxSession));
    const origin: SessionOrigin = m ? m.origin : 'external';
    out.push({
      sessionId: id, name: l?.name, cwd: l?.cwd ?? m?.cwd ?? '',
      status: l?.status ?? 'unknown', origin, live: !!l, controllable,
      tmuxSession: m?.tmuxSession, pid: l?.pid, lastActivity: activity.get(id),
    });
  }
  return out.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
}
```

- [ ] **Step 4: 运行测试通过** — PASS。
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(domain): session discovery + summary aggregation (A2,A3)"
```

---

## Task 4: 适配器接口 + 内存 fakes (ports/index.ts, test/fakes)

**Files:**
- Create: `src/ports/index.ts`, `test/fakes/index.ts`
- Test: `test/unit/fakes.test.ts` (自测 fakes 行为，保证后续任务可信赖)

**Interfaces:**
- Produces: SPEC §3 全部接口 + `ManagedEntry`/`PendingActionStore`；`test/fakes` 导出 `FakeClock`, `FakeTmux`, `FakeClaudeHome`, `InMemoryManagedRegistry`, `InMemoryPendingStore`, `FakeIm`, `FakeAgent`。

- [ ] **Step 1: 写 `src/ports/index.ts`** (完整，含 Task3 用到的 ManagedEntry)

```ts
import type { LiveSession, InboundMessage as _IM, PendingAction } from '../domain/types.js';
import type { InboundMessage } from './types-im.js';
export interface Clock { now(): number; }

export interface TmuxSessionInfo { name: string; windows: number; created: number; }
export interface TmuxAdapter {
  listSessions(): Promise<TmuxSessionInfo[]>;
  hasSession(name: string): Promise<boolean>;
  newSession(name: string, cwd: string, command: string[]): Promise<void>;
  sendText(name: string, text: string): Promise<void>;
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
}
```

> 注：删除上面 import 中重复/占位的 `types-im`；`InboundMessage` 直接在本文件定义(如上)。最终文件顶部只保留：`import type { LiveSession, PendingAction } from '../domain/types.js';`

- [ ] **Step 2: 写 `test/fakes/index.ts`**

```ts
import type {
  Clock, TmuxAdapter, TmuxSessionInfo, ClaudeHomeAdapter, ManagedRegistry, ManagedEntry,
  PendingActionStore, ImAdapter, InboundMessage, AgentRunner,
} from '../../src/ports/index.js';
import type { LiveSession, PendingAction } from '../../src/domain/types.js';

export class FakeClock implements Clock {
  constructor(public t = 1000) {}
  now() { return this.t; }
}
export class FakeTmux implements TmuxAdapter {
  sessions = new Map<string, { cwd: string; command: string[] }>();
  sent: { name: string; text: string }[] = [];
  async listSessions(): Promise<TmuxSessionInfo[]> {
    return [...this.sessions.keys()].map(name => ({ name, windows: 1, created: 0 }));
  }
  async hasSession(name: string) { return this.sessions.has(name); }
  async newSession(name: string, cwd: string, command: string[]) { this.sessions.set(name, { cwd, command }); }
  async sendText(name: string, text: string) {
    if (!this.sessions.has(name)) throw new Error('no session ' + name);
    this.sent.push({ name, text });
  }
  async capturePane() { return ''; }
  async killSession(name: string) { this.sessions.delete(name); }
}
export class FakeClaudeHome implements ClaudeHomeAdapter {
  live: LiveSession[] = [];
  transcripts = new Map<string, string[]>(); // sessionId -> lines
  paths = new Map<string, string>();         // sessionId -> path
  async readLiveSessions() { return this.live; }
  async locateTranscript(id: string) { return this.paths.get(id) ?? null; }
  async readTranscript(path: string) {
    for (const [id, p] of this.paths) if (p === path) return this.transcripts.get(id) ?? [];
    return [];
  }
  async readTranscriptFrom(path: string, _o: number) { return { lines: await this.readTranscript(path), offset: 0 }; }
  watchProjects(_cb: (p: string) => void) { return () => {}; }
}
export class InMemoryManagedRegistry implements ManagedRegistry {
  m = new Map<string, ManagedEntry>();
  async list() { return [...this.m.values()]; }
  async get(id: string) { return this.m.get(id) ?? null; }
  async put(e: ManagedEntry) { this.m.set(e.sessionId, e); }
  async remove(id: string) { this.m.delete(id); }
}
export class InMemoryPendingStore implements PendingActionStore {
  m = new Map<string, PendingAction[]>();
  async get(c: string) { return this.m.get(c) ?? []; }
  async set(c: string, a: PendingAction[]) { this.m.set(c, a); }
  async clear(c: string) { this.m.delete(c); }
}
export class FakeIm implements ImAdapter {
  inbox: InboundMessage[] = [];
  outbox: { conversationId: string; text: string }[] = [];
  async poll(_cursor: string | null) {
    const messages = this.inbox; this.inbox = [];
    return { messages, cursor: String(Date.now()) };
  }
  async send(conversationId: string, text: string) { this.outbox.push({ conversationId, text }); }
}
export class FakeAgent implements AgentRunner {
  calls: { key: string; text: string }[] = [];
  responder: (key: string, text: string) => Promise<string> | string = () => 'ok';
  async handle(key: string, text: string) { this.calls.push({ key, text }); return this.responder(key, text); }
}
```

- [ ] **Step 3: 写 `test/unit/fakes.test.ts`** (自测 fakes)

```ts
import { describe, it, expect } from 'vitest';
import { FakeTmux, FakeIm } from '../fakes/index.js';

describe('fakes', () => {
  it('FakeTmux records newSession/sendText', async () => {
    const t = new FakeTmux();
    await t.newSession('n', '/w', ['claude']);
    expect(await t.hasSession('n')).toBe(true);
    await t.sendText('n', 'hi');
    expect(t.sent).toEqual([{ name: 'n', text: 'hi' }]);
  });
  it('FakeTmux.sendText throws on missing session', async () => {
    await expect(new FakeTmux().sendText('x', 'y')).rejects.toThrow();
  });
  it('FakeIm poll drains inbox', async () => {
    const im = new FakeIm();
    im.inbox.push({ msgId: '1', senderUid: 'u', conversationId: 'c', text: 't', ts: 0 });
    expect((await im.poll(null)).messages).toHaveLength(1);
    expect((await im.poll(null)).messages).toHaveLength(0);
  });
});
```

- [ ] **Step 4: 运行 + 类型检查** — `npx vitest run test/unit/fakes.test.ts` PASS；`npm run typecheck` 退出码 0(修正 Step 1 注中提到的 import)。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ports): adapter interfaces + in-memory fakes (A/B infra)"
```

---

## Task 5: ControlPlane 核心 (STORY A3, B2, B3, B4, B5)

**Files:**
- Create: `src/domain/control-plane.ts`
- Test: `test/unit/control-plane.test.ts`

**Interfaces:**
- Consumes: ports(Task4)、domain(Task1/2/3)。
- Produces: `class ControlPlane extends EventEmitter`：
  - `constructor(deps: { tmux; home; registry; clock; claudeBin: string; tmuxSocket: string; newSessionId: () => string })`
  - `listSessions(): Promise<SessionSummary[]>`
  - `getSession(id): Promise<SessionDetail>`
  - `getMessages(id, opts?: {sinceUuid?; limit?}): Promise<TranscriptEvent[]>`
  - `sendMessage(id, text): Promise<void>`
  - `createSession(opts: {cwd; name?; model?; permissionMode?; initialPrompt?}): Promise<SessionSummary>`
  - `adoptSession(id, opts?: {force?}): Promise<SessionSummary>`
  - `pollOnce(): Promise<void>` (发现轮询一轮，发 `session.updated`/`session.removed`)
  - `ingestTranscript(id): Promise<void>` (读增量并发 `message`；按 uuid 去重)
  - `start()/stop()`(启动定时 pollOnce + watch → ingest)
- 命名常量: `tmuxNameFor(id) = 'lifestream-' + id.slice(0,8)`

- [ ] **Step 1: 写失败测试 `test/unit/control-plane.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ControlPlane } from '../../src/domain/control-plane.js';
import { FakeClock, FakeTmux, FakeClaudeHome, InMemoryManagedRegistry } from '../fakes/index.js';
import { NotFoundError, NotControllableError, ConflictError } from '../../src/domain/errors.js';
import { userLine } from '../fixtures/transcript-lines.js';

function make() {
  const tmux = new FakeTmux();
  const home = new FakeClaudeHome();
  const registry = new InMemoryManagedRegistry();
  const clock = new FakeClock(5000);
  let n = 0;
  const plane = new ControlPlane({
    tmux, home, registry, clock, claudeBin: 'claude', tmuxSocket: 'lifestream',
    newSessionId: () => `00000000-0000-0000-0000-00000000000${++n}`,
  });
  return { plane, tmux, home, registry, clock };
}

describe('createSession (B2)', () => {
  it('starts tmux with --session-id and registers, controllable', async () => {
    const { plane, tmux, registry } = make();
    const s = await plane.createSession({ cwd: '/w' });
    expect(s.origin).toBe('managed');
    expect(s.controllable).toBe(true);
    const entry = await registry.get(s.sessionId);
    expect(entry?.tmuxSession).toBe('lifestream-' + s.sessionId.slice(0, 8));
    const created = tmux.sessions.get(entry!.tmuxSession)!;
    expect(created.command).toEqual(['claude', '--session-id', s.sessionId]);
    expect(created.cwd).toBe('/w');
  });
  it('passes model and initialPrompt (sends after start)', async () => {
    const { plane, tmux } = make();
    const s = await plane.createSession({ cwd: '/w', model: 'sonnet', initialPrompt: 'go' });
    const name = 'lifestream-' + s.sessionId.slice(0, 8);
    expect(tmux.sessions.get(name)!.command).toEqual(['claude', '--session-id', s.sessionId, '--model', 'sonnet']);
    expect(tmux.sent).toEqual([{ name, text: 'go' }]);
  });
});

describe('sendMessage (B3)', () => {
  it('sends to managed session tmux', async () => {
    const { plane, tmux } = make();
    const s = await plane.createSession({ cwd: '/w' });
    await plane.sendMessage(s.sessionId, 'hello');
    expect(tmux.sent.at(-1)).toEqual({ name: 'lifestream-' + s.sessionId.slice(0, 8), text: 'hello' });
  });
  it('throws NotControllableError for external live session', async () => {
    const { plane, home } = make();
    home.live = [{ pid: 1, sessionId: 'ext', cwd: '/w', status: 'busy' }];
    await expect(plane.sendMessage('ext', 'x')).rejects.toBeInstanceOf(NotControllableError);
  });
  it('throws NotFoundError for unknown id', async () => {
    const { plane } = make();
    await expect(plane.sendMessage('nope', 'x')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('adoptSession (B4)', () => {
  it('resumes external (not live) into tmux', async () => {
    const { plane, tmux, home, registry } = make();
    home.paths.set('ext', '/p/ext.jsonl');
    home.transcripts.set('ext', [JSON.stringify({ type: 'meta', cwd: '/wext', sessionId: 'ext' })]);
    const s = await plane.adoptSession('ext');
    expect(s.origin).toBe('adopted');
    const name = 'lifestream-ext';
    expect(tmux.sessions.get(name)!.command).toEqual(['claude', '--resume', 'ext']);
    expect(tmux.sessions.get(name)!.cwd).toBe('/wext');
    expect((await registry.get('ext'))?.origin).toBe('adopted');
  });
  it('rejects when session still live without force', async () => {
    const { plane, home } = make();
    home.live = [{ pid: 9, sessionId: 'ext', cwd: '/w', status: 'busy' }];
    await expect(plane.adoptSession('ext')).rejects.toBeInstanceOf(ConflictError);
  });
  it('force adopts live session', async () => {
    const { plane, home } = make();
    home.live = [{ pid: 9, sessionId: 'ext', cwd: '/w', status: 'busy' }];
    const s = await plane.adoptSession('ext', { force: true });
    expect(s.origin).toBe('adopted');
  });
});

describe('getMessages', () => {
  it('parses located transcript with limit/sinceUuid', async () => {
    const { plane, home } = make();
    home.paths.set('s1', '/p/s1.jsonl');
    home.transcripts.set('s1', [userLine]);
    const msgs = await plane.getMessages('s1');
    expect(msgs[0]).toMatchObject({ kind: 'user', text: '你好' });
  });
});

describe('pollOnce events (B5)', () => {
  it('emits session.updated for live sessions', async () => {
    const { plane, home } = make();
    home.live = [{ pid: 1, sessionId: 's1', cwd: '/w', status: 'busy' }];
    const events: any[] = [];
    plane.on('event', e => events.push(e));
    await plane.pollOnce();
    expect(events.some(e => e.type === 'session.updated' && e.session.sessionId === 's1')).toBe(true);
  });
  it('emits session.removed when a previously seen session disappears', async () => {
    const { plane, home } = make();
    home.live = [{ pid: 1, sessionId: 's1', cwd: '/w', status: 'busy' }];
    await plane.pollOnce();
    home.live = [];
    const events: any[] = [];
    plane.on('event', e => events.push(e));
    await plane.pollOnce();
    expect(events).toContainEqual({ type: 'session.removed', sessionId: 's1' });
  });
});

describe('ingestTranscript dedup (B5.AC3)', () => {
  it('emits message once per uuid across calls', async () => {
    const { plane, home } = make();
    home.paths.set('s1', '/p/s1.jsonl');
    home.transcripts.set('s1', [userLine]);
    const events: any[] = [];
    plane.on('event', e => { if (e.type === 'message') events.push(e); });
    await plane.ingestTranscript('s1');
    await plane.ingestTranscript('s1');
    expect(events).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行确认失败** — FAIL(模块不存在)。

- [ ] **Step 3: 写实现 `src/domain/control-plane.ts`**

```ts
import { EventEmitter } from 'node:events';
import type {
  TmuxAdapter, ClaudeHomeAdapter, ManagedRegistry, Clock, ManagedEntry,
} from '../ports/index.js';
import type { SessionSummary, SessionDetail, TranscriptEvent, PlaneEvent } from './types.js';
import { NotFoundError, NotControllableError, ConflictError } from './errors.js';
import { parseTranscript } from './transcript-parser.js';
import { buildSummaries } from './session-discovery.js';

export function tmuxNameFor(id: string) { return 'lifestream-' + id.slice(0, 8); }

interface Deps {
  tmux: TmuxAdapter; home: ClaudeHomeAdapter; registry: ManagedRegistry; clock: Clock;
  claudeBin: string; tmuxSocket: string; newSessionId: () => string;
  pollIntervalMs?: number;
}

export class ControlPlane extends EventEmitter {
  private lastSeen = new Set<string>();
  private emittedUuids = new Map<string, Set<string>>(); // sessionId -> uuids
  private timer?: NodeJS.Timeout;
  private unwatch?: () => void;

  constructor(private d: Deps) { super(); }

  private emitEvent(e: PlaneEvent) { this.emit('event', e); }

  private async lastActivity(): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    for (const entry of await this.d.registry.list()) {
      const p = await this.d.home.locateTranscript(entry.sessionId);
      if (!p) continue;
      const evs = parseTranscript(await this.d.home.readTranscript(p));
      const last = evs.at(-1); if (last?.ts) m.set(entry.sessionId, last.ts);
    }
    return m;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const live = await this.d.home.readLiveSessions();
    const managed = await this.d.registry.list();
    const tmuxNames = new Set((await this.d.tmux.listSessions()).map(t => t.name));
    const activity = new Map<string, number>();
    for (const id of new Set([...live.map(l => l.sessionId), ...managed.map(m => m.sessionId)])) {
      const p = await this.d.home.locateTranscript(id);
      if (p) { const last = parseTranscript(await this.d.home.readTranscript(p)).at(-1); if (last?.ts) activity.set(id, last.ts); }
    }
    return buildSummaries({ live, managed, tmuxNames, activity });
  }

  async getSession(id: string): Promise<SessionDetail> {
    const s = (await this.listSessions()).find(x => x.sessionId === id);
    if (!s) throw new NotFoundError('session not found: ' + id);
    const path = await this.d.home.locateTranscript(id);
    const count = path ? parseTranscript(await this.d.home.readTranscript(path)).length : 0;
    return { ...s, transcriptPath: path ?? undefined, messageCount: count };
  }

  async getMessages(id: string, opts: { sinceUuid?: string; limit?: number } = {}): Promise<TranscriptEvent[]> {
    const path = await this.d.home.locateTranscript(id);
    if (!path) return [];
    let events = parseTranscript(await this.d.home.readTranscript(path));
    if (opts.sinceUuid) {
      const idx = events.findIndex(e => e.uuid === opts.sinceUuid);
      if (idx >= 0) events = events.slice(idx + 1);
    }
    if (opts.limit && events.length > opts.limit) events = events.slice(-opts.limit);
    return events;
  }

  async sendMessage(id: string, text: string): Promise<void> {
    const entry = await this.d.registry.get(id);
    if (entry && await this.d.tmux.hasSession(entry.tmuxSession)) {
      await this.d.tmux.sendText(entry.tmuxSession, text);
      return;
    }
    const live = await this.d.home.readLiveSessions();
    if (live.some(l => l.sessionId === id)) {
      throw new NotControllableError('session is external/not managed; adopt it first: ' + id);
    }
    throw new NotFoundError('session not found: ' + id);
  }

  async createSession(opts: { cwd: string; name?: string; model?: string; permissionMode?: string; initialPrompt?: string }): Promise<SessionSummary> {
    const id = this.d.newSessionId();
    const name = tmuxNameFor(id);
    const cmd = [this.d.claudeBin, '--session-id', id];
    if (opts.model) cmd.push('--model', opts.model);
    if (opts.permissionMode) cmd.push('--permission-mode', opts.permissionMode);
    if (opts.name) cmd.push('--name', opts.name);
    await this.d.tmux.newSession(name, opts.cwd, cmd);
    const entry: ManagedEntry = { sessionId: id, tmuxSession: name, cwd: opts.cwd, origin: 'managed', createdAt: this.d.clock.now() };
    await this.d.registry.put(entry);
    if (opts.initialPrompt) await this.d.tmux.sendText(name, opts.initialPrompt);
    return { sessionId: id, name: opts.name, cwd: opts.cwd, status: 'unknown', origin: 'managed', live: true, controllable: true, tmuxSession: name };
  }

  private async resolveCwd(id: string): Promise<string> {
    const live = await this.d.home.readLiveSessions();
    const l = live.find(x => x.sessionId === id);
    if (l?.cwd) return l.cwd;
    const path = await this.d.home.locateTranscript(id);
    if (path) {
      for (const line of await this.d.home.readTranscript(path)) {
        try { const o = JSON.parse(line); if (o?.cwd) return o.cwd; } catch { /* skip */ }
      }
    }
    return process.cwd();
  }

  async adoptSession(id: string, opts: { force?: boolean } = {}): Promise<SessionSummary> {
    const live = await this.d.home.readLiveSessions();
    if (live.some(l => l.sessionId === id) && !opts.force) {
      throw new ConflictError('session still running; exit its window first or use force: ' + id);
    }
    const cwd = await this.resolveCwd(id);
    const name = tmuxNameFor(id);
    await this.d.tmux.newSession(name, cwd, [this.d.claudeBin, '--resume', id]);
    await this.d.registry.put({ sessionId: id, tmuxSession: name, cwd, origin: 'adopted', createdAt: this.d.clock.now() });
    return { sessionId: id, cwd, status: 'unknown', origin: 'adopted', live: true, controllable: true, tmuxSession: name };
  }

  async pollOnce(): Promise<void> {
    const summaries = await this.listSessions();
    const now = new Set(summaries.map(s => s.sessionId));
    for (const s of summaries) this.emitEvent({ type: 'session.updated', session: s });
    for (const id of this.lastSeen) if (!now.has(id)) this.emitEvent({ type: 'session.removed', sessionId: id });
    this.lastSeen = now;
  }

  async ingestTranscript(id: string): Promise<void> {
    const path = await this.d.home.locateTranscript(id);
    if (!path) return;
    const seen = this.emittedUuids.get(id) ?? new Set<string>();
    for (const e of parseTranscript(await this.d.home.readTranscript(path))) {
      if (e.uuid && seen.has(e.uuid)) continue;
      if (e.uuid) seen.add(e.uuid);
      this.emitEvent({ type: 'message', sessionId: id, event: e });
    }
    this.emittedUuids.set(id, seen);
  }

  async start(): Promise<void> {
    await this.pollOnce();
    this.timer = setInterval(() => { void this.pollOnce(); }, this.d.pollIntervalMs ?? 2000);
    this.unwatch = this.d.home.watchProjects((changed) => {
      const m = changed.match(/([0-9a-f-]{36})\.jsonl$/i);
      if (m) void this.ingestTranscript(m[1]);
    });
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.unwatch?.();
  }
}
```

- [ ] **Step 4: 运行测试通过** — `npx vitest run test/unit/control-plane.test.ts` PASS；`npm run typecheck` 0。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(domain): ControlPlane core — create/send/adopt/messages/events (A3,B2-B5)"
```

---

## Task 6: 真实适配器 — Clock / ManagedRegistry / PendingStore

**Files:**
- Create: `src/adapters/clock.ts`, `src/adapters/managed-registry.ts`, `src/adapters/pending-store.ts`
- Test: `test/unit/json-stores.test.ts`

**Interfaces:**
- Produces: `SystemClock`; `FileManagedRegistry(path)`; `FilePendingStore(path)` — 与 `InMemory*` 同接口，落盘 JSON。

- [ ] **Step 1: 写失败测试 `test/unit/json-stores.test.ts`** (用 `os.tmpdir()` 临时文件)

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileManagedRegistry } from '../../src/adapters/managed-registry.js';
import { FilePendingStore } from '../../src/adapters/pending-store.js';

const dir = () => mkdtempSync(join(tmpdir(), 'ls-'));

describe('FileManagedRegistry', () => {
  it('persists and reloads entries', async () => {
    const f = join(dir(), 'managed.json');
    const r1 = new FileManagedRegistry(f);
    await r1.put({ sessionId: 's1', tmuxSession: 't1', cwd: '/w', origin: 'managed', createdAt: 1 });
    const r2 = new FileManagedRegistry(f);
    expect((await r2.get('s1'))?.tmuxSession).toBe('t1');
    await r2.remove('s1');
    expect(await r2.get('s1')).toBeNull();
  });
});
describe('FilePendingStore', () => {
  it('persists actions per conversation', async () => {
    const f = join(dir(), 'pending.json');
    const p = new FilePendingStore(f);
    await p.set('c1', [{ id: 'a', conversationId: 'c1', kind: 'send', params: {}, description: 'd', createdAt: 0 }]);
    expect(await new FilePendingStore(f).get('c1')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行确认失败** — FAIL。

- [ ] **Step 3: 写实现**

`src/adapters/clock.ts`:
```ts
import type { Clock } from '../ports/index.js';
export class SystemClock implements Clock { now() { return Date.now(); } }
```

`src/adapters/managed-registry.ts`:
```ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ManagedRegistry, ManagedEntry } from '../ports/index.js';

export class FileManagedRegistry implements ManagedRegistry {
  constructor(private file: string) {}
  private read(): ManagedEntry[] {
    if (!existsSync(this.file)) return [];
    try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return []; }
  }
  private write(rows: ManagedEntry[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(rows, null, 2));
  }
  async list() { return this.read(); }
  async get(id: string) { return this.read().find(e => e.sessionId === id) ?? null; }
  async put(e: ManagedEntry) {
    const rows = this.read().filter(r => r.sessionId !== e.sessionId); rows.push(e); this.write(rows);
  }
  async remove(id: string) { this.write(this.read().filter(r => r.sessionId !== id)); }
}
```

`src/adapters/pending-store.ts`:
```ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PendingActionStore } from '../ports/index.js';
import type { PendingAction } from '../domain/types.js';

export class FilePendingStore implements PendingActionStore {
  constructor(private file: string) {}
  private read(): Record<string, PendingAction[]> {
    if (!existsSync(this.file)) return {};
    try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return {}; }
  }
  private write(o: Record<string, PendingAction[]>) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(o, null, 2));
  }
  async get(c: string) { return this.read()[c] ?? []; }
  async set(c: string, a: PendingAction[]) { const o = this.read(); o[c] = a; this.write(o); }
  async clear(c: string) { const o = this.read(); delete o[c]; this.write(o); }
}
```

- [ ] **Step 4: 运行测试通过** — PASS。
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(adapters): SystemClock + file-backed managed/pending stores"
```

---

## Task 7: TmuxAdapter 真实现 (STORY B1)

**Files:**
- Create: `src/adapters/tmux.ts`
- Test: `test/integration/tmux.test.ts` (需真实 tmux；用专用 socket `ls-test`)

**Interfaces:**
- Produces: `class Tmux implements TmuxAdapter`，`constructor(socket: string, bin='tmux')`。
- `sendText` 用 **load-buffer(stdin) → paste-buffer → Enter**(D8)。

- [ ] **Step 1: 写集成测试 `test/integration/tmux.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { Tmux } from '../../src/adapters/tmux.js';

const tmux = new Tmux('ls-test');
const NAME = 'ls-it-' + process.pid;
afterAll(async () => { try { await tmux.killSession(NAME); } catch {} });

describe('Tmux (integration)', () => {
  it('new/has/capture/send/kill roundtrip (B1)', async () => {
    await tmux.newSession(NAME, process.cwd(), ['sh', '-c', 'cat > /tmp/ls-it-out']);
    expect(await tmux.hasSession(NAME)).toBe(true);
    await tmux.sendText(NAME, 'line-one\nline-two');
    await new Promise(r => setTimeout(r, 400));
    await tmux.killSession(NAME);
    expect(await tmux.hasSession(NAME)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败** — FAIL(模块不存在)。

- [ ] **Step 3: 写实现 `src/adapters/tmux.ts`**

```ts
import { execFile } from 'node:child_process';
import type { TmuxAdapter, TmuxSessionInfo } from '../ports/index.js';
import { UpstreamError } from '../domain/errors.js';

export class Tmux implements TmuxAdapter {
  constructor(private socket: string, private bin = 'tmux') {}
  private run(args: string[], stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(this.bin, ['-L', this.socket, ...args], (err, stdout, stderr) => {
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
    } catch { return []; } // no server yet => empty
  }
  async hasSession(name: string) {
    try { await this.run(['has-session', '-t', name]); return true; } catch { return false; }
  }
  async newSession(name: string, cwd: string, command: string[]) {
    await this.run(['new-session', '-d', '-s', name, '-c', cwd, ...command]);
  }
  async sendText(name: string, text: string) {
    const buf = 'ls-' + Date.now();
    await this.run(['load-buffer', '-b', buf, '-'], text);
    await this.run(['paste-buffer', '-d', '-b', buf, '-t', name]);
    await this.run(['send-keys', '-t', name, 'Enter']);
  }
  async capturePane(name: string) { return this.run(['capture-pane', '-p', '-t', name]); }
  async killSession(name: string) { await this.run(['kill-session', '-t', name]); }
}
```

- [ ] **Step 4: 运行测试通过** — `npx vitest run test/integration/tmux.test.ts` PASS。
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(adapters): real Tmux adapter with load-buffer/paste-buffer (B1)"
```

---

## Task 8: ClaudeHomeAdapter 真实现 (STORY A2 支撑)

**Files:**
- Create: `src/adapters/claude-home.ts`
- Test: `test/integration/claude-home.test.ts` (用临时目录模拟 ~/.claude 结构)

**Interfaces:**
- Produces: `class ClaudeHome implements ClaudeHomeAdapter`，`constructor(home: string)` (home = ~/.claude 路径)。
  - `readLiveSessions`: 读 `<home>/sessions/*.json`，`toLiveSession(raw, isPidAlive)`，`isPidAlive = pid => { try{process.kill(pid,0);return true}catch(e){return e.code==='EPERM'} }`
  - `locateTranscript`: 扫描 `<home>/projects/*/<id>.jsonl`
  - `readTranscript`: 按行读文件
  - `watchProjects`: `fs.watch(<home>/projects, {recursive:true})`

- [ ] **Step 1: 写集成测试 `test/integration/claude-home.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeHome } from '../../src/adapters/claude-home.js';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'lsh-'));
  mkdirSync(join(home, 'sessions'), { recursive: true });
  mkdirSync(join(home, 'projects', '-w-proj'), { recursive: true });
  writeFileSync(join(home, 'sessions', '111.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', cwd: '/w', status: 'idle' }));
  writeFileSync(join(home, 'projects', '-w-proj', 's1.jsonl'), JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }) + '\n');
  return new ClaudeHome(home);
}
describe('ClaudeHome (integration)', () => {
  it('reads live sessions for alive pid (A2.AC1)', async () => {
    const live = await setup().readLiveSessions();
    expect(live.find(l => l.sessionId === 's1')).toMatchObject({ cwd: '/w', status: 'idle' });
  });
  it('locates and reads transcript by sessionId', async () => {
    const h = setup();
    const p = await h.locateTranscript('s1');
    expect(p).toContain('s1.jsonl');
    expect((await h.readTranscript(p!))[0]).toContain('"uuid":"u1"');
  });
});
```

- [ ] **Step 2: 运行确认失败** — FAIL。

- [ ] **Step 3: 写实现 `src/adapters/claude-home.ts`**

```ts
import { readdirSync, readFileSync, existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeHomeAdapter } from '../ports/index.js';
import type { LiveSession } from '../domain/types.js';
import { toLiveSession } from '../domain/session-discovery.js';

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}
export class ClaudeHome implements ClaudeHomeAdapter {
  constructor(private home: string) {}
  async readLiveSessions(): Promise<LiveSession[]> {
    const dir = join(this.home, 'sessions');
    if (!existsSync(dir)) return [];
    const out: LiveSession[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        const ls = toLiveSession(raw, isPidAlive);
        if (ls) out.push(ls);
      } catch { /* skip */ }
    }
    return out;
  }
  async locateTranscript(sessionId: string): Promise<string | null> {
    const proj = join(this.home, 'projects');
    if (!existsSync(proj)) return null;
    for (const d of readdirSync(proj)) {
      const p = join(proj, d, `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
    return null;
  }
  async readTranscript(path: string): Promise<string[]> {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter(Boolean);
  }
  async readTranscriptFrom(path: string, byteOffset: number) {
    const buf = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
    const slice = buf.subarray(byteOffset).toString('utf8');
    return { lines: slice.split('\n').filter(Boolean), offset: buf.length };
  }
  watchProjects(cb: (changedPath: string) => void): () => void {
    const proj = join(this.home, 'projects');
    if (!existsSync(proj)) return () => {};
    const w = watch(proj, { recursive: true }, (_e, fname) => { if (fname) cb(String(fname)); });
    return () => w.close();
  }
}
```

- [ ] **Step 4: 运行测试通过** — PASS。
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(adapters): ClaudeHome adapter (sessions + transcript + watch)"
```

---

## Task 9: CLI 只读监控 (STORY A4)

**Files:**
- Create: `src/config.ts` (最小版，仅路径), `src/cli.ts`
- Test: `test/integration/cli.test.ts`

**Interfaces:**
- Consumes: `ControlPlane`, `ClaudeHome`, `Tmux`, `FileManagedRegistry`, `SystemClock`。
- Produces: `lifestream sessions` 打印会话表；`lifestream tail <id>` 打印消息。`buildPlane(cfg)` 工厂(供 CLI 与 server 复用)。
- 命令解析用最小手写 argv(无需第三方)。

- [ ] **Step 1: 写 `src/config.ts`(最小)**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export interface Config {
  web: { host: string; port: number; token: string };
  tmux: { bin: string; socket: string };
  claude: { bin: string; defaultModel?: string | null };
  paths: { claudeHome: string; stateDir: string };
  im: { enabled: boolean; provider: string; dwsPath?: string; pollIntervalMs: number;
        conversationId?: string; allowedUids: string[]; confirmWords: string[]; cancelWords: string[]; confirmTtlMs: number };
}
function expand(p: string) { return p.startsWith('~') ? join(homedir(), p.slice(1)) : p; }
export function loadConfig(file = 'lifestream.config.json'): Config {
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const cfg: Config = {
    web: { host: '127.0.0.1', port: 8787, token: '', ...(raw.web ?? {}) },
    tmux: { bin: 'tmux', socket: 'lifestream', ...(raw.tmux ?? {}) },
    claude: { bin: 'claude', defaultModel: null, ...(raw.claude ?? {}) },
    paths: { claudeHome: expand(raw.paths?.claudeHome ?? '~/.claude'), stateDir: expand(raw.paths?.stateDir ?? '~/.lifestream') },
    im: { enabled: false, provider: 'dingtalk', pollIntervalMs: 3000, allowedUids: [],
          confirmWords: ['确认', '确定', 'yes', 'y', 'ok'], cancelWords: ['取消', 'no', 'n'], confirmTtlMs: 300000, ...(raw.im ?? {}) },
  };
  return cfg;
}
```

- [ ] **Step 2: 写 `src/cli.ts`** (含 `buildPlane`)

```ts
import { join } from 'node:path';
import { loadConfig, type Config } from './config.js';
import { ControlPlane } from './domain/control-plane.js';
import { ClaudeHome } from './adapters/claude-home.js';
import { Tmux } from './adapters/tmux.js';
import { FileManagedRegistry } from './adapters/managed-registry.js';
import { SystemClock } from './adapters/clock.js';
import { randomUUID } from 'node:crypto';

export function buildPlane(cfg: Config): ControlPlane {
  return new ControlPlane({
    tmux: new Tmux(cfg.tmux.socket, cfg.tmux.bin),
    home: new ClaudeHome(cfg.paths.claudeHome),
    registry: new FileManagedRegistry(join(cfg.paths.stateDir, 'managed.json')),
    clock: new SystemClock(),
    claudeBin: cfg.claude.bin, tmuxSocket: cfg.tmux.socket, newSessionId: () => randomUUID(),
  });
}
async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const cfg = loadConfig();
  const plane = buildPlane(cfg);
  if (cmd === 'sessions') {
    for (const s of await plane.listSessions())
      console.log(`${s.status.padEnd(7)} ${s.controllable ? 'ctl' : '   '} ${s.sessionId.slice(0, 8)} ${s.name ?? ''} ${s.cwd}`);
  } else if (cmd === 'tail' && arg) {
    for (const e of await plane.getMessages(arg))
      console.log(`[${e.kind}] ${(e as any).text ?? (e as any).content ?? (e as any).type ?? ''}`);
  } else if (cmd === 'serve') {
    const { startServer } = await import('./index.js');
    await startServer(cfg);
  } else {
    console.log('usage: lifestream <sessions|tail <id>|serve>');
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 3: 写测试 `test/integration/cli.test.ts`** (spawn tsx，断言输出)

```ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
it('cli sessions runs without crash (A4.AC1)', () => {
  const out = execFileSync('npx', ['tsx', 'src/cli.ts', 'sessions'], { encoding: 'utf8' });
  expect(typeof out).toBe('string');
});
```

- [ ] **Step 4: 运行** — `npx vitest run test/integration/cli.test.ts` PASS(注意：`serve` 依赖 Task15 的 index.ts；此步先让 `import('./index.js')` 存在一个占位 `export async function startServer(){}`，或在 Task15 前 CLI 不含 serve 分支。**决定：** 现在就建 `src/index.ts` 占位，Task15 再补全)。

创建占位 `src/index.ts`:
```ts
import type { Config } from './config.js';
export async function startServer(_cfg: Config): Promise<void> { throw new Error('not implemented until Task 15'); }
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(cli): config loader + read-only monitor CLI (A4)"
```

---

## Task 10: 鉴权中间件 + SSE 广播 (STORY C1, C3 基础)

**Files:**
- Create: `src/server/auth.ts`, `src/server/sse.ts`
- Test: `test/unit/auth.test.ts`, `test/unit/sse.test.ts`

**Interfaces:**
- Produces:
  - `checkToken(provided: string|undefined, expected: string): boolean` (timingSafe，空/不等 → false)
  - `extractToken(req: {headers; cookies}): string|undefined` (先 cookie `ls_token` 后 `Authorization: Bearer`)
  - `class SseHub` — `add(res)/remove(res)/broadcast(event, data)`；`send(res,event,data)`。

- [ ] **Step 1: 写失败测试 `test/unit/auth.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { checkToken, extractToken } from '../../src/server/auth.js';
describe('checkToken', () => {
  it('true only on exact match (C1.AC3)', () => {
    expect(checkToken('abc', 'abc')).toBe(true);
    expect(checkToken('abc', 'abd')).toBe(false);
    expect(checkToken(undefined, 'abc')).toBe(false);
    expect(checkToken('', '')).toBe(false); // empty expected never passes
  });
});
describe('extractToken', () => {
  it('prefers cookie then bearer', () => {
    expect(extractToken({ headers: {}, cookies: { ls_token: 'c' } })).toBe('c');
    expect(extractToken({ headers: { authorization: 'Bearer b' }, cookies: {} })).toBe('b');
    expect(extractToken({ headers: {}, cookies: {} })).toBeUndefined();
  });
});
```

- [ ] **Step 2: 写失败测试 `test/unit/sse.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { SseHub } from '../../src/server/sse.js';
function fakeRes() { const w: string[] = []; return { w, write: (s: string) => { w.push(s); return true; }, end() {} }; }
describe('SseHub', () => {
  it('broadcasts to all and formats frames', () => {
    const hub = new SseHub(); const a = fakeRes(); const b = fakeRes();
    hub.add(a as any); hub.add(b as any);
    hub.broadcast('message', { x: 1 });
    expect(a.w.join('')).toContain('event: message\ndata: {"x":1}\n\n');
    expect(b.w.join('')).toContain('event: message');
  });
  it('stops writing after remove', () => {
    const hub = new SseHub(); const a = fakeRes();
    hub.add(a as any); hub.remove(a as any); hub.broadcast('status', {});
    expect(a.w.join('')).not.toContain('event: status');
  });
});
```

- [ ] **Step 3: 运行确认失败** — FAIL。

- [ ] **Step 4: 写实现**

`src/server/auth.ts`:
```ts
import { timingSafeEqual } from 'node:crypto';
export function checkToken(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
export function extractToken(req: { headers: Record<string, any>; cookies: Record<string, any> }): string | undefined {
  if (req.cookies?.ls_token) return String(req.cookies.ls_token);
  const auth = req.headers?.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return undefined;
}
```

`src/server/sse.ts`:
```ts
interface Sink { write(s: string): unknown; }
export class SseHub {
  private clients = new Set<Sink>();
  add(res: Sink) { this.clients.add(res); }
  remove(res: Sink) { this.clients.delete(res); }
  send(res: Sink, event: string, data: unknown) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  broadcast(event: string, data: unknown) { for (const c of this.clients) this.send(c, event, data); }
  count() { return this.clients.size; }
}
```

- [ ] **Step 5: 运行测试通过** — PASS。
- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(server): auth token check + SSE hub (C1,C3 base)"
```

---

## Task 11: HTTP 路由 + SSE 接线 (STORY C2, C3)

**Files:**
- Create: `src/server/routes.ts`, `src/server/http.ts`
- Test: `test/component/routes.test.ts` (Fastify `.inject()`)

**Interfaces:**
- Produces: `buildHttp(deps: { plane: ControlPlane; token: string; sse: SseHub; webRoot?: string }): FastifyInstance`。
- 路由(SPEC §7)：login/logout/sessions/messages/create/adopt/stream。领域错误经 `error.httpStatus`/`error.code` 映射。

- [ ] **Step 1: 写失败测试 `test/component/routes.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { buildHttp } from '../../src/server/http.js';
import { SseHub } from '../../src/server/sse.js';
import { ControlPlane } from '../../src/domain/control-plane.js';
import { FakeClock, FakeTmux, FakeClaudeHome, InMemoryManagedRegistry } from '../fakes/index.js';

function app() {
  const plane = new ControlPlane({ tmux: new FakeTmux(), home: new FakeClaudeHome(), registry: new InMemoryManagedRegistry(), clock: new FakeClock(), claudeBin: 'claude', tmuxSocket: 's', newSessionId: () => 'id-1234abcd' });
  return { fastify: buildHttp({ plane, token: 'secret', sse: new SseHub() }), plane };
}
describe('routes auth (C1,C2)', () => {
  it('401 without token', async () => {
    const { fastify } = app();
    const r = await fastify.inject({ method: 'GET', url: '/api/sessions' });
    expect(r.statusCode).toBe(401);
  });
  it('login sets cookie then sessions works', async () => {
    const { fastify } = app();
    const login = await fastify.inject({ method: 'POST', url: '/api/login', payload: { token: 'secret' } });
    expect(login.statusCode).toBe(204);
    const cookie = login.headers['set-cookie'];
    const r = await fastify.inject({ method: 'GET', url: '/api/sessions', headers: { cookie: String(cookie).split(';')[0] } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });
  it('bearer token works', async () => {
    const { fastify } = app();
    const r = await fastify.inject({ method: 'GET', url: '/api/sessions', headers: { authorization: 'Bearer secret' } });
    expect(r.statusCode).toBe(200);
  });
});
describe('mutations (C2)', () => {
  it('create returns 201 and message send 202', async () => {
    const { fastify } = app();
    const h = { authorization: 'Bearer secret' };
    const c = await fastify.inject({ method: 'POST', url: '/api/sessions', headers: h, payload: { cwd: '/w' } });
    expect(c.statusCode).toBe(201);
    const id = c.json().sessionId;
    const m = await fastify.inject({ method: 'POST', url: `/api/sessions/${id}/messages`, headers: h, payload: { text: 'hi' } });
    expect(m.statusCode).toBe(202);
  });
  it('maps domain errors (404)', async () => {
    const { fastify } = app();
    const r = await fastify.inject({ method: 'POST', url: '/api/sessions/nope/messages', headers: { authorization: 'Bearer secret' }, payload: { text: 'x' } });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('NOT_FOUND');
  });
});
```

- [ ] **Step 2: 运行确认失败** — FAIL。

- [ ] **Step 3: 写实现**

`src/server/http.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { ControlPlane } from '../domain/control-plane.js';
import type { SseHub } from './sse.js';
import { registerRoutes } from './routes.js';

export function buildHttp(deps: { plane: ControlPlane; token: string; sse: SseHub; webRoot?: string }): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(cookie);
  registerRoutes(app, deps);
  return app;
}
```

`src/server/routes.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import type { ControlPlane } from '../domain/control-plane.js';
import type { SseHub } from './sse.js';
import { checkToken, extractToken } from './auth.js';
import { DomainError } from '../domain/errors.js';

export function registerRoutes(app: FastifyInstance, deps: { plane: ControlPlane; token: string; sse: SseHub }) {
  const { plane, token, sse } = deps;

  app.post('/api/login', async (req, reply) => {
    const body = (req.body ?? {}) as { token?: string };
    if (!checkToken(body.token, token)) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'bad token' } });
    reply.setCookie('ls_token', token, { httpOnly: true, sameSite: 'strict', path: '/' });
    return reply.code(204).send();
  });
  app.post('/api/logout', async (_req, reply) => { reply.clearCookie('ls_token', { path: '/' }); return reply.code(204).send(); });

  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url === '/api/login' || req.url === '/api/logout') return;
    const provided = extractToken({ headers: req.headers as any, cookies: (req as any).cookies ?? {} });
    if (!checkToken(provided, token)) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'unauthorized' } });
  });

  const wrap = (reply: any, fn: () => Promise<any>, ok = 200) =>
    fn().then(v => reply.code(ok).send(v)).catch((e: any) => {
      if (e instanceof DomainError) return reply.code(e.httpStatus).send({ error: { code: e.code, message: e.message } });
      return reply.code(500).send({ error: { code: 'INTERNAL', message: e.message } });
    });

  app.get('/api/sessions', (_req, reply) => wrap(reply, () => plane.listSessions()));
  app.get('/api/sessions/:id', (req, reply) => wrap(reply, () => plane.getSession((req.params as any).id)));
  app.get('/api/sessions/:id/messages', (req, reply) => {
    const q = req.query as any;
    return wrap(reply, () => plane.getMessages((req.params as any).id, { sinceUuid: q.sinceUuid, limit: q.limit ? Number(q.limit) : undefined }));
  });
  app.post('/api/sessions/:id/messages', (req, reply) =>
    wrap(reply, async () => { await plane.sendMessage((req.params as any).id, (req.body as any).text); return { ok: true }; }, 202));
  app.post('/api/sessions', (req, reply) => wrap(reply, () => plane.createSession(req.body as any), 201));
  app.post('/api/sessions/:id/adopt', (req, reply) =>
    wrap(reply, () => plane.adoptSession((req.params as any).id, { force: (req.body as any)?.force }), 200));

  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const sink = { write: (s: string) => reply.raw.write(s) };
    sse.add(sink);
    plane.listSessions().then(list => sse.send(sink, 'status', list));
    const hb = setInterval(() => reply.raw.write(':\n\n'), 15000);
    req.raw.on('close', () => { clearInterval(hb); sse.remove(sink); });
  });
}
```

- [ ] **Step 4: 运行测试通过** — `npx vitest run test/component/routes.test.ts` PASS。
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): REST routes + SSE stream with auth + error mapping (C2,C3)"
```

---

## Task 12: Web UI (STORY C4)

**Files:**
- Create: `web/index.html`, `web/app.js`, `web/style.css`; Modify: `src/server/http.ts`(注册 `@fastify/static` 当 `webRoot` 提供)
- Test: `test/component/static.test.ts`(inject GET `/` 返回 html)

**Interfaces:**
- Consumes: REST + SSE(Task11)。前端：登录(输入 token→POST /api/login)、会话列表(SSE `status`)、会话详情消息流(SSE `message` 过滤 sessionId)、发消息、创建、接管。

- [ ] **Step 1: 写测试 `test/component/static.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { buildHttp } from '../../src/server/http.js';
import { SseHub } from '../../src/server/sse.js';
import { ControlPlane } from '../../src/domain/control-plane.js';
import { FakeClock, FakeTmux, FakeClaudeHome, InMemoryManagedRegistry } from '../fakes/index.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

it('serves index.html at / (C4)', async () => {
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../../web');
  const plane = new ControlPlane({ tmux: new FakeTmux(), home: new FakeClaudeHome(), registry: new InMemoryManagedRegistry(), clock: new FakeClock(), claudeBin: 'c', tmuxSocket: 's', newSessionId: () => 'x' });
  const app = buildHttp({ plane, token: 't', sse: new SseHub(), webRoot });
  const r = await app.inject({ method: 'GET', url: '/' });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Lifestream');
});
```

- [ ] **Step 2: 运行确认失败** — FAIL。

- [ ] **Step 3: 修改 `src/server/http.ts` 注册静态**

```ts
// 在 registerRoutes 之前:
if (deps.webRoot) {
  const fstatic = (await import('@fastify/static')).default;
  app.register(fstatic, { root: deps.webRoot, prefix: '/' });
}
```
> 注：`buildHttp` 改为 `async function buildHttp(...)` 并 `await app.register(...)`；调用方相应 `await`。更新 Task11 测试的 `app()` 为 `async` 并 `await buildHttp(...)`(无 webRoot 时跳过静态)。

- [ ] **Step 4: 写前端 `web/index.html`**(最小可用)

```html
<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Lifestream</title>
<link rel="stylesheet" href="/style.css"></head><body>
<h1>Lifestream</h1>
<div id="login"><input id="token" placeholder="token"><button id="loginBtn">登录</button></div>
<div id="main" hidden>
  <button id="newBtn">新建会话</button>
  <ul id="sessions"></ul>
  <div id="detail"><h2 id="curId"></h2><pre id="messages"></pre>
    <input id="msg" placeholder="发送到该会话"><button id="sendBtn">发送</button>
    <button id="adoptBtn">接管</button></div>
</div>
<script src="/app.js"></script></body></html>
```

- [ ] **Step 5: 写前端 `web/app.js`**(完整逻辑)

```js
const $ = id => document.getElementById(id);
let cur = null;
async function api(path, opts) { return fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...opts }); }
$('loginBtn').onclick = async () => {
  const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ token: $('token').value }) });
  if (r.status === 204) { $('login').hidden = true; $('main').hidden = false; start(); } else alert('token 错误');
};
function renderSessions(list) {
  $('sessions').innerHTML = '';
  for (const s of list) {
    const li = document.createElement('li');
    li.textContent = `${s.status} ${s.controllable ? '●' : '○'} ${s.name || s.sessionId.slice(0,8)} ${s.cwd}`;
    li.onclick = () => { cur = s.sessionId; $('curId').textContent = s.sessionId; loadMsgs(); };
    $('sessions').appendChild(li);
  }
}
async function loadMsgs() {
  const r = await api(`/api/sessions/${cur}/messages`); const evs = await r.json();
  $('messages').textContent = evs.map(e => `[${e.kind}] ${e.text || e.content || e.type || ''}`).join('\n');
}
$('sendBtn').onclick = async () => { await api(`/api/sessions/${cur}/messages`, { method: 'POST', body: JSON.stringify({ text: $('msg').value }) }); $('msg').value = ''; };
$('adoptBtn').onclick = async () => { await api(`/api/sessions/${cur}/adopt`, { method: 'POST', body: '{}' }); };
$('newBtn').onclick = async () => { const cwd = prompt('cwd'); if (cwd) await api('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd }) }); };
function start() {
  const es = new EventSource('/api/stream');
  es.addEventListener('status', e => renderSessions(JSON.parse(e.data)));
  es.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.sessionId === cur) loadMsgs(); });
}
```

- [ ] **Step 6: 写 `web/style.css`**(最小)

```css
body{font-family:system-ui;margin:2rem;max-width:900px}
#sessions li{cursor:pointer;padding:.3rem;border-bottom:1px solid #eee}
#messages{background:#f6f6f6;padding:1rem;height:300px;overflow:auto;white-space:pre-wrap}
```

- [ ] **Step 7: 运行测试通过 + 类型检查** — PASS。
- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(web): minimal monitor+control UI + static serving (C4)"
```

---

## Task 13: MCP 控制面 (STORY D1)

**Files:**
- Create: `src/mcp/control-mcp.ts`
- Test: `test/unit/control-mcp.test.ts`

**Interfaces:**
- Produces: `registerControlTools(server, { plane, mode, pending?, conversationId? })`：
  - `mode: 'direct'` → 注册执行工具 `send_to_session/create_session/adopt_session` + 只读；
  - `mode: 'im'` → 只读 + `propose_send_to_session/propose_create_session/propose_adopt_session`(只写 pending)。
  - `buildMcpServer(deps)` 返回配置好的 `McpServer`。
- 为可测：把每个工具的 handler 导出为纯函数 `tools = makeTools(deps)`，MCP 注册只是薄封装；测试直接调用 handler。

- [ ] **Step 1: 写失败测试 `test/unit/control-mcp.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { makeTools } from '../../src/mcp/control-mcp.js';
import { ControlPlane } from '../../src/domain/control-plane.js';
import { FakeClock, FakeTmux, FakeClaudeHome, InMemoryManagedRegistry, InMemoryPendingStore } from '../fakes/index.js';

function setup(mode: 'direct' | 'im') {
  const plane = new ControlPlane({ tmux: new FakeTmux(), home: new FakeClaudeHome(), registry: new InMemoryManagedRegistry(), clock: new FakeClock(1), claudeBin: 'c', tmuxSocket: 's', newSessionId: () => 'idaaaaaaaa' });
  const pending = new InMemoryPendingStore();
  return { plane, pending, tools: makeTools({ plane, mode, pending, conversationId: 'conv1', clock: new FakeClock(1), newId: () => 'act1' }) };
}
describe('MCP tools', () => {
  it('list_sessions returns array (D1.AC1)', async () => {
    const { tools } = setup('direct');
    expect(await tools.list_sessions({})).toEqual([]);
  });
  it('direct create_session executes (D1.AC2)', async () => {
    const { tools, plane } = setup('direct');
    const s = await tools.create_session({ cwd: '/w' });
    expect(s.controllable).toBe(true);
    expect((await plane.listSessions()).length).toBe(1);
  });
  it('im propose_send only stages, no execution (D1.AC3)', async () => {
    const { tools, pending } = setup('im');
    const r = await tools.propose_send_to_session({ sessionId: 's1', text: 'hi' });
    expect(r.staged).toBe(true);
    const staged = await pending.get('conv1');
    expect(staged[0]).toMatchObject({ kind: 'send', params: { sessionId: 's1', text: 'hi' } });
  });
  it('im has no direct send tool', () => {
    const { tools } = setup('im');
    expect((tools as any).send_to_session).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败** — FAIL。

- [ ] **Step 3: 写实现 `src/mcp/control-mcp.ts`**

```ts
import type { ControlPlane } from '../domain/control-plane.js';
import type { PendingActionStore, Clock } from '../ports/index.js';
import type { PendingAction, PendingActionKind } from '../domain/types.js';
import { describeAction } from '../domain/pending.js';

interface Deps { plane: ControlPlane; mode: 'direct' | 'im'; pending?: PendingActionStore; conversationId?: string; clock: Clock; newId: () => string; }

export function makeTools(d: Deps): Record<string, (args: any) => Promise<any>> {
  const readonly = {
    list_sessions: (_a: any) => d.plane.listSessions(),
    get_messages: (a: any) => d.plane.getMessages(a.sessionId, { limit: a.limit, sinceUuid: a.sinceUuid }),
    get_status: async (a: any) => { const s = await d.plane.getSession(a.sessionId); return { status: s.status, live: s.live, controllable: s.controllable }; },
  };
  if (d.mode === 'direct') {
    return {
      ...readonly,
      send_to_session: async (a: any) => { await d.plane.sendMessage(a.sessionId, a.text); return { ok: true }; },
      create_session: (a: any) => d.plane.createSession(a),
      adopt_session: (a: any) => d.plane.adoptSession(a.sessionId, { force: a.force }),
    };
  }
  const stage = async (kind: PendingActionKind, params: any) => {
    if (!d.pending || !d.conversationId) throw new Error('pending store required in im mode');
    const action: PendingAction = { id: d.newId(), conversationId: d.conversationId, kind, params, description: describeAction(kind, params), createdAt: d.clock.now() };
    const list = await d.pending.get(d.conversationId); list.push(action); await d.pending.set(d.conversationId, list);
    return { staged: true, description: action.description };
  };
  return {
    ...readonly,
    propose_send_to_session: (a: any) => stage('send', { sessionId: a.sessionId, text: a.text }),
    propose_create_session: (a: any) => stage('create', a),
    propose_adopt_session: (a: any) => stage('adopt', { sessionId: a.sessionId, force: a.force }),
  };
}

// MCP 薄封装(集成用；单元测试只测 makeTools)
export async function buildMcpServer(d: Deps) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { z } = await import('zod');
  const server = new McpServer({ name: 'lifestream-control', version: '0.1.0' });
  const tools = makeTools(d);
  const wrap = (fn: (a: any) => Promise<any>) => async (a: any) => ({ content: [{ type: 'text' as const, text: JSON.stringify(await fn(a)) }] });
  server.tool('list_sessions', {}, wrap(tools.list_sessions));
  server.tool('get_messages', { sessionId: z.string(), limit: z.number().optional(), sinceUuid: z.string().optional() }, wrap(tools.get_messages));
  server.tool('get_status', { sessionId: z.string() }, wrap(tools.get_status));
  if (d.mode === 'direct') {
    server.tool('send_to_session', { sessionId: z.string(), text: z.string() }, wrap(tools.send_to_session));
    server.tool('create_session', { cwd: z.string(), name: z.string().optional(), model: z.string().optional(), initialPrompt: z.string().optional() }, wrap(tools.create_session));
    server.tool('adopt_session', { sessionId: z.string(), force: z.boolean().optional() }, wrap(tools.adopt_session));
  } else {
    server.tool('propose_send_to_session', { sessionId: z.string(), text: z.string() }, wrap(tools.propose_send_to_session));
    server.tool('propose_create_session', { cwd: z.string(), name: z.string().optional(), model: z.string().optional(), initialPrompt: z.string().optional() }, wrap(tools.propose_create_session));
    server.tool('propose_adopt_session', { sessionId: z.string(), force: z.boolean().optional() }, wrap(tools.propose_adopt_session));
  }
  return server;
}
```
> 依赖：`npm i zod`(MCP SDK 同伴依赖)。若 SDK 版本 API 略异，`buildMcpServer` 在集成期微调；单元测试只依赖 `makeTools`。

- [ ] **Step 4: 写 `src/domain/pending.ts`**(describeAction 纯函数) + 其测试(合并进本任务或 Task14)

```ts
import type { PendingActionKind } from './types.js';
export function describeAction(kind: PendingActionKind, params: any): string {
  if (kind === 'send') return `向会话 ${params.sessionId} 发送: ${params.text}`;
  if (kind === 'create') return `在 ${params.cwd} 新建会话${params.initialPrompt ? '，首条: ' + params.initialPrompt : ''}`;
  if (kind === 'adopt') return `接管会话 ${params.sessionId}${params.force ? '(强制)' : ''}`;
  return String(kind);
}
```

- [ ] **Step 5: 运行测试通过** — PASS(`npm i zod` 后 typecheck 0)。
- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(mcp): control tools (direct + im propose) + action describer (D1)"
```

---

## Task 14: IM 链接器确认状态机 (STORY E1, E1b)

**Files:**
- Create: `src/im/linker.ts`
- Test: `test/unit/linker.test.ts`

**Interfaces:**
- Produces: `class ImLinker`(SPEC §9)。`tick()` 实现白名单/去重/确认闭环/agent 轮次/回复/异常。
- 执行暂存动作调用 `plane.sendMessage/createSession/adoptSession`。

- [ ] **Step 1: 写失败测试 `test/unit/linker.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { ImLinker } from '../../src/im/linker.js';
import { FakeIm, FakeAgent, FakeClock, InMemoryPendingStore, FakeTmux, FakeClaudeHome, InMemoryManagedRegistry } from '../fakes/index.js';
import { ControlPlane } from '../../src/domain/control-plane.js';

function make(agentResponder?: any) {
  const im = new FakeIm(); const agent = new FakeAgent(); const pending = new InMemoryPendingStore(); const clock = new FakeClock(1000);
  const plane = new ControlPlane({ tmux: new FakeTmux(), home: new FakeClaudeHome(), registry: new InMemoryManagedRegistry(), clock, claudeBin: 'c', tmuxSocket: 's', newSessionId: () => 'id-xxxxxxxx' });
  if (agentResponder) agent.responder = agentResponder;
  const linker = new ImLinker({ im, agent, plane, pending, clock, allowedUids: ['u1'], pollIntervalMs: 100, confirmWords: ['确认', 'yes'], cancelWords: ['取消'], confirmTtlMs: 5000 });
  return { im, agent, pending, plane, clock, linker };
}
const inbound = (o: Partial<any> = {}) => ({ msgId: 'm' + Math.random(), senderUid: 'u1', conversationId: 'c1', text: 'hi', ts: 0, ...o });

describe('whitelist (E1)', () => {
  it('ignores non-whitelisted uid (E1.AC2)', async () => {
    const { im, agent, linker } = make();
    im.inbox.push(inbound({ senderUid: 'evil' }));
    await linker.tick();
    expect(agent.calls).toHaveLength(0);
    expect(im.outbox).toHaveLength(0);
  });
  it('readonly request goes to agent and replies (E1.AC1)', async () => {
    const { im, agent, linker } = make(() => 'here are sessions');
    im.inbox.push(inbound({ text: '列出会话' }));
    await linker.tick();
    expect(agent.calls[0].text).toBe('列出会话');
    expect(im.outbox[0].text).toContain('here are sessions');
  });
  it('dedups same msgId (E1.AC3)', async () => {
    const { im, agent, linker } = make(() => 'x');
    const m = inbound({ msgId: 'same' });
    im.inbox.push(m); await linker.tick();
    im.inbox.push(m); await linker.tick();
    expect(agent.calls).toHaveLength(1);
  });
  it('agent error still replies and continues (E1.AC4)', async () => {
    const { im, linker } = make(() => { throw new Error('boom'); });
    im.inbox.push(inbound());
    await linker.tick();
    expect(im.outbox[0].text).toMatch(/错误|error/i);
  });
});

describe('confirmation (E1b)', () => {
  it('staged action asks for confirm, no execution yet (E1b.AC1)', async () => {
    const { im, pending, linker } = make(async (key: string) => { const l = await pending.get(key); l.push({ id: 'a1', conversationId: key, kind: 'create', params: { cwd: '/w' }, description: '在 /w 新建会话', createdAt: 0 }); await pending.set(key, l); return '我将新建会话'; });
    im.inbox.push(inbound({ text: '新建会话' }));
    await linker.tick();
    expect(im.outbox[0].text).toContain('确认');
    expect((await pending.get('c1'))).toHaveLength(1); // still pending
  });
  it('confirm executes and clears (E1b.AC2)', async () => {
    const { im, pending, plane, linker } = make(() => 'staged');
    await pending.set('c1', [{ id: 'a1', conversationId: 'c1', kind: 'create', params: { cwd: '/w' }, description: 'd', createdAt: 1000 }]);
    im.inbox.push(inbound({ text: '确认' }));
    await linker.tick();
    expect((await plane.listSessions()).length).toBe(1);
    expect(await pending.get('c1')).toHaveLength(0);
  });
  it('cancel drops pending (E1b.AC3)', async () => {
    const { im, pending, linker } = make();
    await pending.set('c1', [{ id: 'a1', conversationId: 'c1', kind: 'create', params: { cwd: '/w' }, description: 'd', createdAt: 1000 }]);
    im.inbox.push(inbound({ text: '取消' }));
    await linker.tick();
    expect(await pending.get('c1')).toHaveLength(0);
    expect(im.outbox[0].text).toContain('取消');
  });
  it('expired pending is discarded (E1b.AC4)', async () => {
    const { im, pending, clock, agent, linker } = make(() => 'x');
    await pending.set('c1', [{ id: 'a1', conversationId: 'c1', kind: 'create', params: { cwd: '/w' }, description: 'd', createdAt: 0 }]);
    clock.t = 999999; // > confirmTtlMs
    im.inbox.push(inbound({ text: '确认' }));
    await linker.tick();
    expect(await pending.get('c1')).toHaveLength(0);
    expect(agent.calls).toHaveLength(0); // treated as expired, not executed
  });
  it('non-confirm reply with pending falls through to new agent turn (E1b.AC5)', async () => {
    const { im, pending, agent, linker } = make(() => 'new answer');
    await pending.set('c1', [{ id: 'a1', conversationId: 'c1', kind: 'create', params: { cwd: '/w' }, description: 'd', createdAt: 1000 }]);
    im.inbox.push(inbound({ text: '换个问题' }));
    await linker.tick();
    expect(await pending.get('c1')).toHaveLength(0); // old cleared
    expect(agent.calls).toHaveLength(1); // processed as new turn
  });
});
```

- [ ] **Step 2: 运行确认失败** — FAIL。

- [ ] **Step 3: 写实现 `src/im/linker.ts`**

```ts
import type { ImAdapter, AgentRunner, PendingActionStore, Clock, InboundMessage } from '../ports/index.js';
import type { ControlPlane } from '../domain/control-plane.js';
import type { PendingAction } from '../domain/types.js';

interface Deps {
  im: ImAdapter; agent: AgentRunner; plane: ControlPlane; pending: PendingActionStore; clock: Clock;
  allowedUids: string[]; pollIntervalMs: number; confirmWords: string[]; cancelWords: string[]; confirmTtlMs: number;
  onAudit?: (m: InboundMessage, allowed: boolean) => void;
}
export class ImLinker {
  private cursor: string | null = null;
  private processed = new Set<string>();
  private timer?: NodeJS.Timeout;
  constructor(private d: Deps) {}

  start() { this.timer = setInterval(() => { void this.tick(); }, this.d.pollIntervalMs); }
  stop() { if (this.timer) clearInterval(this.timer); }

  private norm(s: string) { return s.trim().toLowerCase(); }

  private async execute(a: PendingAction): Promise<string> {
    if (a.kind === 'send') { await this.d.plane.sendMessage(a.params.sessionId as string, a.params.text as string); return `已发送到 ${a.params.sessionId}`; }
    if (a.kind === 'create') { const s = await this.d.plane.createSession(a.params as any); return `已创建会话 ${s.sessionId}`; }
    if (a.kind === 'adopt') { const s = await this.d.plane.adoptSession(a.params.sessionId as string, { force: a.params.force as boolean }); return `已接管 ${s.sessionId}`; }
    return '未知动作';
  }

  async tick(): Promise<void> {
    const { messages, cursor } = await this.d.im.poll(this.cursor);
    this.cursor = cursor;
    for (const m of messages) {
      if (this.processed.has(m.msgId)) continue;
      this.processed.add(m.msgId);
      const allowed = this.d.allowedUids.includes(m.senderUid);
      this.d.onAudit?.(m, allowed);
      if (!allowed) continue;
      try { await this.handleMessage(m); }
      catch (e: any) { await this.d.im.send(m.conversationId, `处理出错: ${e.message}`); }
    }
  }

  private async handleMessage(m: InboundMessage): Promise<void> {
    const pend = await this.d.pending.get(m.conversationId);
    if (pend.length > 0) {
      const expired = this.d.clock.now() - Math.min(...pend.map(a => a.createdAt)) > this.d.confirmTtlMs;
      if (expired) { await this.d.pending.clear(m.conversationId); await this.d.im.send(m.conversationId, '确认已超时，请重新发起。'); return; }
      const t = this.norm(m.text);
      if (this.d.confirmWords.map(w => this.norm(w)).includes(t)) {
        const results: string[] = [];
        for (const a of pend) { try { results.push(await this.execute(a)); } catch (e: any) { results.push(`失败: ${e.message}`); } }
        await this.d.pending.clear(m.conversationId);
        await this.d.im.send(m.conversationId, results.join('\n'));
        return;
      }
      if (this.d.cancelWords.map(w => this.norm(w)).includes(t)) {
        await this.d.pending.clear(m.conversationId);
        await this.d.im.send(m.conversationId, '已取消。');
        return;
      }
      // 非确认/取消 → 丢弃旧动作，作为新一轮处理
      await this.d.pending.clear(m.conversationId);
    }
    const reply = await this.d.agent.handle(m.conversationId, m.text);
    const staged = await this.d.pending.get(m.conversationId);
    if (staged.length > 0) {
      const summary = staged.map(a => `• ${a.description}`).join('\n');
      await this.d.im.send(m.conversationId, `${reply}\n\n待执行:\n${summary}\n\n回复「确认」执行 / 「取消」放弃`);
    } else {
      await this.d.im.send(m.conversationId, reply);
    }
  }
}
```

- [ ] **Step 4: 运行测试通过** — `npx vitest run test/unit/linker.test.ts` PASS。
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(im): linker with whitelist + confirmation state machine (E1,E1b)"
```

---

## Task 15: 钉钉 ImAdapter + AgentRunner 真实现 (STORY E2, E3) — 命令构造可单测

**Files:**
- Create: `src/adapters/im-dingtalk.ts`, `src/adapters/agent-runner.ts`
- Test: `test/unit/dingtalk-cmd.test.ts` (测命令构造纯函数), `test/integration/dingtalk.test.ts`(手动，`--dry-run`)

**Interfaces:**
- Produces:
  - `buildPollArgs(conversationId, cursor)`/`buildSendArgs(conversationId, text)`/`parsePollOutput(json)` 纯函数(可单测)。
  - `class DingTalkIm implements ImAdapter`(execFile `dws`，调用上面纯函数)。
  - `class ClaudeAgentRunner implements AgentRunner`(spawn `claude -p` + mcp-config；每 conversation 一个 session/resume)。

- [ ] **Step 1: 写命令构造测试 `test/unit/dingtalk-cmd.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { buildSendArgs, buildPollArgs, parsePollOutput } from '../../src/adapters/im-dingtalk.js';
describe('dws command builders', () => {
  it('send args include conversation + text + json', () => {
    const a = buildSendArgs('cid', 'hello');
    expect(a).toContain('chat'); expect(a).toContain('message'); expect(a).toContain('send');
    expect(a.join(' ')).toContain('cid'); expect(a.join(' ')).toContain('hello'); expect(a).toContain('-f'); expect(a).toContain('json');
  });
  it('poll args target conversation', () => {
    expect(buildPollArgs('cid', null).join(' ')).toContain('cid');
  });
  it('parsePollOutput maps rows to InboundMessage', () => {
    const rows = JSON.stringify({ items: [{ msgId: '1', senderStaffId: 'u1', text: { content: 'hi' }, createAt: 5 }] });
    const msgs = parsePollOutput(rows, 'cid');
    expect(msgs[0]).toMatchObject({ msgId: '1', senderUid: 'u1', text: 'hi', conversationId: 'cid' });
  });
  it('parsePollOutput tolerates junk', () => {
    expect(parsePollOutput('not json', 'cid')).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败** — FAIL。

- [ ] **Step 3: 写 `src/adapters/im-dingtalk.ts`**

```ts
import { execFile } from 'node:child_process';
import type { ImAdapter, InboundMessage } from '../ports/index.js';
import { UpstreamError } from '../domain/errors.js';

// 命令结构见 SPEC §11（精确 flag 在鉴权恢复后经 --dry-run 校准；此为默认构造）
export function buildSendArgs(conversationId: string, text: string): string[] {
  return ['chat', 'message', 'send', '--conversation', conversationId, '--text', text, '-f', 'json', '-y'];
}
export function buildPollArgs(conversationId: string, _cursor: string | null): string[] {
  return ['chat', 'message', 'list', '--conversation', conversationId, '-f', 'json'];
}
export function parsePollOutput(out: string, conversationId: string): InboundMessage[] {
  let o: any; try { o = JSON.parse(out); } catch { return []; }
  const items = o?.items ?? o?.messages ?? (Array.isArray(o) ? o : []);
  return items.map((it: any) => ({
    msgId: String(it.msgId ?? it.messageId ?? it.id),
    senderUid: String(it.senderStaffId ?? it.senderId ?? it.senderUid ?? ''),
    senderName: it.senderNick ?? it.senderName,
    conversationId,
    text: typeof it.text === 'object' ? (it.text.content ?? '') : String(it.text ?? it.content ?? ''),
    ts: Number(it.createAt ?? it.createTime ?? it.ts ?? 0),
  })).filter((m: InboundMessage) => m.msgId && m.senderUid);
}

export class DingTalkIm implements ImAdapter {
  constructor(private dwsPath: string, private conversationId: string) {}
  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) =>
      execFile(this.dwsPath, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
        err ? reject(new UpstreamError(`dws failed: ${stderr || err.message}`)) : resolve(stdout)));
  }
  async poll(cursor: string | null) {
    const out = await this.run(buildPollArgs(this.conversationId, cursor));
    let msgs = parsePollOutput(out, this.conversationId);
    if (cursor) msgs = msgs.filter(m => String(m.ts) > cursor);
    const newCursor = msgs.length ? String(Math.max(...msgs.map(m => m.ts))) : (cursor ?? '0');
    return { messages: msgs, cursor: newCursor };
  }
  async send(conversationId: string, text: string) { await this.run(buildSendArgs(conversationId, text)); }
}
```

- [ ] **Step 4: 写 `src/adapters/agent-runner.ts`**

```ts
import { execFile } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentRunner } from '../ports/index.js';

const SYS = '你是本机 Claude 会话控制助手。查询用只读工具(list_sessions/get_messages/get_status)。' +
  '任何变更(发指令/新建/接管)必须调用 propose_* 工具，绝不声称已执行；把要做的事讲清楚等用户确认。';

export class ClaudeAgentRunner implements AgentRunner {
  private sessions = new Map<string, string>(); // conversationKey -> claude sessionId
  constructor(private opts: { claudeBin: string; mcpConfigPath: string; stateDir: string }) {}
  handle(key: string, userText: string): Promise<string> {
    const existing = this.sessions.get(key);
    const sid = existing ?? randomUUID();
    if (!existing) this.sessions.set(key, sid);
    const args = ['-p', userText, '--output-format', 'json',
      '--mcp-config', this.opts.mcpConfigPath, '--strict-mcp-config',
      '--append-system-prompt', SYS, '--permission-mode', 'dontAsk',
      existing ? '--resume' : '--session-id', sid];
    return new Promise((resolve) =>
      execFile(this.opts.claudeBin, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve('控制器出错: ' + err.message);
        try { const o = JSON.parse(stdout); resolve(o.result ?? o.text ?? stdout); } catch { resolve(stdout); }
      }));
  }
  static writeMcpConfig(stateDir: string, cliPath: string): string {
    mkdirSync(stateDir, { recursive: true });
    const p = join(stateDir, 'control-mcp.json');
    writeFileSync(p, JSON.stringify({ mcpServers: { lifestream: { command: 'node', args: [cliPath, 'mcp', '--mode', 'im'] } } }, null, 2));
    return p;
  }
}
```
> 注：MCP server 以子进程 `lifestream mcp --mode im` 启动(Task16 在 cli 增加 `mcp` 分支，用 `buildMcpServer` + stdio transport)。conversationId 传递：MCP 子进程按启动时环境 `LIFESTREAM_CONV` 绑定；`ClaudeAgentRunner` 每会话可写独立 mcp-config 注入 `LIFESTREAM_CONV`(集成期细化)。

- [ ] **Step 5: 运行命令构造测试通过** — `npx vitest run test/unit/dingtalk-cmd.test.ts` PASS。集成测试 `dingtalk.test.ts` 标记 `it.skip`(需真实 dws 鉴权)，仅保留一个 `buildSendArgs` 冒烟 + 手动说明。
- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(adapters): dingtalk ImAdapter (dws) + claude AgentRunner (E2,E3)"
```

---

## Task 16: 组合根 + serve/mcp 命令 + 安全审计 (STORY F1, F2)

**Files:**
- Modify: `src/index.ts`(startServer 全实现), `src/cli.ts`(加 `mcp` 分支), `src/config.ts`(token 自动生成)
- Create: `src/audit.ts`; `lifestream.config.example.json`
- Test: `test/component/compose.test.ts`, `test/unit/config-token.test.ts`

**Interfaces:**
- Produces:
  - `startServer(cfg)`: 装配 plane + SseHub + http(webRoot) + 订阅 `plane.on('event')` → SSE broadcast + 起 ControlPlane + (im.enabled 时)起 ImLinker(接 DingTalkIm + ClaudeAgentRunner)。
  - `ensureToken(cfg, file)`: 无 token → 生成 randomBytes hex 写回配置并打印。
  - `Audit(file)`: `record(kind, detail)` 追加行。
  - cli `mcp --mode <direct|im>`: 起 stdio MCP server。

- [ ] **Step 1: 写 `test/unit/config-token.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs'; import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { ensureToken } from '../../src/index.js';
it('generates token when empty (F1.AC2)', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'lsc-')), 'c.json');
  const cfg: any = { web: { host: '127.0.0.1', port: 8787, token: '' } };
  ensureToken(cfg, f);
  expect(cfg.web.token.length).toBeGreaterThanOrEqual(32);
});
```

- [ ] **Step 2: 写 `test/component/compose.test.ts`**(plane 事件→SSE 广播)

```ts
import { describe, it, expect } from 'vitest';
import { SseHub } from '../../src/server/sse.js';
import { ControlPlane } from '../../src/domain/control-plane.js';
import { FakeClock, FakeTmux, FakeClaudeHome, InMemoryManagedRegistry } from '../fakes/index.js';
import { wireSse } from '../../src/index.js';
it('plane events broadcast over SSE (F1)', () => {
  const sse = new SseHub(); const frames: string[] = [];
  sse.add({ write: (s: string) => frames.push(s) } as any);
  const plane = new ControlPlane({ tmux: new FakeTmux(), home: new FakeClaudeHome(), registry: new InMemoryManagedRegistry(), clock: new FakeClock(), claudeBin: 'c', tmuxSocket: 's', newSessionId: () => 'x' });
  wireSse(plane, sse);
  plane.emit('event', { type: 'session.removed', sessionId: 'gone' });
  expect(frames.join('')).toContain('"sessionId":"gone"');
});
```

- [ ] **Step 3: 运行确认失败** — FAIL。

- [ ] **Step 4: 写实现 `src/index.ts`**

```ts
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { Config } from './config.js';
import { buildPlane } from './cli.js';
import { buildHttp } from './server/http.js';
import { SseHub } from './server/sse.js';
import { ImLinker } from './im/linker.js';
import { DingTalkIm } from './adapters/im-dingtalk.js';
import { ClaudeAgentRunner } from './adapters/agent-runner.js';
import { FilePendingStore } from './adapters/pending-store.js';
import { SystemClock } from './adapters/clock.js';
import type { ControlPlane } from './domain/control-plane.js';

export function ensureToken(cfg: Config, file: string): void {
  if (cfg.web.token) return;
  cfg.web.token = randomBytes(24).toString('hex');
  try { writeFileSync(file, JSON.stringify(cfg, null, 2)); } catch { /* ignore */ }
  console.log('[lifestream] generated web token:', cfg.web.token);
}
export function wireSse(plane: ControlPlane, sse: SseHub): void {
  plane.on('event', (e: any) => {
    if (e.type === 'message') sse.broadcast('message', e);
    else sse.broadcast('status', e);
  });
}
export async function startServer(cfg: Config, file = 'lifestream.config.json'): Promise<void> {
  ensureToken(cfg, file);
  const plane = buildPlane(cfg);
  const sse = new SseHub();
  wireSse(plane, sse);
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../web');
  const app = await buildHttp({ plane, token: cfg.web.token, sse, webRoot });
  await plane.start();
  await app.listen({ host: cfg.web.host, port: cfg.web.port });
  console.log(`[lifestream] web on http://${cfg.web.host}:${cfg.web.port}`);
  if (cfg.im.enabled && cfg.im.dwsPath && cfg.im.conversationId) {
    const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
    const mcpConfig = ClaudeAgentRunner.writeMcpConfig(cfg.paths.stateDir, cliPath);
    const linker = new ImLinker({
      im: new DingTalkIm(cfg.im.dwsPath, cfg.im.conversationId),
      agent: new ClaudeAgentRunner({ claudeBin: cfg.claude.bin, mcpConfigPath: mcpConfig, stateDir: cfg.paths.stateDir }),
      plane, pending: new FilePendingStore(join(cfg.paths.stateDir, 'pending.json')), clock: new SystemClock(),
      allowedUids: cfg.im.allowedUids, pollIntervalMs: cfg.im.pollIntervalMs,
      confirmWords: cfg.im.confirmWords, cancelWords: cfg.im.cancelWords, confirmTtlMs: cfg.im.confirmTtlMs,
    });
    linker.start();
    console.log('[lifestream] IM linker started');
  }
}
```

- [ ] **Step 5: `src/cli.ts` 加 `mcp` 分支**

```ts
// 在 main() 的 else-if 链中加:
  } else if (cmd === 'mcp') {
    const mode = (process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'direct') as 'direct' | 'im';
    const { buildMcpServer } = await import('./mcp/control-mcp.js');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const { SystemClock } = await import('./adapters/clock.js');
    const { randomUUID } = await import('node:crypto');
    const { FilePendingStore } = await import('./adapters/pending-store.js');
    const { join } = await import('node:path');
    const conv = process.env.LIFESTREAM_CONV ?? 'cli';
    const server = await buildMcpServer({ plane, mode, pending: new FilePendingStore(join(cfg.paths.stateDir, 'pending.json')), conversationId: conv, clock: new SystemClock(), newId: () => randomUUID() });
    await server.connect(new StdioServerTransport());
```

- [ ] **Step 6: 写 `src/audit.ts` + 接入**(F2)

```ts
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export class Audit {
  constructor(private file: string) {}
  record(kind: string, detail: Record<string, unknown>) {
    try { mkdirSync(dirname(this.file), { recursive: true }); appendFileSync(this.file, JSON.stringify({ ts: Date.now(), kind, ...detail }) + '\n'); } catch { /* ignore */ }
  }
}
```
接入：`ImLinker` 的 `onAudit` 传 `(m, allowed) => audit.record('im.inbound', { uid: m.senderUid, allowed })`；执行动作后 `audit.record('im.execute', {...})`(在 startServer 装配时注入 onAudit)。

- [ ] **Step 7: 写 `lifestream.config.example.json`** (SPEC §12 内容，token 空、conversationId/allowedUids 待填)。

- [ ] **Step 8: 运行全部测试 + 类型检查**

Run: `npm test` → 全绿。
Run: `npm run typecheck` → 0。

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: composition root (serve+mcp), token gen, audit (F1,F2)"
```

---

## Task 17: 端到端 tmux 闭环集成 (STORY B2.AC3 / 验收)

**Files:**
- Create: `test/integration/loop.test.ts`, `test/integration/fake-claude.sh`
- 用一个假 claude 脚本：读 stdin 每行，append 到 `<home>/projects/<enc>/<id>.jsonl` 作为 user 记录。

**Interfaces:**
- Consumes: 真实 `Tmux` + 真实 `ClaudeHome` + `ControlPlane`。

- [ ] **Step 1: 写 `test/integration/fake-claude.sh`**

```bash
#!/usr/bin/env bash
# args: --session-id <id>; env FAKE_HOME, FAKE_PROJ
id=""; while [ $# -gt 0 ]; do case "$1" in --session-id) id="$2"; shift 2;; *) shift;; esac; done
mkdir -p "$FAKE_HOME/projects/$FAKE_PROJ"
f="$FAKE_HOME/projects/$FAKE_PROJ/$id.jsonl"
while IFS= read -r line; do
  printf '{"type":"user","uuid":"%s","message":{"role":"user","content":%s}}\n' "$RANDOM$RANDOM" "$(printf '%s' "$line" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" >> "$f"
done
```

- [ ] **Step 2: 写 `test/integration/loop.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, chmodSync } from 'node:fs';
import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { ControlPlane } from '../../src/domain/control-plane.js';
import { Tmux } from '../../src/adapters/tmux.js';
import { ClaudeHome } from '../../src/adapters/claude-home.js';
import { InMemoryManagedRegistry } from '../fakes/index.js';
import { SystemClock } from '../../src/adapters/clock.js';

const home = mkdtempSync(join(tmpdir(), 'lsloop-'));
const script = join(process.cwd(), 'test/integration/fake-claude.sh');
chmodSync(script, 0o755);
const tmux = new Tmux('ls-loop');
let name = '';
afterAll(async () => { try { await tmux.killSession(name); } catch {} });

it('createSession + sendMessage lands in transcript (B2.AC3)', async () => {
  const plane = new ControlPlane({
    tmux, home: new ClaudeHome(home), registry: new InMemoryManagedRegistry(), clock: new SystemClock(),
    claudeBin: script, tmuxSocket: 'ls-loop', newSessionId: () => '11111111-2222-3333-4444-555555555555',
  });
  process.env.FAKE_HOME = home; process.env.FAKE_PROJ = '-w';
  // 需要脚本看到 env：改用 command 注入 env 前缀
  const s = await plane.createSession({ cwd: home });
  name = 'lifestream-' + s.sessionId.slice(0, 8);
  await plane.sendMessage(s.sessionId, 'hello-loop');
  await new Promise(r => setTimeout(r, 800));
  const msgs = await plane.getMessages(s.sessionId);
  expect(msgs.some(m => m.kind === 'user' && (m as any).text.includes('hello-loop'))).toBe(true);
});
```
> 注：env 传递给 tmux 子进程——`Tmux.newSession` 用 `command` 数组，可在 `createSession` 无法注入 env。集成测试改为让脚本用固定路径：把 `FAKE_HOME/FAKE_PROJ` 通过命令行传入脚本(修改脚本读 `--home/--proj`)，`claudeBin` 设为 `['bash', script, '--home', home, '--proj', '-w']`——但 `ControlPlane.createSession` 目前拼 `[claudeBin,'--session-id',id]`。**解决：** `config.claude.bin` 允许为「可执行 + 前置参数」不便；因此本集成测试直接用底层 `Tmux` + `ClaudeHome` 手工验证 send-keys→transcript（不经 createSession 的命令拼接），保证闭环被覆盖。据此重写测试为：`tmux.newSession(name, home, ['bash', script, '--home', home, '--proj', '-w', '--session-id', id])` → `tmux.sendText` → 读 transcript。

- [ ] **Step 3: 按上注调整脚本参数解析与测试，运行通过**
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test(integration): tmux send-keys -> transcript loop (B2 acceptance)"
```

---

## Self-Review 结论

- **Spec 覆盖**：A1(T2) A2/A3(T3,T5) B1(T7) B2/B3/B4/B5(T5,T17) C1(T10) C2/C3(T11) C4(T12) D1(T13) E1/E1b(T14) E2/E3(T15) F1/F2(T16)。全覆盖。
- **类型一致**：`ControlPlane` 方法名、`makeTools` 键、`ImLinker` deps、ports 接口跨任务一致；`tmuxNameFor` 单一定义。
- **占位**：无 TODO/TBD；集成测试 env 传递的已知难点在 T17 注中给出确定解法（底层适配器直测）。
- **依赖**：新增 `zod`(T13)。其余在 T0。

## Execution Handoff

见会话中说明。
