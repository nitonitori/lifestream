import { describe, it, expect } from 'vitest';
import { mkdtempSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ImAdapter, InboundMessage } from '../../src/ports/index.js';
import { ImLinker, ACK_TEXT } from '../../src/im/linker.js';
import { AgentConductor } from '../../src/im/conductor.js';
import { ClaudeAgentRunner } from '../../src/adapters/agent-runner.js';
import { ControlPlane } from '../../src/domain/control-plane.js';
import { SystemClock } from '../../src/adapters/clock.js';
import { FakeTmux, FakeSource, InMemoryManagedRegistry, InMemoryPendingStore } from '../fakes/index.js';

const SENDER = 'sender-allowed';
const DELAY_MS = 400;

// 记录发送时刻，用于证明 ack 是在 agent 轮次“进行中”发出的，而不是最后一起补发。
class TimedIm implements ImAdapter {
  inbox: InboundMessage[] = [];
  outbox: { text: string; t: number }[] = [];
  async poll() { const messages = this.inbox; this.inbox = []; return { messages, cursor: 'c' }; }
  async send(_c: string, text: string) { this.outbox.push({ text, t: Date.now() }); }
}

// 真实 ImLinker + 真实 AgentConductor + 真实 ClaudeAgentRunner（execFile 到假 claude 脚本）。
// 只有 IM 传输被替换掉 —— 传输层的参数构造/解析由 dingtalk-cmd 单测覆盖。
function wire(commandPrefix = '/ai') {
  const stateDir = mkdtempSync(join(tmpdir(), 'lsim-'));
  const claudeBin = join(process.cwd(), 'test/integration/fake-claude-agent.sh');
  chmodSync(claudeBin, 0o755);
  const mcpConfigPath = join(stateDir, 'mcp.json');
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }));

  const im = new TimedIm();
  const pending = new InMemoryPendingStore();
  const clock = new SystemClock();
  const plane = new ControlPlane({
    tmux: new FakeTmux(), home: new FakeSource(), registry: new InMemoryManagedRegistry(),
    clock, claudeBin: 'c', tmuxSocket: 's', newSessionId: () => 'id-xxxxxxxx',
  });
  const agent = new ClaudeAgentRunner({ claudeBin, mcpConfigPath, stateDir });
  const conductor = new AgentConductor({
    agent, plane, pending, clock,
    confirmWords: ['确认'], cancelWords: ['取消'], confirmTtlMs: 300000,
  });
  const linker = new ImLinker({
    im, conductor, pending, conversationKey: 'messenger', allowedSenderIds: [SENDER],
    pollIntervalMs: 1000, commandPrefix, confirmWords: ['确认'], cancelWords: ['取消'],
  });
  return { im, pending, linker, plane };
}

let seq = 0;
const inbound = (text: string): InboundMessage =>
  ({ msgId: 'im' + (++seq), senderUid: SENDER, conversationId: 'conv', text, ts: Date.now() });

describe('IM 端到端（真实 linker + conductor + agent runner，假 claude）', () => {
  it('先发“收到”再发 agent 结果，且 ack 早于 agent 完成', async () => {
    const { im, linker } = wire();
    process.env.FAKE_CLAUDE_DELAY = String(DELAY_MS / 1000);
    im.inbox.push(inbound('/ai 列出会话'));
    await linker.tick();

    expect(im.outbox).toHaveLength(2);
    expect(im.outbox[0].text).toBe(ACK_TEXT);
    // 前缀被剥掉后原文送达 agent
    expect(im.outbox[1].text).toContain('echo:列出会话');
    // ack 与结果之间隔着 agent 的耗时 => ack 确实是即时反馈
    expect(im.outbox[1].t - im.outbox[0].t).toBeGreaterThanOrEqual(DELAY_MS - 50);
  }, 20000);

  it('确认已暂存动作走快路径：直接执行，不发“收到”', async () => {
    const { im, pending, linker, plane } = wire();
    await pending.set('messenger', [{
      id: 'a1', conversationId: 'messenger', kind: 'create',
      params: { cwd: '/w' }, description: '在 /w 新建会话', createdAt: Date.now(),
    }]);
    im.inbox.push(inbound('确认'));
    await linker.tick();

    expect(im.outbox.map(o => o.text)).not.toContain(ACK_TEXT);
    expect(im.outbox).toHaveLength(1);
    expect((await plane.listSessions()).length).toBe(1);
    expect(await pending.get('messenger')).toHaveLength(0);
  }, 20000);

  it('无前缀的普通笔记既不 ack 也不惊动 agent', async () => {
    const { im, linker } = wire();
    im.inbox.push(inbound('买牛奶'));
    await linker.tick();
    expect(im.outbox).toHaveLength(0);
  }, 20000);
});
