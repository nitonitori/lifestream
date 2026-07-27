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
