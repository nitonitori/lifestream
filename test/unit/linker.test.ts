import { describe, it, expect } from 'vitest';
import { ImLinker } from '../../src/im/linker.js';
import { AgentConductor } from '../../src/im/conductor.js';
import { FakeIm, FakeAgent, FakeClock, InMemoryPendingStore, FakeTmux, FakeSource, InMemoryManagedRegistry } from '../fakes/index.js';
import { ControlPlane } from '../../src/domain/control-plane.js';

const ALLOWED = 'test-allowed-sender';
function make(responder?: (k: string, t: string) => Promise<string> | string, commandPrefix = '') {
  const im = new FakeIm();
  const agent = new FakeAgent();
  const pending = new InMemoryPendingStore();
  const clock = new FakeClock(1000);
  const plane = new ControlPlane({
    tmux: new FakeTmux(), home: new FakeSource(), registry: new InMemoryManagedRegistry(),
    clock, claudeBin: 'c', tmuxSocket: 's', newSessionId: () => 'id-xxxxxxxx',
  });
  if (responder) agent.responder = responder;
  const conductor = new AgentConductor({ agent, plane, pending, clock, confirmWords: ['确认'], cancelWords: ['取消'], confirmTtlMs: 5000 });
  const linker = new ImLinker({
    im, conductor, pending, conversationKey: 'messenger', allowedSenderIds: [ALLOWED], pollIntervalMs: 100,
    commandPrefix, confirmWords: ['确认'], cancelWords: ['取消'],
  });
  return { im, agent, pending, plane, clock, linker };
}
let seq = 0;
const inbound = (o: Partial<any> = {}) => ({ msgId: 'm' + (++seq), senderUid: ALLOWED, conversationId: 'cidX', text: 'hi', ts: 0, ...o });

describe('ImLinker (E1)', () => {
  it('ignores non-allowed sender', async () => {
    const { im, agent, linker } = make();
    im.inbox.push(inbound({ senderUid: 'someone-else' }));
    await linker.tick();
    expect(agent.calls).toHaveLength(0);
    expect(im.outbox).toHaveLength(0);
  });
  it('allowed sender -> conductor -> reply', async () => {
    const { im, agent, linker } = make(() => 'here are sessions');
    im.inbox.push(inbound({ text: '列出会话' }));
    await linker.tick();
    expect(agent.calls[0]).toEqual({ key: 'messenger', text: '列出会话' });
    expect(im.outbox.at(-1)!.text).toContain('here are sessions');
  });
  it('dedups same msgId', async () => {
    const { im, agent, linker } = make(() => 'x');
    const m = inbound({ msgId: 'same' });
    im.inbox.push(m); await linker.tick();
    im.inbox.push(m); await linker.tick();
    expect(agent.calls).toHaveLength(1);
  });
  it('staged action -> confirm prompt sent to IM', async () => {
    const { im, pending, linker } = make(async (k) => {
      const l = await pending.get(k);
      l.push({ id: 'a1', conversationId: k, kind: 'create', params: { cwd: '/w' }, description: '在 /w 新建会话', createdAt: 0 });
      await pending.set(k, l);
      return '我将新建会话';
    });
    im.inbox.push(inbound({ text: '新建' }));
    await linker.tick();
    expect(im.outbox.at(-1)!.text).toContain('确认');
  });
  it('sends a quick ack before the slow agent turn, then the result', async () => {
    const { im, linker } = make(() => 'here are sessions');
    im.inbox.push(inbound({ text: '列出会话' }));
    await linker.tick();
    expect(im.outbox).toHaveLength(2);
    expect(im.outbox[0].text).toContain('收到');
    expect(im.outbox[1].text).toContain('here are sessions');
  });
  it('does not ack fast decision paths (bare 确认 executes directly)', async () => {
    const { im, pending, linker } = make(() => 'x');
    await pending.set('messenger', [{ id: 'a1', conversationId: 'messenger', kind: 'create', params: { cwd: '/w' }, description: 'd', createdAt: 1000 }]);
    im.inbox.push(inbound({ text: '确认' }));
    await linker.tick();
    expect(im.outbox).toHaveLength(1);
    expect(im.outbox[0].text).not.toContain('收到');
  });
  it('agent error still replies and continues', async () => {
    const { im, linker } = make(() => { throw new Error('boom'); });
    im.inbox.push(inbound());
    await linker.tick();
    expect(im.outbox.at(-1)!.text).toMatch(/出错|error/i);
  });
});

describe('ImLinker prefix routing (self-chat)', () => {
  it('with prefix: ignores plain notes (no prefix)', async () => {
    const { im, agent, linker } = make(() => 'x', '/ai');
    im.inbox.push(inbound({ text: '买牛奶' }));
    await linker.tick();
    expect(agent.calls).toHaveLength(0);
    expect(im.outbox).toHaveLength(0);
  });
  it('with prefix: routes prefixed message (stripped)', async () => {
    const { im, agent, linker } = make(() => 'ok', '/ai');
    im.inbox.push(inbound({ text: '/ai 列出会话' }));
    await linker.tick();
    expect(agent.calls[0]).toEqual({ key: 'messenger', text: '列出会话' });
    expect(im.outbox.at(-1)!.text).toContain('ok');
  });
  it('with prefix: bare 确认/取消 routes only while pending exists', async () => {
    const { im, agent, pending, linker } = make(() => 'x', '/ai');
    // 无待确认时，裸「确认」当普通笔记忽略
    im.inbox.push(inbound({ text: '确认' }));
    await linker.tick();
    expect(agent.calls).toHaveLength(0);
    // 有待确认时，裸「确认」直接决策
    await pending.set('messenger', [{ id: 'a1', conversationId: 'messenger', kind: 'create', params: { cwd: '/w' }, description: 'x', createdAt: 0 }]);
    im.inbox.push(inbound({ text: '确认' }));
    await linker.tick();
    expect(im.outbox.length).toBeGreaterThan(0);
  });
  it('with prefix: empty command after prefix sends usage', async () => {
    const { im, linker } = make(() => 'x', '/ai');
    im.inbox.push(inbound({ text: '/ai' }));
    await linker.tick();
    expect(im.outbox[0].text).toContain('用法');
  });
});
